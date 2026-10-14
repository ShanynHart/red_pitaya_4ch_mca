#!/usr/bin/env python3
"""Red Pitaya binary SSH list mode -> ROS 2 batches, gross counts and status."""
import argparse
import json
import math
import os
from pathlib import Path
import selectors
import shlex
import signal
import struct
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / "board"))
from wire import Decoder, EVENT, EVENT4
from readout import parse_channels

# UInt8MultiArray payload: magic, end/start FPGA tick, Radxa epoch ns,
# interval FPGA live ticks, number of events, quality-rejection bitmask.
BATCH_MAGIC = b"RPMROS01"
BATCH = struct.Struct("<8sQQqQII")
BATCH4_MAGIC = b"RPMROS02"
# V2 adds active mask, reserved zero, and four per-channel live-tick deltas.
BATCH4_EXTRA = struct.Struct("<II4Q")


class Session:
    def __init__(self, reject_flags=31):
        self.decoder = Decoder(decode_events=False)
        self.pending = bytearray()
        self.epoch_ns = None
        self.last_clock = 0
        self.last_live = 0
        self.last_sequence = 0
        self.sequence_gaps = 0
        self.accepted = 0
        self.rejected = 0
        self.reject_flags = reject_flags
        self.metadata = None
        self.active_channels = [1]
        self.last_sequences = {}
        self.channel_clocks = {}
        self.channel_live = {}
        self.channel_accepted = {}
        self.channel_rejected = {}

    def feed(self, data, now_ns):
        for row in self.decoder.feed(data):
            kind = row["type"]
            if kind == "metadata":
                if row.get("clock_hz") != 125000000:
                    raise ValueError("Expected 125 MHz MCA clock")
                self.metadata = row
                if self.decoder.version == 2:
                    self.active_channels = row["active_channels"]
                    if not self.active_channels or len(set(self.active_channels)) != len(self.active_channels) or any(c not in range(1,5) for c in self.active_channels):
                        raise ValueError("Invalid active-channel metadata")
                    self.last_clock = row["start_clock_ticks"]
                    self.channel_clocks = {c: row["channel_start_clocks"][str(c)] for c in self.active_channels}
                    self.channel_live = {c: 0 for c in self.active_channels}
                    self.channel_accepted = {c: 0 for c in self.active_channels}
                    self.channel_rejected = {c: 0 for c in self.active_channels}
            elif kind == "event":
                words = row["words"]
                if (words[7] & 65535, words[7] >> 16) != (self.metadata["short_samples"], self.metadata["long_samples"]):
                    raise ValueError("Event gate configuration changed within the run")
                channel = row.get("channel", 1)
                if channel not in self.active_channels:
                    raise ValueError("Event from an inactive channel")
                expected = (self.last_sequences.get(channel, 0) + 1) & 0xffffffff
                if words[6] != expected:
                    self.sequence_gaps += (words[6] - expected) & 0xffffffff
                self.last_sequence = words[6]
                self.last_sequences[channel] = words[6]
                self.pending.extend((EVENT if self.decoder.version == 1 else EVENT4).pack(*words))
                if len(self.pending) > 65536 * EVENT.size:
                    raise ValueError("Too many events without a status boundary")
            elif self.decoder.version == 2:
                yield from self.multichannel_boundary(row, now_ns)
            else:
                clock, live = row["clock_ticks"], row["live_ticks"]
                if clock < self.last_clock or live < self.last_live or live - self.last_live > clock - self.last_clock:
                    raise ValueError("Non-monotonic or invalid FPGA exposure counters")
                if self.epoch_ns is None:
                    # Anchor once to the Radxa ROS clock; preserve FPGA timing thereafter.
                    self.epoch_ns = now_ns - clock * 8
                count = len(self.pending) // EVENT.size
                accepted = sum(not ((w[2] >> 16) & self.reject_flags) for w in EVENT.iter_unpack(self.pending))
                self.accepted += accepted
                self.rejected += count - accepted
                packet = BATCH.pack(BATCH_MAGIC, clock, self.last_clock, self.epoch_ns,
                                    live - self.last_live, count, self.reject_flags) + self.pending
                if clock > self.last_clock:
                    yield "batch", bytes(packet), accepted
                elif count:
                    raise ValueError("Events without a positive exposure interval")
                self.pending.clear()
                status = dict(row, detector="redpitaya", energy_calibrated=False,
                              short_us=self.metadata["short_samples"] * .008,
                              long_us=self.metadata["long_samples"] * .008,
                              accepted_events=self.accepted, rejected_events=self.rejected,
                              sequence_gaps=self.sequence_gaps, reject_flags=self.reject_flags,
                              epoch_ns=self.epoch_ns,
                              timestamp_alignment="first status arrival on Radxa; network offset/drift not calibrated",
                              exposure="FPGA live ticks; overlapping pulses are not counted",
                              arrival_offset_ns=now_ns - (self.epoch_ns + clock * 8))
                yield "status", status, None
                self.last_clock, self.last_live = clock, live

    def multichannel_boundary(self, row, now_ns):
        clock = row["clock_ticks"]
        if clock < self.last_clock:
            raise ValueError("Common clock regressed")
        if self.epoch_ns is None:
            self.epoch_ns = now_ns - clock * 8
        raw_by_channel = {c: bytearray() for c in self.active_channels}
        counts = {c: 0 for c in self.active_channels}
        for words in EVENT4.iter_unpack(self.pending):
            c = words[8]
            raw_by_channel[c].extend(EVENT.pack(*words[:8]))
            counts[c] += not ((words[2] >> 16) & self.reject_flags)
        counters = {r["channel"]: r for r in row["channels"]}
        if set(counters) != set(self.active_channels) or len(counters) != len(row["channels"]):
            raise ValueError("Status channel set changed")
        live_deltas = [0]*4
        fractions = []
        accepted = sum(counts.values())
        event_count = len(self.pending)//EVENT4.size
        for c in self.active_channels:
            end, live = counters[c]["clock_ticks"], counters[c]["live_ticks"]
            start, prev_live = self.channel_clocks[c], self.channel_live[c]
            span, delta = end-start, live-prev_live
            if span < 0 or delta < 0 or delta > span + (8 if c > 2 else 0):
                raise ValueError("Invalid per-channel exposure")
            if span == 0 and raw_by_channel[c]:
                raise ValueError("Events without a channel interval")
            if any((w[0] | (w[1]<<32)) > end for w in EVENT.iter_unpack(raw_by_channel[c])):
                raise ValueError("Event after its channel snapshot")
            # A Gray-clock boundary can differ by a few native ADC23 cycles.
            # Preserve native counters in status; bound projected ROS exposure.
            delta = min(delta,span)
            live_deltas[c-1] = delta
            fractions.append(delta/span if span else 0)
            if span:
                packet = BATCH.pack(BATCH_MAGIC, end, start, self.epoch_ns, delta,
                                    len(raw_by_channel[c])//EVENT.size, self.reject_flags)+raw_by_channel[c]
                yield "channel_batch", (c,bytes(packet)), counts[c]
            self.channel_accepted[c] += counts[c]
            self.channel_rejected[c] += len(raw_by_channel[c])//EVENT.size-counts[c]
            self.channel_clocks[c], self.channel_live[c] = end, live
        # Combined counts use the mean active-channel live fraction, projected
        # onto the common batch interval. Individual exposures remain exact.
        aggregate_live = min(clock-self.last_clock, round((clock-self.last_clock)*sum(fractions)/len(fractions)))
        if clock > self.last_clock:
            header = BATCH.pack(BATCH4_MAGIC, clock, self.last_clock, self.epoch_ns,
                                aggregate_live, event_count, self.reject_flags)
            extra = BATCH4_EXTRA.pack(sum(1<<(c-1) for c in self.active_channels),0,*live_deltas)
            yield "batch", header+extra+bytes(self.pending), accepted
        elif event_count:
            raise ValueError("Events without a common interval")
        self.accepted += accepted
        self.rejected += event_count-accepted
        self.pending.clear()
        status = dict(row, detector="redpitaya", energy_calibrated=False,
                      short_us=self.metadata["short_samples"]*.008,
                      long_us=self.metadata["long_samples"]*.008,
                      accepted_events=self.accepted, rejected_events=self.rejected,
                      accepted_by_channel=self.channel_accepted.copy(), rejected_by_channel=self.channel_rejected.copy(),
                      active_channels=self.active_channels, sequence_gaps=self.sequence_gaps,
                      reject_flags=self.reject_flags, epoch_ns=self.epoch_ns,
                      exposure="Per-channel FPGA live ticks; combined rate uses mean live fraction",
                      timestamp_alignment="shared FPGA reference; ADC pair offsets and sample phase unmeasured",
                      arrival_offset_ns=now_ns-(self.epoch_ns+clock*8))
        yield "status", status, None
        self.last_clock = clock


def pace_replay(target, is_stopping):
    while not is_stopping():
        remaining = target - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(.01, remaining))


