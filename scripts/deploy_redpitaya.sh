#!/usr/bin/env bash
# Upload the reviewed FPGA and tools; does not load it or change board boot.
set -euo pipefail
TASK_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TASK_REPO"
# Per-device connection defaults; explicit environment settings take precedence.
if [[ -f redpitaya/runtime/connection.env ]]; then source redpitaya/runtime/connection.env; fi
TASK_HOST="${REDPITAYA_HOST:-rp-f0d343.local}"
TASK_PORT="${REDPITAYA_PORT:-22}"
TASK_AUTH="$TASK_REPO/redpitaya/runtime"
TASK_BINARY="${REDPITAYA_BITSTREAM:-$TASK_REPO/redpitaya/bitstream/red_pitaya.bin}"
test -r "$TASK_AUTH/id_ed25519" && test -r "$TASK_AUTH/known_hosts" || {
  echo 'Missing redpitaya/runtime SSH key or pinned known_hosts. See redpitaya/README.md.' >&2; exit 1;
}
TASK_SHA=$(python3 -c 'import json; print(json.load(open("redpitaya/bitstream/artifact_manifest.json"))["bin_sha256"])')
[[ "$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TASK_BINARY")" == "$TASK_SHA" ]] || { echo 'Reviewed bitstream checksum mismatch' >&2; exit 1; }
TASK_OPTIONS=(-i "$TASK_AUTH/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$TASK_AUTH/known_hosts"
  -o "HostKeyAlias=${REDPITAYA_HOST_KEY_ALIAS:-rp-f0d343.local}" -o ConnectTimeout=8)
ssh "${TASK_OPTIONS[@]}" -p "$TASK_PORT" "root@$TASK_HOST" 'mkdir -p /root/mca-fpga'
scp "${TASK_OPTIONS[@]}" -P "$TASK_PORT" "$TASK_BINARY" "root@$TASK_HOST:/root/mca-fpga/red_pitaya.bin"
scp "${TASK_OPTIONS[@]}" -P "$TASK_PORT" redpitaya/board/{readout.py,wire.py,tmp451.py,load.sh,restore.sh,run.sh,stop.sh} "root@$TASK_HOST:/root/mca-fpga/"
printf '%s\n' "$TASK_SHA" | ssh "${TASK_OPTIONS[@]}" -p "$TASK_PORT" "root@$TASK_HOST" \
  'cat > /root/mca-fpga/expected_sha256; chmod 755 /root/mca-fpga/*.sh; cd /root/mca-fpga; sha256sum red_pitaya.bin'
echo 'Reviewed MCA files uploaded. FPGA and boot selection unchanged.'
