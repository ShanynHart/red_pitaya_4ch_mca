#!/usr/bin/env python3
"""List-mode readout for this project's MCA4 bitstream. Run on the Red Pitaya.

Requires root and a successfully loaded custom bitstream. It is deliberately
not deployed/enabled automatically and cannot work with the stock image.
"""
import argparse
import ctypes
import fcntl
import json
import math
import mmap
import os
import signal
import sys
import time
from wire import MAGIC4, EVENT4, frame, json_frame
import tmp451

BASE = 0x40700000
FLAGS = {0: "near_full_scale", 1: "possible_pileup", 2: "invalid_cfd",
         3: "tail_above_threshold", 4: "early_peak_window_too_short"}


def signed(value, bits):
    return value - (1 << bits) if value & (1 << (bits - 1)) else value


def decode(words):
    tick = words[0] | (words[1] << 32)
    frac = words[2] & 0xffff
    flags = words[2] >> 16
    short = signed(words[3], 32)
    long = signed(words[4], 32)
    return {"type": "event", "channel": words[8] if len(words) > 8 else 1, "sequence": words[6], "timestamp_ticks": tick,
            "timestamp_fraction_65536": frac, "timestamp_ns": (tick + frac / 65536) * 8,
            "short_adc_samples": short, "long_adc_samples": long,
            "short_nominal_v_us": short * .008 / 8192,
            "long_nominal_v_us": long * .008 / 8192,
            "short_over_long": short / long if long else None,
            "baseline_adc_counts": signed(words[5] & 0xffff, 16),
            "peak_adc_counts": words[5] >> 16,
            "short_samples": words[7] & 0xffff, "long_samples": words[7] >> 16,
            "flags_bits": flags, "flags": [name for bit, name in FLAGS.items() if flags & (1 << bit)],
            "accepted": flags == 0}


class Registers:
    def __init__(self, path="/dev/mem"):
        self.fd = os.open(path, os.O_RDWR | os.O_SYNC)
        self.mem = mmap.mmap(self.fd, 0x5000, flags=mmap.MAP_SHARED,
                             prot=mmap.PROT_READ | mmap.PROT_WRITE, offset=BASE)

    def read(self, offset):
        # An aligned volatile 32-bit access is needed for this peripheral bus.
        return ctypes.c_uint32.from_buffer(self.mem, offset).value

    def write(self, offset, value):
        ctypes.c_uint32.from_buffer(self.mem, offset).value = value

    def close(self):
        self.mem.close()
        os.close(self.fd)

    def snapshot(self, channel):
        base = channel * 4096
        self.write(base + 0x40, 1)
        def pair(offset):
            return self.read(base + offset) | (self.read(base + offset + 4) << 32)
        return {"clock_ticks": pair(0x44), "enabled_ticks": pair(0x4c),
                "live_ticks": pair(0x54), "triggered_events": self.read(base + 0x5c),
                "fifo_dropped_events": self.read(base + 0x60), "fifo_stored_events": self.read(base + 0x64)}


