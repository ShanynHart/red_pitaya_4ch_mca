#!/usr/bin/env python3
"""Synthetic MCA stream for testing the receiver and dashboard without a board.

Writes the same version 2 list-mode stream as the board (META, EVN4, STAT with
temperature, DONE) in real time to standard output or a file. Each input is a
LaBr3:Ce MacroPixel model: a Cs-137 source (photopeak and Compton continuum),
falling room background, the La-138 internal lines and the internal alpha groups,
with resolution, pulse shape, ADC clipping and a temperature-driven SiPM gain.

    python3 simulate.py --channels 2 | python3 reader.py --input /dev/stdin --ui-port 8080

The numbers are plausible, not measured; use them to exercise the software.
"""
import argparse
import math
from pathlib import Path
import random
import signal
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().with_name("board")))
from wire import MAGIC4, EVENT4, frame, json_frame

CLOCK_HZ = 125_000_000
SHORT, LONG = 250, 3125                  # 2 us and 25 us gates in samples
FULL_SCALE, BASELINE = 8191, 120         # ADC counts
LONG_PER_AMPLITUDE = 74                  # long integral per count of pulse height, LaBr3
# Emitting components: (name, rate per second, energy sampler in keV, short/long ratio)
ALPHAS = [(5.7, 2.34), (6.6, 2.58), (7.4, 2.85)]  # alpha energy MeV, electron-equivalent MeV


