import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "board"))
import tmp451


class FakeSensor:
    def __init__(self, registers):
        self.registers = registers

    def register(self, pointer):
        return self.registers[pointer]

    read = tmp451.TMP451.read

    def close(self):
        pass


class TMP451Test(unittest.TestCase):
    def test_conversion(self):
        self.assertEqual(tmp451.convert(25, 0x80, False), 25.5)
        self.assertEqual(tmp451.convert(25, 0x10, False), 25.0625)
        self.assertEqual(tmp451.convert(54, 0x00, True), -10)

    def test_read_reports_open_remote_diode(self):
        registers = {tmp451.CONFIG: 0, tmp451.LOCAL_HIGH: 23, tmp451.LOCAL_LOW: 0x40,
                     tmp451.REMOTE_HIGH: 0, tmp451.REMOTE_LOW: 0, tmp451.STATUS: tmp451.STATUS_REMOTE_OPEN}
        self.assertEqual(FakeSensor(registers).read(), {"local_c": 23.25, "remote_c": None})
        registers.update({tmp451.STATUS: 0, tmp451.REMOTE_HIGH: 24, tmp451.REMOTE_LOW: 0xc0})
        self.assertEqual(FakeSensor(registers).read(), {"local_c": 23.25, "remote_c": 24.75})

    def test_monitor_survives_missing_sensor_and_rate_limits(self):
        monitor = tmp451.Monitor(bus=99, period_s=2)
        first = monitor.poll(now=10)
        self.assertIsNone(first["local_c"])
        self.assertIn("no TMP451", first["error"])
        self.assertIs(monitor.poll(now=11), first)
        self.assertIsNot(monitor.poll(now=12.5), first)


if __name__ == "__main__":
    unittest.main()
