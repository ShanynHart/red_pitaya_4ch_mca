# Red Pitaya four-channel FPGA MCA

FPGA pulse acquisition and Linux receiver for the **STEMlab 125-14 4-Input V1R3**
(Zynq xc7z020clg400-1). Each selected input independently records short and long
pulse integrals, a constant-fraction timestamp, peak, baseline and quality flags.
The checked bitstream is included; Vivado is only needed to change the FPGA logic.

Defaults: **IN1 active, 2 µs short gate, 25 µs long gate**, positive pulses,
nominal 20 mV LV threshold floor plus adaptive noise threshold. All four inputs
can run concurrently. Each pulse keeps its own timestamp; coincidence matching
is left to a later receiver implementation.

## Contents

| Directory | Purpose |
|---|---|
| `fpga/rtl` | Pulse processing, four-channel MMIO/FIFOs, clock crossing and constraints |
| `fpga/sim` | HDL and Python reference tests |
| `fpga/docker` | Vivado execution environment; proprietary tools mounted separately |
| `redpitaya/board` | Board readout, temporary FPGA load, run/stop ownership and stock restoration |
| `redpitaya/bitstream` | Checked `.bin`, source hashes and implementation review |
| `redpitaya/reader.py` | SSH/TCP list-mode receiver, ROS 2 batches, counts, status and raw recording |
| `redpitaya/dashboard.py`, `redpitaya/web` | Standalone live integral spectra and count-rate dashboard |
| `scripts` | Standalone deploy/start/stop helpers |
| `integrations/airy_slam` | Optional Rust gamma/recording integration patch and service overlay |

The board readout and wire decoder are mirrored in `fpga/` for local tests and
exports. `scripts/check_release.py` verifies that both copies match and that the
supplied bitstream, RTL and constraints match their recorded hashes.

## Start on a Linux receiver

The supplied Compose service uses ROS 2 Jazzy and works on ARM64 Linux, including
the Radxa Q6A. It needs Docker Compose, Python 3 and SSH access to the board.
Native ROS users can run `python3 redpitaya/reader.py --help` instead.
The board loader was exercised with Red Pitaya OS **3.00-57**, the four-input
`z20_125_4ch` profile and its stock `v0.94` overlay. Other OS releases may need
loader adjustments. Confirm the detector voltage fits the input's LV/HV range.

Connect the receiver and board over Ethernet and use the board's reachable
hostname or IP. Wi-Fi also transports the same SSH stream. Acquisition requires
no Radxa USB device access. Set up a dedicated SSH key and pinned host key under
`redpitaya/runtime/`; this directory is ignored by Git:

```sh
mkdir -p redpitaya/runtime
chmod 700 redpitaya/runtime
ssh-keygen -t ed25519 -N '' -f redpitaya/runtime/id_ed25519
ssh-copy-id -i redpitaya/runtime/id_ed25519.pub root@rp-f0d343.local
# Obtain and verify the board's host fingerprint, then save its key:
ssh-keyscan rp-f0d343.local > redpitaya/runtime/known_hosts
chmod 600 redpitaya/runtime/id_ed25519 redpitaya/runtime/known_hosts
```

The host-key alias defaults to `rp-f0d343.local`, allowing that pinned key to
verify the same board when `REDPITAYA_HOST` is an IP. For another board set
`REDPITAYA_HOST_KEY_ALIAS` to the name used in `known_hosts`.

```sh
export REDPITAYA_HOST=rp-f0d343.local   # or its reachable IP
export ROS_DOMAIN_ID=42
bash scripts/start_redpitaya.sh --channels 1
# Alternatively select physical channels 1,2,3,4 or, for example, 1,3.
docker compose logs -f redpitaya
bash scripts/stop_redpitaya.sh
```

The start script also serves the **live dashboard at http://localhost:8080**.
It is included in this repository and needs no Airy-SLAM checkout. Select any
active input to overlay its accumulated long-gate integral spectrum and recent
count rate; export the histogram bins as CSV. Plots include accepted events
only. Flagged events, out-of-range integrals and FIFO drops are shown separately.
Rates use elapsed FPGA time and are not dead-time corrected. Integrals are in
nominal V·µs, not calibrated keV. The dashboard is read-only; use the start/stop
scripts to control acquisition. Stopping also stops the UI.

To try the dashboard without a board, stream simulated LaBr3:Ce data (Cs-137,
La-138 internal lines, internal alphas, a temperature cycle and its gain drift):

    bash scripts/simulate_dashboard.sh --channels 2          # add --bias 30 to see clipping

`REDPITAYA_UI_PORT` changes the port (default `8080`; `0` disables the UI).
The default bind address is loopback. Set `REDPITAYA_UI_BIND=0.0.0.0` to allow
other computers on your network to open `http://<receiver-ip>:8080`.
The dashboard has no login; use that setting only on a trusted network.