def components(rng, source_cps):
    def compton():
        # Flat-ish continuum up to the 477 keV Compton edge with a soft edge.
        return min(rng.uniform(0, 477), rng.gauss(477, 12))
    return [
        ("Cs-137 photopeak", 0.30 * source_cps, lambda: 661.7, 0.880),
        ("Cs-137 continuum", 0.70 * source_cps, compton, 0.880),
        ("room background", 45.0, lambda: rng.expovariate(1 / 180) + 30, 0.880),
        ("La-138 1436 keV + Ba K X-ray", 1.2, lambda: 1468.0, 0.880),
        ("La-138 Ba K X-ray", 3.0, lambda: 35.0, 0.880),
        ("La-138 beta + 789 keV", 2.5, lambda: 789 + rng.uniform(0, 255), 0.880),
        *[(f"alpha {mev} MeV", 2.8, (lambda ee=ee: ee * 1000), 0.922) for mev, ee in ALPHAS],
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--channels", default="2", help="Active inputs, e.g. 2 or 1,2,3,4")
    parser.add_argument("--seconds", type=float, default=0, help="0 runs until interrupted")
    parser.add_argument("--bias", type=float, default=27.0, help="SiPM bias; 30 V roughly doubles the gain and clips the alphas")
    parser.add_argument("--source-cps", type=float, default=120.0, help="Cs-137 rate per input")
    parser.add_argument("--temperature", type=float, default=25.0, help="Mean detector temperature, C")
    parser.add_argument("--swing", type=float, default=3.0, help="Temperature swing amplitude, C")
    parser.add_argument("--period", type=float, default=600.0, help="Temperature cycle period, s")
    parser.add_argument("--gain-per-c", type=float, default=-0.9, help="SiPM gain change, percent per C")
    parser.add_argument("--speed", type=float, default=1.0, help="Stream faster than real time")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--output", type=Path, help="Write to this new file instead of standard output")
    args = parser.parse_args()
    channels = sorted({int(c) for c in args.channels.split(",")})
    if not channels or any(c not in range(1, 5) for c in channels):
        parser.error("Channels must be from 1..4")

    rng = random.Random(args.seed)
    out = args.output.open("xb") if args.output else sys.stdout.buffer
    # 125 ADC-count-samples per keV at 27 V, about 1.7 times more at 30 V.
    gain0 = 125.0 * (1.7 if args.bias >= 29 else 1.0)
    models = {c: components(rng, args.source_cps) for c in channels}
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)

    start = 1_000_000_000
    sequence = {c: 0 for c in channels}
    triggered = {c: 0 for c in channels}
    clipped = {c: 0 for c in channels}
    dead = {c: 0 for c in channels}
    out.write(MAGIC4)
    out.write(json_frame(b"META", dict(
        type="metadata", mode="fpga_multichannel_mca", abi="2.0", clock_hz=CLOCK_HZ,
        active_channels=channels, start_clock_ticks=start,
        channel_start_clocks={str(c): start for c in channels},
        short_samples=SHORT, long_samples=LONG, pretrigger_samples=64,
        calibration="simulated LaBr3:Ce MacroPixel; not measured data", simulated=True)))
    out.flush()

    def temperature(t):
        return args.temperature + args.swing * math.sin(2 * math.pi * t / args.period)

    def status(kind, clock):
        rows = [dict(channel=c, clock_ticks=clock, live_ticks=max(0, clock - start - dead[c]),
                     triggered_events=triggered[c], fifo_dropped_events=0,
                     fifo_stored_events=sequence[c], read_events=sequence[c],
                     baseline_adc_counts=BASELINE, mean_absolute_noise_adc_counts=6,
                     effective_threshold_adc_counts=164) for c in channels]
        local = round(temperature((clock - start) / CLOCK_HZ) * 16) / 16  # TMP451 resolution
        return json_frame(b"STAT" if kind == "status" else b"DONE", dict(
            type=kind, clock_ticks=clock, channels=rows, read_events=sum(sequence.values()),
            triggered_events=sum(triggered.values()), fifo_dropped_events=0,
            fifo_stored_events=sum(sequence.values()), simulated=True,
            temperature=dict(local_c=local, remote_c=None, error=None)))

    step = CLOCK_HZ // 10  # 100 ms batches, as on the board
    clock, wall0 = start, time.monotonic()
    while not stopping and (not args.seconds or clock - start < args.seconds * CLOCK_HZ):
        end = clock + step
        t = (clock - start) / CLOCK_HZ
        gain = gain0 * (1 + args.gain_per_c / 100 * (temperature(t) - args.temperature))
        events = []
        for c in channels:
            for _, rate, energy, ratio in models[c]:
                for _ in range(_poisson(rng, rate * 0.1)):
                    e = energy()
                    # About 3 % FWHM at 662 keV, scaling as 1/sqrt(E).
                    e = rng.gauss(e, e * 0.03 / 2.355 * math.sqrt(661.7 / max(e, 20)))
                    integral = e * gain
                    amplitude = integral / LONG_PER_AMPLITUDE
                    if amplitude < 40:  # below the trigger threshold
                        continue
                    triggered[c] += 1
                    flags = 0
                    if amplitude + BASELINE >= FULL_SCALE:
                        flags, clipped[c] = 1, clipped[c] + 1
                        amplitude = FULL_SCALE - BASELINE
                        integral = amplitude * LONG_PER_AMPLITUDE * 1.15
                    short = integral * rng.gauss(ratio, 0.006 + 1.5 / math.sqrt(max(integral, 1)))
                    tick = rng.randrange(clock, end)
                    events.append((tick, c, flags, short, integral, amplitude))
        events.sort()
        payload = bytearray()
        for tick, c, flags, short, integral, amplitude in events:
            sequence[c] += 1
            dead[c] += LONG + 400
            payload += EVENT4.pack(tick & 0xffffffff, tick >> 32, (flags << 16) | rng.randrange(65536),
                                   round(short) & 0xffffffff, round(integral) & 0xffffffff,
                                   (round(amplitude) + BASELINE) << 16 | BASELINE, sequence[c],
                                   (LONG << 16) | SHORT, c)
        if payload:
            out.write(frame(b"EVN4", bytes(payload)))
        out.write(status("status", end))
        out.flush()
        clock = end
        # Keep pace with real time (or faster with --speed).
        delay = wall0 + (clock - start) / CLOCK_HZ / args.speed - time.monotonic()
        if delay > 0:
            time.sleep(delay)
    out.write(status("summary", clock))
    out.flush()


def _poisson(rng, mean):
    if mean > 30:
        return max(0, round(rng.gauss(mean, math.sqrt(mean))))
    limit, k, p = math.exp(-mean), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