def parse_channels(value):
    try:
        values = [int(v) for v in value.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError("Channels must be a comma-separated list of 1..4")
    if not values or len(set(values)) != len(values) or any(v not in range(1, 5) for v in values):
        raise argparse.ArgumentTypeError("Select unique channels from 1..4")
    return sorted(values)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channels", type=parse_channels, default=[1], help="Active inputs, e.g. 1,2,3,4")
    parser.add_argument("--seconds", type=float, default=30, help="0 runs until SIGINT/SIGTERM")
    parser.add_argument("--short-us", type=float, default=2)
    parser.add_argument("--long-us", type=float, default=25)
    parser.add_argument("--threshold-v", type=float, default=.020)
    parser.add_argument("--fraction", type=float, default=.30)
    parser.add_argument("--baseline-counts", type=int, help="Optional fixed signed ADC baseline")
    parser.add_argument("--format", choices=("binary", "jsonl"), default="binary")
    parser.add_argument("--batch-ms", type=float, default=100,
                        help="Target batching interval; FIFO is still drained every ~1 ms")
    parser.add_argument("--output", help="New output file; default standard output")
    parser.add_argument("--temperature-bus", type=int, default=0, help="I2C bus of the detector TMP451; -1 disables")
    parser.add_argument("--temperature-address", type=lambda s: int(s, 0), default=0x4c)
    parser.add_argument("--custom-bitstream-loaded", action="store_true", required=True,
                        help="Explicitly confirm that this project's custom MCA4 image is loaded")
    args = parser.parse_args()
    for x in (args.seconds, args.short_us, args.long_us, args.threshold_v, args.fraction, args.batch_ms):
        if not math.isfinite(x):
            parser.error("Settings must be finite")
    short, long = round(args.short_us * 125), round(args.long_us * 125)
    threshold, fraction = round(args.threshold_v * 8192), round(args.fraction * 256)
    if not (64 < short <= long <= 16384 and long >= 672 and 0 < threshold <= 4095 and 0 < fraction < 256):
        parser.error("Gate, threshold or fraction outside hardware range")
    if args.seconds < 0 or (args.baseline_counts is not None and not -8192 <= args.baseline_counts <= 8191):
        parser.error("Invalid duration or baseline")
    if not 1 <= args.batch_ms <= 1000:
        parser.error("Batch interval must be 1..1000 ms")
    lock = open("/run/redpitaya-fpga-mca.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    binary = args.format == "binary"
    output = open(args.output, "xb" if binary else "x") if args.output else (sys.stdout.buffer if binary else sys.stdout)
    regs = None
    verified = False
    count = 0
    counts = {c: 0 for c in args.channels}
    aborted = False
    error = None
    stopping = False
    previous_handlers = {}
    def stop(signum, frame):
        nonlocal stopping
        stopping = True
    for sig in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[sig] = signal.signal(sig, stop)
    pending = bytearray()
    thermometer = None if args.temperature_bus < 0 else tmp451.Monitor(args.temperature_bus, args.temperature_address)
    if binary:
        output.write(MAGIC4)
    def emit(row):
        if binary:
            kind = {"metadata": b"META", "status": b"STAT", "summary": b"DONE"}[row["type"]]
            output.write(json_frame(kind, row))
        else:
            output.write(json.dumps(row, allow_nan=False) + "\n")
    def flush_events():
        if pending:
            output.write(frame(b"EVN4", pending))
            pending.clear()
        output.flush()
    def drain(limit=128):
        nonlocal count
        # Fairly drain each independent FIFO; no channel can monopolize readout.
        for channel in args.channels:
            base = channel * 4096
            for _ in range(limit):
                if not regs.read(base + 0x0c) & 2:
                    break
                words = [regs.read(base + 0x100 + 4 * i) for i in range(8)] + [channel]
                regs.write(base + 0x20, 1)
                if binary:
                    pending.extend(EVENT4.pack(*words))
                    if len(pending) >= 4096 * EVENT4.size:
                        flush_events()
                else:
                    output.write(json.dumps(decode(words), allow_nan=False) + "\n")
                count += 1
                counts[channel] += 1
    def snapshot():
        channels = []
        for c in args.channels:
            row = regs.snapshot(c)
            v = regs.read(c * 4096 + 0x24)
            row.update(channel=c, read_events=counts[c],
                       baseline_adc_counts=signed(regs.read(c * 4096 + 0x28) & 0xffff, 16),
                       mean_absolute_noise_adc_counts=v & 0xffff,
                       effective_threshold_adc_counts=v >> 16)
            channels.append(row)
        regs.write(0x40, 1)
        clock = regs.read(0x44) | (regs.read(0x48) << 32)
        return dict(clock_ticks=clock, channels=channels,
                    **{key: sum(r[key] for r in channels) for key in
                       ("triggered_events", "fifo_dropped_events", "fifo_stored_events")})
    try:
        regs = Registers()
        if regs.read(0) != 0x4d434134 or regs.read(4) != 0x20000:
            raise RuntimeError("Custom MCA4 ABI 2.0 is not loaded")
        verified = True
        for c in range(1, 5):
            base = c * 4096
            regs.write(base + 8, 2)
            regs.write(base + 0x10, short)
            regs.write(base + 0x14, long)
            regs.write(base + 0x18, threshold)
            regs.write(base + 0x1c, fraction)
            regs.write(base + 0x2c, 0 if args.baseline_counts is None else (1 << 16) | (args.baseline_counts & 0xffff))
        start = snapshot()
        emit({"type": "metadata", "mode": "fpga_multichannel_mca", "abi": "2.0", "clock_hz": 125000000,
              "active_channels": args.channels, "start_clock_ticks": start["clock_ticks"],
              "channel_start_clocks": {str(r["channel"]): r["clock_ticks"] for r in start["channels"]},
              "short_samples": short, "long_samples": long, "pretrigger_samples": 64,
              "threshold_floor_adc_counts": threshold, "noise_threshold": "8 times tracked mean absolute residual",
              "fraction_256": fraction, "nominal_volts_per_count": 1 / 8192,
              "calibration": "nominal LV; no factory or energy calibration applied",
              "timestamp": "independent CFD; shared free-running 125 MHz reference",
              "timing_domains": [[1, 2], [3, 4]],
              "cross_pair_timing": "Gray-synchronized reference; fixed offsets and cross-pair sample phase require measurement",
              "wall_start_unix_s": time.time(), "inflight_limit_per_channel": 1,
              "wire_format": "rpmca-2" if binary else "jsonl", "event_bytes": 36, "batch_ms": args.batch_ms,
              "missed_pulses": "not counted; per-channel live ticks exclude busy, warmup and rearming"})
        output.flush()
        for c in args.channels:
            regs.write(c * 4096 + 8, 1)
        deadline = time.monotonic() + args.seconds if args.seconds else float("inf")
        next_batch = time.monotonic() + args.batch_ms / 1000
        while not stopping and time.monotonic() < deadline:
            drain()
            now = time.monotonic()
            if now >= next_batch:
                flush_events()
                status = snapshot()
                status.update(type="status", read_events=count)
                if thermometer:
                    # Read every 2 s; each status row carries the latest value beside its FPGA clock.
                    status["temperature"] = thermometer.poll(now)
                emit(status)
                output.flush()
                next_batch += args.batch_ms / 1000
            time.sleep(.001)
        # Complete the current gate if possible; a concurrent new trigger may still
        # race the disable. Preserve that possibility in the summary.
        end = time.monotonic() + .1
        while any(regs.read(c * 4096 + 0x0c) & 8 for c in args.channels) and time.monotonic() < end:
            drain()
        aborted = any(bool(regs.read(c * 4096 + 0x0c) & 8) for c in args.channels)
    except BaseException as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        if regs is not None:
            # Only write shutdown registers after the ID check has succeeded.
            if verified:
                aborted = aborted or any(bool(regs.read(c * 4096 + 0x0c) & 8) for c in args.channels)
                for c in range(1, 5):
                    regs.write(c * 4096 + 8, 0)
                drain()
                flush_events()
                summary = snapshot()
                summary.update(type="summary", read_events=count, run_error=error,
                               inflight_at_stop=aborted, stop_can_abort_new_trigger=True)
                emit(summary)
            regs.close()
        output.flush()
        if args.output:
            output.close()
        lock.close()
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
    if error:
        raise SystemExit(error)


if __name__ == "__main__":
    main()
