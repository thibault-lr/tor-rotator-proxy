#!/usr/bin/env bash
set -euo pipefail

proxy=${1:-http://127.0.0.1:5566}
if [[ $# -gt 1 || $proxy != http://?* ]]; then
  echo 'Usage: bash script/ip-probe.sh [http://proxy:port]' >&2
  exit 1
fi

# Ignore curlrc and NO_PROXY so every probe uses the requested proxy.
exec curl --disable --silent --show-error \
  --proxy "$proxy" --noproxy '' \
  --proto '=https' --max-time 30 --max-filesize '1024' \
  --fail-with-body --write-out '\n%{http_code} %{http_connect}\n' \
  https://check.torproject.org/api/ip
