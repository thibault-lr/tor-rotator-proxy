# Tor benchmark — October 30, 2026

This is a low-rate, real-network measurement of the Docker deployment, not a
capacity or reliability guarantee. The first complete 60-second measured run is
reported without dropping its failed request. [Raw JSON](benchmarks/2026-10-30.json)
is committed alongside this report.

## Workload and environment

- 60 HTTPS requests to `https://check.torproject.org/api/ip`, scheduled at 1 request
  per second. Each request opens a fresh CONNECT tunnel and verifies TLS. Only
  HTTP 200 responses with `IsTor=true` and a valid IP count as successes.
- No retries or redirects. Each probe has a 30-second deadline. A 403/429 would
  stop new requests; neither stopped this run.
- One proxy and one Tor container, using the reusable Compose topology. Each runs
  as a non-root user with a read-only root filesystem. A temporary loopback port
  exposed the proxy to the host benchmark client.
- Apple M2 host, 16 GiB RAM; Docker Desktop 4.27.2, Engine 25.0.3, Linux ARM64 VM
  with 6 CPUs and about 5.79 GiB memory. Other unrelated containers existed;
  this was not an otherwise idle, controlled performance lab.
- Proxy: Node 24.22.2. Tor: 0.4.9.11. Benchmark client: Node 22.22.1 and curl 8.4.0
  on the host. Browser rendering and scraper application work are not measured.
- Tor bootstrap completed before the run. Earlier smoke requests had already
  used the deployment. Bootstrap time and memory are excluded from these results.
- Benchmark source: commit `6283343`. The measured proxy image contains the same
  compiled runtime files as the subsequent final build; its package scripts differ.

## Request results

| Metric                                  |        Observed value |
| --------------------------------------- | --------------------: |
| Requested / observed sending rate       |           1 / 1 req/s |
| Requests sent                           |                    60 |
| Successful / failed                     |                59 / 1 |
| Success rate                            |                98.33% |
| Sending window                          |                  60 s |
| Total time, including pending responses |               77.56 s |
| Completed requests per second           |                  0.77 |
| Distinct successful Tor exit IPs        |                    20 |
| Mean successful latency                 |                1.91 s |
| P50 / P95 / P99 successful latency      | 1.28 / 4.59 / 23.56 s |

Latency includes process startup, CONNECT, TLS and the complete response.
Failures are excluded from latency percentiles but remain in the request counts.
The aggregate report does not identify the failed request's root cause.
`completedRps` counts all completed attempts, including failures, over the sending
and draining period. It excludes Docker sampling setup and final collection.

## Container resources

| Container | Mean CPU | Peak CPU | Mean RAM (MiB) | Peak RAM (MiB) | Network received / sent (MiB) | Peak processes/threads |
| --------- | -------: | -------: | -------------: | -------------: | ----------------------------: | ---------------------: |
| Proxy     |    0.97% |    3.19% |          29.28 |          30.39 |                   0.46 / 0.46 |                     11 |
| Tor       |    1.49% |   10.36% |          15.90 |          16.17 |                   0.67 / 0.65 |                      7 |

Docker sampling completed: **40 snapshots over 79.80 seconds**, including baseline
and final samples around the sending/draining window. Means are averages of the
snapshots; peaks are observed sample maxima, not continuous maxima.

CPU uses Docker's scale: 100% is one logical CPU. The Docker CLI subtracts cache
from Linux memory usage. Network figures are differences between rounded Docker
counters and include Tor protocol traffic and forwarding on internal networks.
Do not add the two rows to estimate Internet payload bytes. Process counts
include kernel threads. Client, Docker daemon and VM overhead are excluded.
See [Docker's statistics documentation](https://docs.docker.com/reference/cli/docker/container/stats/).

## Reproduce

These instructions target the two-container `v0.2.0` release. Use a checkout of
that tag; `v0.3.0` combines both processes into one image.

Build the two local images and use an isolated project. The small override
publishes a loopback port only for the host benchmark:

```sh
docker build --target check .
docker build -t tor-rotator-benchmark:local .
docker build -f deploy/tor.Dockerfile -t tor-rotator-benchmark-tor:local .

cat > /tmp/tor-rotator-benchmark.yaml <<'YAML'
services:
  tor-rotator:
    ports:
      - "127.0.0.1:5567:5566"
YAML

export TOR_ROTATOR_IMAGE=tor-rotator-benchmark
export TOR_ROTATOR_VERSION=local
docker compose -p tor-rotator-bench -f compose.images.yaml \
  -f /tmp/tor-rotator-benchmark.yaml up -d --pull never
docker compose -p tor-rotator-bench -f compose.images.yaml logs -f tor
# Wait for Bootstrapped 100%, then leave the log stream with Ctrl+C.

corepack yarn benchmark --proxy http://127.0.0.1:5567 \
  --duration 60s --requestsPerSecond 1 \
  --containers tor-rotator-bench-tor-rotator-1,tor-rotator-bench-tor-1 \
  > benchmark.json

docker compose -p tor-rotator-bench -f compose.images.yaml \
  -f /tmp/tor-rotator-benchmark.yaml down
```

An exit code of 1 still produces the JSON report when requests fail or resource
sampling is incomplete. This measured run exited with code 1 because one request
failed. Keep that report; do not retain only successful runs. The cleanup command
preserves the project's Tor state volume.

## Limits and image identity

- Sixty small requests do not establish maximum throughput, large-download memory
  usage, browser performance or long-running reliability. A real scraper must
  handle request failures and decide its own retry policy.
- Different circuits can share an exit IP. Twenty distinct exits here is an
  observation, not a promised rate of IP rotation. Identities can renew during a
  run; sixteen identity slots do not impose a lifetime maximum of sixteen IPs.
- An earlier Python client smoke attempt encountered a TLS EOF. A separate repeat
  passed HTTP and HTTPS with certificate verification. Its cause was not isolated;
  it is not hidden inside an automatic retry in the measured benchmark.
- Host builds and other validation commands were not running during this measured
  window. Results on another host, network, Tor circuit or destination can differ.

Measured image IDs (before local tag updates):

```text
proxy: sha256:95ef4c14f0d06a79e95a8972293fd801bfb5620ca767f584493bc850fb9f2374
tor:   sha256:90adbf737963bd7670dbd830b49a028920ce53799183e190f5358bf3e4a20cc2
```
