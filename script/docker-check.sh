#!/bin/bash
set -euo pipefail

image=${1:?Usage: bash script/docker-check.sh IMAGE}
container="tor-rotator-check-$$"

cleanup() {
  docker rm -fv "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start() {
  cleanup
  docker run -d --name "$container" --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges \
    --mount type=volume,dst=/var/lib/tor "$image" >/dev/null

  for attempt in {1..50}; do
    if docker exec "$container" node -e '
      const net = require("node:net");
      for (const port of [5566, 9050]) {
        const socket = net.connect(port, "127.0.0.1", () => socket.end());
        socket.setTimeout(500, () => process.exit(1));
        socket.on("error", () => process.exit(1));
      }
    ' >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done
  docker logs "$container"
  echo "Services did not start" >&2
  exit 1
}

signal_service() {
  docker exec "$container" bash -c '
    for path in /proc/[0-9]*/exe; do
      if [[ $(readlink "$path") == */"$1" ]]; then
        pid=${path#/proc/}
        kill -s "$2" "${pid%/exe}"
        exit
      fi
    done
    exit 1
  ' bash "$1" "$2"
}

expect_exit() {
  for attempt in {1..100}; do
    if [[ $(docker inspect -f '{{.State.Running}}' "$container") == false ]]; then
      if [[ $(docker inspect -f '{{.State.ExitCode}}' "$container") != "$1" ]]; then
        docker logs "$container"
        echo "Unexpected container exit code" >&2
        exit 1
      fi
      return
    fi
    sleep 0.2
  done
  docker logs "$container"
  echo "Container did not stop" >&2
  exit 1
}

start
docker stop --time 20 "$container" >/dev/null
expect_exit 0
docker logs "$container" 2>&1 | grep -q 'Proxy stopped'
echo "PASS: graceful shutdown"

start
docker kill --signal INT "$container" >/dev/null
expect_exit 0
echo "PASS: SIGINT shutdown"

for service in node tor; do
  start
  signal_service "$service" KILL
  expect_exit 1
  echo "PASS: $service failure stops the container"
done

start
signal_service node STOP
signal_service tor KILL
expect_exit 1
echo "PASS: shutdown remains bounded when the proxy is unresponsive"