def update_dashboard(dashboard, session, kind, value):
    """Consume validated batches; V2 aggregate packets must not double-count inputs."""
    dashboard.set_channels(session.active_channels)
    if kind == "channel_batch" or (kind == "batch" and session.decoder.version == 1):
        channel, packet = value if kind == "channel_batch" else (1, value)
        _, end, start, _, live, _, reject = BATCH.unpack_from(packet)
        dashboard.batch(channel, start, end, live, EVENT.iter_unpack(packet[BATCH.size:]), reject)
    elif kind == "status":
        dashboard.set_status(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channels", type=parse_channels, default=parse_channels(os.getenv("REDPITAYA_CHANNELS", "1")))
    parser.add_argument("--host", default=os.getenv("REDPITAYA_HOST", "rp-f0d343.local"))
    parser.add_argument("--port", type=int, default=int(os.getenv("REDPITAYA_PORT", "22")))
    parser.add_argument("--host-key-alias", default=os.getenv("REDPITAYA_HOST_KEY_ALIAS", "rp-f0d343.local"))
    parser.add_argument("--identity", default="/auth/id_ed25519")
    parser.add_argument("--known-hosts", default="/auth/known_hosts")
    parser.add_argument("--short-us", type=float, default=float(os.getenv("REDPITAYA_SHORT_US", "2")))
    parser.add_argument("--long-us", type=float, default=float(os.getenv("REDPITAYA_LONG_US", "25")))
    parser.add_argument("--seconds", type=float, default=0)
    parser.add_argument("--reject-flags", type=lambda s: int(s, 0), default=31)
    parser.add_argument("--input", type=Path, help="Replay a complete .mca capture, paced by FPGA clock")
    parser.add_argument("--record", type=Path, default=os.getenv("REDPITAYA_RECORD") or None, help="Optional new binary capture file")
    parser.add_argument("--ui-port", type=int, default=int(os.getenv("REDPITAYA_UI_PORT", "0")), help="Dashboard port; 0 disables it")
    parser.add_argument("--ui-bind", default=os.getenv("REDPITAYA_UI_BIND", "127.0.0.1"))
    args = parser.parse_args()
    if not all(math.isfinite(v) for v in (args.short_us, args.long_us, args.seconds)):
        parser.error("Settings must be finite")
    if not (64 < round(args.short_us * 125) <= round(args.long_us * 125) <= 16384 and round(args.long_us * 125) >= 672):
        parser.error("Gates outside FPGA range")
    if args.seconds < 0 or not 0 <= args.reject_flags <= 65535:
        parser.error("Invalid duration or reject flags")
    if not 0 <= args.ui_port <= 65535:
        parser.error("UI port must be between 0 and 65535")
    dashboard = None
    if args.ui_port:
        from dashboard import Dashboard
        # Spectrum range in nominal V us; 4 covers LaBr3 at full scale with room for slower scintillators.
        dashboard = Dashboard(args.channels, recording=args.record, maximum=float(os.getenv("REDPITAYA_UI_MAX_VUS", "4")))
    import rclpy
    from rclpy.node import Node
    from std_msgs.msg import String, UInt8MultiArray, UInt32
    rclpy.init(args=[])
    node = Node("redpitaya_mca")
    batches = node.create_publisher(UInt8MultiArray, "/redpitaya/events", 100)
    counts = node.create_publisher(UInt32, "/redpitaya/counts", 100)
    per_channel_events = {c: node.create_publisher(UInt8MultiArray, f"/redpitaya/ch{c}/events", 100) for c in range(1,5)}
    per_channel_counts = {c: node.create_publisher(UInt32, f"/redpitaya/ch{c}/counts", 100) for c in range(1,5)}
    statuses = node.create_publisher(String, "/redpitaya/status", 100)
    session = Session(args.reject_flags)
    stopping = False
    def stop(sig, frame):
        nonlocal stopping
        stopping = True
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)
    recording = open(args.record, "xb") if args.record else None
    process = None
    stop_process = None
    interrupted = False
    replay_start = time.monotonic()
    first_clock = None
    def receive(data):
        nonlocal first_clock
        if recording:
            recording.write(data)
            recording.flush()
        for kind, value, accepted in session.feed(data, node.get_clock().now().nanoseconds):
            if dashboard:
                update_dashboard(dashboard, session, kind, value)
            if kind == "batch":
                if args.input:
                    clock = BATCH.unpack_from(value)[1]
                    if first_clock is None:
                        first_clock = clock
                    target = replay_start + (clock - first_clock) * 8e-9
                    pace_replay(target, lambda: stopping)
                batches.publish(UInt8MultiArray(data=value))
                counts.publish(UInt32(data=accepted))
            elif kind == "channel_batch":
                channel, packet = value
                per_channel_events[channel].publish(UInt8MultiArray(data=packet))
                per_channel_counts[channel].publish(UInt32(data=accepted))
            else:
                statuses.publish(String(data=json.dumps(value, separators=(",", ":"))))
        rclpy.spin_once(node, timeout_sec=0)
    try:
        if dashboard:
            dashboard.start(args.ui_bind, args.ui_port)
            print(f"Live MCA dashboard: http://{args.ui_bind}:{args.ui_port}", file=sys.stderr)
        if args.input:
            with args.input.open("rb") as f:
                # Small chunks keep recorded batch timing meaningful.
                while not stopping:
                    chunk = f.read(1024)
                    if not chunk:
                        break
                    receive(chunk)
        else:
            token = uuid.uuid4().hex
            command = "bash /root/mca-fpga/run.sh " + " ".join(shlex.quote(str(v)) for v in (args.seconds, args.short_us, args.long_us, token, ",".join(map(str,args.channels))))
            ssh_command = ["ssh", "-T", "-i", args.identity, "-p", str(args.port),
                "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", "UserKnownHostsFile=" + args.known_hosts, "-o", "HostKeyAlias=" + args.host_key_alias,
                "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
                "root@" + args.host]
            process = subprocess.Popen([*ssh_command, command], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
            last_data = time.monotonic()
            received_data = False
            stop_deadline = None
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    if stopping and not interrupted:
                        # Keep the data connection alive until DONE and FPGA restoration.
                        stop_process = subprocess.Popen([*ssh_command, "bash /root/mca-fpga/stop.sh " + token],
                                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
                        stop_deadline = time.monotonic() + 10
                        interrupted = True
                    if stop_deadline is not None and time.monotonic() > stop_deadline:
                        process.terminate()
                        stop_deadline = None
                    ready = selector.select(.1)
                    if ready:
                        data = os.read(process.stdout.fileno(), 65536)
                        if not data:
                            break
                        last_data = time.monotonic()
                        received_data = True
                        receive(data)
                    elif not stopping and time.monotonic() - last_data > (5 if received_data else 30):
                        raise RuntimeError("MCA stream timed out" if received_data else "MCA startup timed out after 30 seconds")
                code = process.wait(timeout=10)
                if code and not stopping:
                    raise RuntimeError(f"Red Pitaya SSH exited with status {code}")
        if not stopping or session.decoder.done:
            session.decoder.finish()
        node.get_logger().info(f"MCA {'complete' if session.decoder.done else 'interrupted'}: {session.accepted} accepted, {session.rejected} flagged")
    except BaseException as exc:
        if dashboard:
            dashboard.fail(exc)
        raise
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if process:
            process.stdout.close()
        if stop_process:
            try:
                stop_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                stop_process.kill()
                stop_process.wait()
        if recording:
            recording.close()
        node.destroy_node()
        rclpy.shutdown()
        if dashboard:
            dashboard.close()


if __name__ == "__main__":
    main()
