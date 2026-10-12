#!/usr/bin/env python3
"""Read a TI TMP451 temperature sensor over I2C. Run on the Red Pitaya.

The CapeScint MacroPixel exposes its TMP451 on SCL/SDA/GND/VCC pins. Wire them
to extension connector E2 pin 9 (SCL) and pin 10 (SDA), a GND pin and 3V3 (E1
pin 1 or 2); never the 5 V pin. The bus belongs to the processor, so it works
with either the stock or the MCA FPGA image loaded.

Standalone use: python3 tmp451.py [--bus 0] [--address 0x4c] [--watch SECONDS]
"""
import argparse
import fcntl
import os
import time

I2C_SLAVE = 0x0703
LOCAL_HIGH, REMOTE_HIGH, STATUS, CONFIG, REMOTE_LOW, LOCAL_LOW = 0x00, 0x01, 0x02, 0x03, 0x10, 0x15
STATUS_REMOTE_OPEN = 0x04
CONFIG_EXTENDED_RANGE = 0x04


def convert(high, low, extended):
    """Degrees Celsius from the two result bytes; the low byte's top nibble is 1/16 degree."""
    return high + (low >> 4) / 16 - (64 if extended else 0)


class TMP451:
    def __init__(self, bus=0, address=0x4c):
        self.fd = os.open(f"/dev/i2c-{bus}", os.O_RDWR)
        try:
            fcntl.ioctl(self.fd, I2C_SLAVE, address)
        except OSError:
            os.close(self.fd)
            raise

    def register(self, pointer):
        os.write(self.fd, bytes([pointer]))
        return os.read(self.fd, 1)[0]

    def read(self):
        """Local (sensor chip) and remote (external diode) temperature; remote is None if unconnected."""
        extended = bool(self.register(CONFIG) & CONFIG_EXTENDED_RANGE)
        # Reading a high byte latches its low byte, so keep this order.
        local = convert(self.register(LOCAL_HIGH), self.register(LOCAL_LOW), extended)
        remote_high, remote_low = self.register(REMOTE_HIGH), self.register(REMOTE_LOW)
        remote = convert(remote_high, remote_low, extended)
        # An open diode sets the status flag; a shorted or absent one reads all zeros.
        if self.register(STATUS) & STATUS_REMOTE_OPEN or not (remote_high or remote_low):
            remote = None
        return {"local_c": local, "remote_c": remote}

    def close(self):
        os.close(self.fd)


class Monitor:
    """Rate-limited reads that never raise: acquisition must survive an unplugged sensor."""
    def __init__(self, bus=0, address=0x4c, period_s=2.0):
        self.bus, self.address, self.period_s = bus, address, period_s
        self.sensor = None
        self.next_read = 0.0
        self.latest = {"local_c": None, "remote_c": None, "error": "not read yet"}

    def poll(self, now=None):
        now = time.monotonic() if now is None else now
        if now < self.next_read:
            return self.latest
        self.next_read = now + self.period_s
        try:
            if self.sensor is None:
                self.sensor = TMP451(self.bus, self.address)
            self.latest = dict(self.sensor.read(), error=None)
        except OSError as exc:
            if self.sensor is not None:
                self.sensor.close()
                self.sensor = None
            self.latest = {"local_c": None, "remote_c": None,
                           "error": f"no TMP451 at 0x{self.address:02x} on bus {self.bus}: {exc.strerror}"}
        return self.latest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bus", type=int, default=0)
    parser.add_argument("--address", type=lambda s: int(s, 0), default=0x4c)
    parser.add_argument("--watch", type=float, default=0, help="Repeat every this many seconds")
    args = parser.parse_args()
    monitor = Monitor(args.bus, args.address, period_s=0)
    while True:
        row = monitor.poll()
        if row["error"]:
            print(row["error"])
        else:
            remote = "not connected" if row["remote_c"] is None else f"{row['remote_c']:.2f} C"
            print(f"{time.strftime('%H:%M:%S')}  local {row['local_c']:.2f} C  remote {remote}", flush=True)
        if not args.watch:
            return 1 if row["error"] else 0
        time.sleep(args.watch)


if __name__ == "__main__":
    raise SystemExit(main())
