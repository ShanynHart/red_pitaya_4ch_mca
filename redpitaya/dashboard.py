"""Bounded live MCA statistics and a read-only, dependency-free HTTP dashboard."""
from array import array
from bisect import bisect_left
from collections import deque
import csv
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs

WEB = Path(__file__).with_name("web")


class Dashboard:
    def __init__(self, channels, bins=16384, maximum=25.0, recording=None):
        self.lock = threading.Lock()
        self.bins, self.maximum = bins, maximum
        self.started = time.monotonic()
        self.updated = None
        self.phase, self.error = "starting", None
        self.status = {}
        self.recording = str(recording) if recording else None
        self.channels = {c: dict(channel=c, accepted=0, rejected=0, cps=0,
                                 live_fraction=0, histogram=[0] * bins,
                                 underflow=0, overflow=0, history=deque(maxlen=1200))
                         for c in channels}
        self.origin = None
        self.server = None
        # Gain tracking: accepted integrals kept per channel in 10 s slices of FPGA
        # time, so a peak region chosen later can be followed back to the run start.
        self.slice_s, self.max_stored, self.stored = 10.0, 5_000_000, 0
        self.slices = {c: {} for c in channels}
        self.temperatures = {}
        # Pulse shape: sparse counts on a fine (long integral, short/long) grid, re-binned per request.
        self.shape_x, self.shape_y, self.shape_cells = maximum / 65536, 1 / 512, 2_000_000
        self.shapes = {c: {} for c in channels}

    def batch(self, channel, start, end, live, records, reject_flags):
        with self.lock:
            row = self.channels[channel]
            accepted = 0
            kept = array("f")
            for words in records:
                if (words[2] >> 16) & reject_flags:
                    row["rejected"] += 1
                    continue
                accepted += 1
                raw = words[4]
                integral = (raw - (1 << 32) if raw & (1 << 31) else raw) * .008 / 8192
                kept.append(integral)
                if raw and 0 <= integral < self.maximum:
                    short = words[3] - (1 << 32) if words[3] & (1 << 31) else words[3]
                    ratio = short / (raw - (1 << 32) if raw & (1 << 31) else raw)
                    if 0 <= ratio < 2:
                        key = (int(integral / self.shape_x) << 10) | int(ratio / self.shape_y)
                        cells = self.shapes[channel]
                        if key in cells or len(cells) < self.shape_cells:
                            cells[key] = cells.get(key, 0) + 1
                if integral < 0:
                    row["underflow"] += 1
                elif integral >= self.maximum:
                    row["overflow"] += 1
                else:
                    row["histogram"][int(integral / self.maximum * self.bins)] += 1
            row["accepted"] += accepted
            duration = (end - start) / 125000000
            row["cps"] = accepted / duration if duration else 0
            row["live_fraction"] = live / (end - start) if end > start else 0
            if self.origin is None:
                self.origin = start
            if kept:
                index = int((end - self.origin) / 125000000 / self.slice_s)
                entry = self.slices[channel].setdefault(index, {"values": array("f"), "sums": None})
                entry["values"].extend(kept)
                entry["sums"] = None
                self.stored += len(kept)
                while self.stored > self.max_stored:
                    oldest = min(min(per) for per in self.slices.values() if per)
                    for per in self.slices.values():
                        self.stored -= len(per.pop(oldest, {"values": ()})["values"])
            row["history"].append([(end - self.origin) / 125000000, row["cps"]])

    def set_channels(self, channels):
        """Replay gets its active input set from metadata, not CLI defaults."""
        with self.lock:
            if set(channels) == set(self.channels):
                return
            self.channels = {c: dict(channel=c, accepted=0, rejected=0, cps=0,
                                     live_fraction=0, histogram=[0] * self.bins,
                                     underflow=0, overflow=0, history=deque(maxlen=1200))
                             for c in channels}
            self.slices, self.temperatures, self.stored = {c: {} for c in channels}, {}, 0
            self.shapes = {c: {} for c in channels}

    def set_status(self, status):
        with self.lock:
            self.status = status
            self.updated = time.monotonic()
            reading = (status.get("temperature") or {}).get("local_c")
            if reading is not None and self.origin is not None and "clock_ticks" in status:
                index = int((status["clock_ticks"] - self.origin) / 125000000 / self.slice_s)
                total = self.temperatures.setdefault(index, [0.0, 0])
                total[0] += reading
                total[1] += 1
            self.phase = "complete" if status["type"] == "summary" else "running"

    def fail(self, error):
        with self.lock:
            self.phase, self.error = "error", str(error)

    def snapshot(self):
        with self.lock:
            now = time.monotonic()
            return dict(phase=self.phase, error=self.error, recording=self.recording,
                        uptime_s=now - self.started,
                        age_s=None if self.updated is None else now - self.updated,
                        histogram_max=self.maximum, histogram_bins=self.bins,
                        status=self.status,
                        channels=[dict(row, history=list(row["history"]),
                                       histogram=list(row["histogram"]))
                                  for row in self.channels.values()])

    @staticmethod
    def _sums(entry, latest):
        """Sorted integrals with running sums, so any region is summed by two lookups."""
        if entry["sums"] is not None:
            return entry["sums"]
        values = sorted(entry["values"])
        first, second = [0.0], [0.0]
        for value in values:
            first.append(first[-1] + value)
            second.append(second[-1] + value * value)
        sums = (values, first, second)
        if not latest:  # the slice still filling is recomputed on each request
            entry["sums"] = sums
        return sums

    def gain(self, low, high, merge=1):
        """Peak centroid in [low, high] V us per time bin of merge slices, with temperature.

        The window keeps its width but is re-centred on the centroid (three passes),
        so a peak that drifts toward a region edge is not biased by the fixed limits.
        """
        with self.lock:
            half = (high - low) / 2
            newest = max((max(per) for per in self.slices.values() if per), default=0)
            channels = []
            for channel, per in self.slices.items():
                rows, followed = [], None
                for group in sorted({index // merge for index in per}):
                    members = [self._sums(per[i], i == newest)
                               for i in range(group * merge, (group + 1) * merge) if i in per]
                    # Start from the previous time bin's centroid so a slow drift is followed.
                    centre, count, mean, spread = (low + high) / 2 if followed is None else followed, 0, None, None
                    for _ in range(3):
                        count = total = squares = 0
                        for values, first, second in members:
                            a, b = bisect_left(values, centre - half), bisect_left(values, centre + half)
                            count += b - a
                            total += first[b] - first[a]
                            squares += second[b] - second[a]
                        if not count:
                            break
                        mean = total / count
                        spread = math.sqrt(max(0.0, squares / count - mean * mean))
                        centre = mean
                    followed = mean if count else followed
                    readings = [self.temperatures[i] for i in range(group * merge, (group + 1) * merge)
                                if i in self.temperatures]
                    samples = sum(r[1] for r in readings)
                    rows.append(dict(time_s=(group + .5) * merge * self.slice_s, counts=count, centroid=mean,
                                     error=spread / math.sqrt(count) if count > 1 else None,
                                     temperature_c=sum(r[0] for r in readings) / samples if samples else None))
                channels.append(dict(channel=channel, rows=rows))
            return dict(low=low, high=high, bin_s=merge * self.slice_s, channels=channels)

    def shape(self, low, high, ratio_low, ratio_high, columns=240, rows=120):
        """Counts on a columns x rows grid of long integral against short/long ratio."""
        with self.lock:
            channels = []
            for channel, cells in self.shapes.items():
                grid = {}
                for key, count in cells.items():
                    x, y = (key >> 10) * self.shape_x, (key & 1023) * self.shape_y
                    if low <= x < high and ratio_low <= y < ratio_high:
                        cell = (int((x - low) / (high - low) * columns), int((y - ratio_low) / (ratio_high - ratio_low) * rows))
                        grid[cell] = grid.get(cell, 0) + count
                channels.append(dict(channel=channel, cells=[[x, y, n] for (x, y), n in grid.items()]))
            return dict(low=low, high=high, ratio_low=ratio_low, ratio_high=ratio_high,
                        columns=columns, rows=rows, channels=channels)

    def start(self, host, port):
        dashboard = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                route, _, query = self.path.partition("?")
                extra = {}
                if route in ("/api/gain", "/api/gain.csv"):
                    try:
                        asked = parse_qs(query)
                        low, high = float(asked["low"][0]), float(asked["high"][0])
                        merge = int(asked.get("merge", ["1"])[0])
                        if not (math.isfinite(low) and math.isfinite(high) and low < high and 1 <= merge <= 8640):
                            raise ValueError
                    except (KeyError, ValueError):
                        self.send_error(400)
                        return
                if route == "/favicon.ico":
                    self.send_response(204)
                    self.end_headers()
                    return
                if route == "/api/state":
                    body = json.dumps(dashboard.snapshot(), allow_nan=False).encode()
                    mime = "application/json"
                elif route == "/api/shape":
                    try:
                        asked = parse_qs(query)
                        box = [float(asked[name][0]) for name in ("low", "high", "ratio_low", "ratio_high")]
                        if not (all(math.isfinite(v) for v in box) and box[0] < box[1] and box[2] < box[3]):
                            raise ValueError
                    except (KeyError, ValueError):
                        self.send_error(400)
                        return
                    body = json.dumps(dashboard.shape(*box), allow_nan=False).encode()
                    mime = "application/json"
                elif route == "/api/gain":
                    body = json.dumps(dashboard.gain(low, high, merge), allow_nan=False).encode()
                    mime = "application/json"
                elif route == "/api/gain.csv":
                    output = io.StringIO()
                    writer = csv.writer(output)
                    writer.writerow(["channel", "time_s", "counts", "centroid_v_us", "centroid_error_v_us", "temperature_c"])
                    for row in dashboard.gain(low, high, merge)["channels"]:
                        for point in row["rows"]:
                            writer.writerow([row["channel"], point["time_s"], point["counts"], point["centroid"],
                                             point["error"], point["temperature_c"]])
                    body, mime = output.getvalue().encode(), "text/csv"
                    extra["Content-Disposition"] = 'attachment; filename="mca-gain.csv"'
                elif route == "/api/spectrum.csv":
                    state = dashboard.snapshot()
                    output = io.StringIO()
                    writer = csv.writer(output)
                    writer.writerow(["channel", "low_v_us", "high_v_us", "accepted_count"])
                    width = state["histogram_max"] / state["histogram_bins"]
                    for row in state["channels"]:
                        for i, count in enumerate(row["histogram"]):
                            writer.writerow([row["channel"], i * width, (i + 1) * width, count])
                    body, mime = output.getvalue().encode(), "text/csv"
                    extra["Content-Disposition"] = 'attachment; filename="mca-spectrum.csv"'
                elif route in ("/", "/app.js", "/style.css"):
                    filename, mime = {"/": ("index.html", "text/html"),
                                      "/app.js": ("app.js", "text/javascript"),
                                      "/style.css": ("style.css", "text/css")}[route]
                    body = (WEB / filename).read_bytes()
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", mime + "; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'")
                for name, value in extra.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer((host, port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self.server.server_address[1]

    def close(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
