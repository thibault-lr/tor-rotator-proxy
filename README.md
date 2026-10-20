# Tor Rotator

A small HTTP proxy that sends requests through Tor and rotates SOCKS identities
internally. Clients use their usual HTTP proxy setting; no SDK or special headers.
HTTPS uses CONNECT, keeping TLS between the client and the destination.
The only runtime dependency is `socks`.

## Use it

Run these commands from this directory with Docker Desktop running and available
disk space. The optional `.env` file is not required for the defaults.

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

`src/config.ts` exports a constant object checked with `satisfies Config`.
`Config` is the input type of the proxy; startup passes the object directly:

```ts
import { config } from "./config.ts";
import { createProxy } from "./proxy.ts";

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

The former `X-Tor-Session` and `X-Radar-*` controls are ignored and are not returned
in proxy responses. They are stripped from plain HTTP requests before forwarding.
Clients that used them should now use only the standard proxy setting.

## Benchmark

With Docker running:

```sh
corepack yarn benchmark --instances 1,2,4 --duration 60s --requestsPerSecond 1
```

Each case starts the requested number of **separate Tor containers** and one
proxy, waits up to five minutes for Tor bootstrap, then requests
`https://check.torproject.org/api/ip` through fresh proxy tunnels. Cases run
sequentially. The output shows:

- Tor instance count.
- Mean and peak sampled CPU and memory for Tor plus the proxy.
- Distinct exit IPs, successful/failed requests and resource sample count.

Only three options exist: unique instance counts from 1 to 16, a duration from
5s to 3600s, and a request rate above zero up to 5 per second. At most eight
requests run at once, with a fixed 30-second timeout. A 403 or 429 stops new
requests and later cases; requests already in flight finish. No retry or redirect
is performed. The old `benchmark:load` command has been removed.

Results are saved in `.run/benchmarks/tor-bench-*/results.json`, including IPs,
request outcomes, unsent requests, container identities and resource samples.
Missing measurements remain unknown. Each case uses its own Compose project,
ephemeral loopback port and temporary Tor volumes. It cleans up only those
resources, including on Ctrl+C; reports and built images remain. Existing Radar
services and volumes are not used.

Resources come from `docker stats` during requests and draining, after bootstrap.
CPU uses Docker's percentage convention (100% is one core); memory is the CLI's
working-set estimate. Peaks can miss spikes between samples. Measurements exclude
bootstrap, the benchmark client and Docker VM overhead. IP counts depend on the
Tor network and the test duration; they are not a uniqueness guarantee.

## Files and development

```text
src/
  main.ts       Start and stop the server
  config.ts     Two environment inputs and fixed transport limits
  proxy.ts      HTTP/CONNECT forwarding and connection cleanup
  tor.ts        Internal rotation and authenticated SOCKS connections
  timeouts.ts   Idle and lifetime deadlines
script/
  benchmark.ts  Docker instance comparison and resource measurements
  ip-probe.ts   One HTTPS exit-IP request through the proxy
```

```sh
corepack yarn format
corepack yarn lint
corepack yarn check
corepack yarn build
```

`build` compiles only `src/` to JavaScript in `dist/` using `tsconfig.build.json`.
`start` and the production Docker image run `dist/main.js`; build before starting.
Development (`yarn dev`), tests and benchmark scripts still run TypeScript directly.
`typecheck` checks sources, tests and scripts without emitting files. Tests use
loopback sockets, fake SOCKS endpoints and a fake Docker CLI without public traffic.

`docker build --target check .` runs the checks in Linux. The default Docker build
produces the production image independently, without running checks. Before
publishing, require both checks and the production build to pass on the same commit.
See [VALIDATION.md](VALIDATION.md) for the checks actually performed.
