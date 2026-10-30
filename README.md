# Tor Rotator

HTTP proxy that sends requests through Tor and rotates SOCKS identities
internally. Clients use their usual HTTP proxy setting; no SDK or special headers.
HTTPS uses CONNECT, keeping TLS between the client and the destination.
The only runtime dependency is `socks`.

## Use it

Run these commands from this directory with Docker Desktop running and available
disk space. The optional `.env` file is not required for the defaults.

```
# Native proxy settings. Compose fixes these for its internal network.
PROXY_BIND=127.0.0.1:5566
TOR_SOCKS_ADDRS=127.0.0.1:9050

# Docker host port only; useful when another proxy already uses 5566.
HOST_PROXY_PORT=5566
```

## Run

```sh
docker compose up --build -d
docker compose logs -f tor
```

Wait for `Bootstrapped 100%`, then press Ctrl+C to stop following logs (the
containers keep running). Test the proxy:

```sh
curl --proxy http://127.0.0.1:5566 --noproxy '' https://check.torproject.org/api/ip
```

Use any API URL in the same way. Its status, response headers and body come back
through the proxy. There are no automatic retries, redirects or direct fallback.

### If Docker fails to start or build

Check the configuration and build separately:

```sh
docker compose config --quiet
docker compose build
```

An `input/output error` mentioning `/var/lib/docker/buildkit/containerdmeta.db`
or `/var/lib/docker/overlay2` indicates a Docker storage failure. It occurs before
the application starts; changing proxy settings will not resolve it. Check free
space on the host and Docker Desktop's disk usage. Free space from known,
unneeded files, then restart Docker Desktop when interrupting other containers is
acceptable and retry the build. If the error persists, investigate Docker
Desktop diagnostics before resetting its storage.

Do not use a factory reset, `docker system prune --volumes` or
`docker compose down --volumes` as a routine fix: they can delete persistent data,
including Tor state. The image build remains unverified while Docker storage is
failing; see [VALIDATION.md](VALIDATION.md).

The default Compose project keeps the `tor-rotator` name, port and Tor state
volume. To run alongside Radar, use another project and port:

```sh
HOST_PROXY_PORT=5567 docker compose -p tor-rotator-standalone up --build -d
```

Only the proxy is published, on loopback. The SOCKS port stays internal.
`docker compose down` stops the service without deleting its Tor state.

For native execution, use Node 22.18+ and an existing Tor SOCKS service:

```sh
nvm use
corepack yarn install --immutable
corepack yarn build
corepack yarn start
```

## Configuration and rotation

`src/config.ts` exports the configuration object. Its type is inferred with
`typeof config`; startup passes the object directly:

```ts
import { config } from "./config.ts";
import { createProxy } from "./server.ts";

const proxy = createProxy(config);
```

The two endpoint settings below are read once when the module loads. Set them
before starting Node; changing the environment afterward does not reload config.

| Variable          | Default          | Purpose                                     |
| ----------------- | ---------------- | ------------------------------------------- |
| `PROXY_BIND`      | `127.0.0.1:5566` | Listening address                           |
| `TOR_SOCKS_ADDRS` | `127.0.0.1:9050` | Tor SOCKS endpoints, comma-separated (1–16) |

Copy `.env.example` to `.env` for Compose. Native Node loads it only with
`node --env-file=.env dist/main.js` after building.

Each new connection takes the next internal SOCKS identity and Tor endpoint.
There are sixteen identities per endpoint, renewed on a staggered five-minute
cycle. Destination DNS goes through Tor. An existing HTTPS tunnel keeps its
connection; fresh requests on that tunnel do not rotate it.
**Different identities or Tor instances can still share the same exit IP.**

Fixed transport limits live in `src/config.ts`: 256 clients, 30 seconds to connect,
60 seconds idle, ten minutes per stream and ten seconds for headers or shutdown.
These bounds protect stuck connections without adding configuration knobs.
There is no request tracing, admin API or monitoring service.

Application headers pass through unchanged, except for connection-specific
HTTP headers and proxy authentication. Invalid requests, admission refusals and
upstream failures close the client connection without a custom HTTP error body
or status. Origin HTTP responses, including errors, are forwarded unchanged.

## Probe and benchmark

Start the proxy and wait for Tor first. The probe needs Bash and curl 8.4+;
there is no Node.js or jq requirement for the probe alone:

```sh
bash script/ip-probe.sh
bash script/ip-probe.sh http://127.0.0.1:5567
```

It prints the endpoint's JSON body, followed by the HTTP and CONNECT status codes
on one line. It fails on HTTP errors. The benchmark also checks `IsTor` and the IP
address before counting a response as successful.

The benchmark needs Node 22.18+ and uses the same Bash probe:

```sh
corepack yarn benchmark --duration 60s --requestsPerSecond 1
```

Use `--proxy http://127.0.0.1:5567` for another proxy. The script does not create
containers or change services. Each probe opens a fresh connection to
`https://check.torproject.org/api/ip`, with a thirty-second deadline, a bounded
response and no retries or redirects. TLS verification stays enabled. curl's
configuration file and `NO_PROXY` cannot silently bypass the requested proxy.

The JSON summary reports sent, successful and failed requests, distinct exit IPs,
and mean/P50/P95/P99 latency in milliseconds. Latency covers the probe process,
CONNECT, TLS and the full response; only successful Tor IP responses contribute.
With no successes, latencies are `null`. One curl process per request adds local
overhead, so this is a modest-rate Tor check, not a proxy throughput measurement.

Requests start at the requested rate without waiting for previous responses.
`sentRps` measures starts during the sending window; `completedRps` includes the
time waiting for the final responses. A 403 or 429 stops new requests. Ctrl+C
cancels pending probes and prints the partial result.

The probe uses [curl](https://curl.se/docs/manpage.html) for CONNECT, TLS and
transfer deadlines. The benchmark stays in TypeScript because scheduling,
cancellation and percentile calculations are clearer there than in shell jobs
and text-processing pipelines. Neither script is included in the runtime image.

## Files and development

```text
src/
  main.ts       Start and stop the server
  config.ts     Two environment inputs and fixed transport limits
  server.ts     Server events, admission, cancellation and shutdown
  proxy.ts      HTTP/CONNECT validation, forwarding and stream deadlines
  tor.ts        Internal rotation and authenticated SOCKS connections
script/
  benchmark.ts  Request rate and latency summary for a running proxy
  ip-probe.sh   One HTTPS exit-IP request using curl
```

```sh
corepack yarn format
corepack yarn lint
corepack yarn check
corepack yarn build
```

`build` compiles only `src/` to JavaScript in `dist/` using `tsconfig.build.json`.
`start` and the production Docker image run `dist/main.js`; build before starting.
Development (`yarn dev`), tests and the benchmark still run TypeScript directly.
The IP probe uses Bash and curl; lint includes a Bash syntax check.
`typecheck` checks sources, tests and scripts without emitting files. Tests use
four integration scenarios with a local fake SOCKS server: HTTP, CONNECT, session
rotation and recovery after refusal. No public traffic or running Tor is needed.
The suite intentionally omits exhaustive timeout/concurrency and benchmark tests.

`docker build --target check .` runs the checks in Linux. The default Docker build
produces the production image independently, without running checks. Before
publishing, require both checks and the production build to pass on the same commit.
See [VALIDATION.md](VALIDATION.md) for the checks actually performed.
