#!/usr/bin/env bash
# Stream simulated detector data into the dashboard, with no board connected.
# Extra arguments go to redpitaya/simulate.py, e.g. --channels 1,2 --bias 30 --speed 10
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
port="${REDPITAYA_UI_PORT:-8080}"
docker compose build redpitaya
docker rm -f redpitaya-sim >/dev/null 2>&1 || true
docker compose run -d --rm --name redpitaya-sim redpitaya bash -c \
  "python3 /opt/redpitaya/simulate.py $(printf '%q ' "$@") | python3 /opt/redpitaya/reader.py --input /dev/stdin --ui-port $port --ui-bind ${REDPITAYA_UI_BIND:-127.0.0.1}"
echo "Simulated data on the dashboard: http://localhost:$port"
echo "Stop with: docker rm -f redpitaya-sim"