On macOS, use Docker Desktop **4.34 or later** and enable **Settings → Resources
→ Network → Enable host networking** for this Compose configuration. Use the
board's reachable IP in `REDPITAYA_HOST` if `.local` does not resolve inside
Docker. The receiver and browser UI use SSH/TCP and HTTP; external ROS topic
discovery may need separate DDS configuration. The Linux receiver was hardware
tested; macOS dashboard/receiver checks use capture replay, not live hardware.

`REDPITAYA_SHORT_US` and `REDPITAYA_LONG_US` set gates; `REDPITAYA_CHANNELS` sets
the same channel list as `--channels`. `REDPITAYA_RECORD=/captures/run-001.mca`
records all raw candidates to a **new** file in `redpitaya/captures/`.
Optional ignored `runtime/connection.env` can export connection defaults, using
`${REDPITAYA_HOST:=...}` to preserve an explicit environment override.

Starting uploads the checked files and temporarily loads the MCA. Stopping
requests a final drain/summary, reloads stock `v0.94` and starts the oscilloscope.
The stock SD files and boot selection remain intact. FPGA acquisition and the
stock oscilloscope are separate personalities; the oscilloscope cannot acquire
while the MCA is loaded. The wrapper logs restoration on the board at
`/root/mca-fpga/last_restore.log`. A severed connection can leave a truncated
capture; a complete file must end with a validated DONE frame.

## Data and timing

The FPGA keeps a 128-event FIFO per channel. The ARM reader drains them roughly
every 1 ms, then sends compact binary batches and status at nominal **10 Hz**
over SSH/TCP. Each event is **36 bytes**: eight raw FPGA words plus physical
channel ID. There are two energy-related integrals per event. At 3,000 events/s
on each of four inputs, raw event payload is 432 kB/s, plus transport/status
headers. Backpressure can cause counted FIFO drops.

The ROS receiver publishes `/redpitaya/events`, `/redpitaya/counts`,
`/redpitaya/status` and per-channel `/redpitaya/chN/events` and `counts`.
Counts are accepted events **in each batch**, not cumulative counts or counts/s.
All candidates, including rejected quality flags, remain in the event stream
and optional raw recording. Detector energy calibration is not provided.
See [receiver protocol](redpitaya/README.md) for frame and ROS payload layouts,
and [FPGA design](fpga/README.md) for gates, CFD and register details.

IN1/2 and IN3/4 use two native ADC clock domains and a shared time reference.
Timestamps retain a 64-bit 8 ns tick and 16-bit fractional tick; fractional
representation does not establish physical timing resolution. Channel offsets,
inter-pair sample phase, detector delays and jitter need split-pulse calibration
before interpreting narrow coincidences. Network arrival time is unnecessary
for coincidences within this board. ROS wall time is anchored to first status
arrival; offset and drift relative to SLAM remain uncalibrated.

Only one pulse per channel can be in flight. Overlaps within its long gate are
not separately recorded. Live counters exclude busy, warmup and rearming time;
they do not measure missed incident pulses.

## Test and rebuild

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
PYTHON="$PWD/.venv/bin/python" bash fpga/sim/run.sh
python3 -m unittest discover -s redpitaya/tests -p 'test_*.py'
python3 scripts/check_release.py
```

HDL tests require Icarus Verilog (`iverilog` and `vvp`). Core simulations use
synthetic waveforms; private hardware captures are not included. Optional local
capture replay uses `MCA_CAPTURE_FIXTURES=/path/to/results` with the historical
`tuned-run` and `radxa-live-50us` JSONL fixtures. No hardware is accessed by tests.

To build a changed FPGA, install Vivado **2025.1** with Zynq-7000 support, then:

```sh
bash fpga/fetch_vendor.sh
docker build --platform linux/amd64 -t redpitaya-vivado-env:2025.1 fpga/docker
bash fpga/docker/run_build.sh /path/to/installed-AMD-tools
python3 fpga/validate_artifacts.py
```

The vendor source is pinned to `728a4f37e9c0a9b5ba1d9b7a0d44c38bbd2dc674`.
Apple Silicon AMD64 Docker emulation was used for the supplied image; it is not
an AMD-supported Vivado platform. AMD tools, installer credentials and caches
are excluded. Newly built binaries need a fresh implementation review and
matching manifest before deployment; the deployer rejects an unrecognized hash.
Upstream binary redistribution notices are in [third_party](third_party/README.md).

## Verification and current limits

The supplied image passed setup/hold timing with 0.049/0.051 ns margins and
bitstream DRC with zero errors. The implementation review records remaining
CDC/startup warnings and incomplete stock external ADC timing constraints.
This remains a hardware prototype.

Four concurrent simulated pulses passed independent FIFO, MMIO crossing,
disable/reset isolation and common-reference tests. Deterministic readout tests
exercise 20,000 simulated events/s total; this is not a hardware throughput test.
A 15-second board run with four inputs enabled yielded 18 IN1 candidates,
17 accepted and zero FIFO drops; IN2–IN4 were quiet. Selective acquisition stopped
cleanly and restored the scope. Detector pulses on IN2–IN4, relative timing
calibration and sustained few-kHz hardware acquisition remain to be measured.
