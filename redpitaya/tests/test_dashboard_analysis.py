import json
from pathlib import Path
import random
import sys
import unittest
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard import Dashboard

TICKS = 125000000


def pulse(integral, ratio=0.88, amplitude=0, baseline=0, flags=0):
    raw = round(integral * 8192 / .008) & 0xffffffff
    short = round(integral * ratio * 8192 / .008) & 0xffffffff
    return (0, 0, flags << 16, short, raw, (amplitude + baseline) << 16 | (baseline & 0xffff), 1, 0)


class AnalysisTests(unittest.TestCase):
    def test_clipped_pulses_are_counted_and_full_scale_is_estimated(self):
        dashboard = Dashboard([2], maximum=4)
        # Clear pulses: 0.1 V us per 1000 counts of amplitude above a baseline of 100.
        records = [pulse(0.1 * a / 1000, amplitude=a, baseline=100) for a in range(1000, 5000, 100)]
        records += [pulse(0.9, flags=1), pulse(0.95, flags=1)]
        dashboard.batch(2, 0, TICKS, TICKS, records, 31)
        row = dashboard.snapshot()["channels"][0]
        self.assertEqual((row["clipped"], row["rejected"], row["accepted"]), (2, 2, 40))
        self.assertAlmostEqual(row["full_scale"], 0.1 / 1000 * (8191 - 100), places=6)

    def test_full_scale_needs_enough_clear_pulses(self):
        dashboard = Dashboard([1])
        dashboard.batch(1, 0, TICKS, TICKS, [pulse(0.2, amplitude=2000)] * 5 + [pulse(0.01, amplitude=50)] * 50, 31)
        self.assertIsNone(dashboard.snapshot()["channels"][0]["full_scale"])

    def test_gain_follows_a_drifting_peak_beyond_the_region(self):
        dashboard, rng = Dashboard([2], maximum=4), random.Random(3)
        for k in range(20):
            records = [pulse(rng.gauss(0.30 * (1 + 0.005 * k), 0.004)) for _ in range(300)]
            start = k * 10 * TICKS
            dashboard.batch(2, start, start + 9 * TICKS, 9 * TICKS, records, 31)
            dashboard.set_status({"type": "status", "clock_ticks": start + 9 * TICKS, "temperature": {"local_c": 25 + 0.1 * k}})
        rows = dashboard.gain(0.28, 0.32)["channels"][0]["rows"]
        self.assertEqual(len(rows), 20)
        for k, row in enumerate(rows):
            self.assertAlmostEqual(row["centroid"], 0.30 * (1 + 0.005 * k), delta=4 * row["error"] + 1e-4)
            self.assertAlmostEqual(row["temperature_c"], 25 + 0.1 * k)

    def test_shape_grid_and_http_route(self):
        dashboard = Dashboard([1], maximum=4)
        dashboard.batch(1, 0, TICKS, TICKS, [pulse(0.21, ratio=0.88)] * 30 + [pulse(0.31, ratio=0.92)] * 10, 31)
        grid = dashboard.shape(0, 0.4, 0.8, 1.0, columns=4, rows=2)["channels"][0]["cells"]
        self.assertEqual(sorted(grid), [[2, 0, 30], [3, 1, 10]])
        port = dashboard.start("127.0.0.1", 0)
        self.addCleanup(dashboard.close)
        with urlopen(f"http://127.0.0.1:{port}/api/shape?low=0&high=0.4&ratio_low=0.8&ratio_high=1&columns=4&rows=2") as response:
            self.assertEqual(sum(cell[2] for cell in json.load(response)["channels"][0]["cells"]), 40)


if __name__ == "__main__":
    unittest.main()
