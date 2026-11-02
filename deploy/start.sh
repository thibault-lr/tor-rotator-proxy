#!/bin/bash
set -u

tor -f /etc/tor/torrc &
tor_pid=$!
node /app/dist/main.js &
proxy_pid=$!

shutdown() {
  trap '' TERM INT
  # Bound shutdown even if a service no longer handles signals.
  (sleep 15; kill -KILL "$proxy_pid" "$tor_pid" 2>/dev/null) &
  deadline_pid=$!

  # Let the proxy drain before taking away its Tor connections.
  kill -TERM "$proxy_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
  kill -TERM "$tor_pid" 2>/dev/null || true
  wait "$tor_pid" 2>/dev/null || true

  kill -KILL "$deadline_pid" 2>/dev/null || true
  wait "$deadline_pid" 2>/dev/null || true
}

trap shutdown EXIT
trap 'exit 0' TERM INT
wait -n "$proxy_pid" "$tor_pid"
# Both services are long-lived; any unsolicited exit is a failure.
exit 1
