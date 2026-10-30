# Tor Rotator

A reusable HTTP proxy for scrapers. Clients use their normal proxy setting;
Tor Rotator sends traffic through Tor and rotates SOCKS identities internally.
HTTPS uses CONNECT, keeping TLS between the client and the destination.

The deployment has two containers: the Node.js proxy and Tor. The proxy image
contains only the compiled runtime and its one production dependency, `socks`.
There is no SDK, admin API, background IP probe or client-controlled session.

## Try it locally

With Docker running, build and start from this directory:

```sh
docker compose up --build -d
docker compose logs -f tor
```

Wait for `Bootstrapped 100%`, then press Ctrl+C to leave the log stream.
The containers keep running. Check the proxy:

```sh
curl --proxy http://127.0.0.1:5566 --noproxy '' https://check.torproject.org/api/ip
```

The local Compose file publishes only the proxy, on loopback. To choose another
host port, set `HOST_PROXY_PORT=5567` in `.env` or before the Compose command.
The existing project name and `tor-data` volume are preserved.
`docker compose down` stops the services without deleting Tor state.

## Use it in a scraper project

After publishing a release, copy `compose.images.yaml` into the scraper project.
Set these values in that project's `.env`, using your actual repository and a
published version. These image names are placeholders, not existing releases:

```dotenv
TOR_ROTATOR_IMAGE=ghcr.io/your-account/tor-rotator
TOR_ROTATOR_VERSION=0.2.0
```

Include the file from your application's `compose.yaml` (Compose 2.20.3+):

```yaml
include:
  - compose.images.yaml

services:
  scraper:
    build: .
    environment:
      HTTP_PROXY: http://tor-rotator:5566
      HTTPS_PROXY: http://tor-rotator:5566
    depends_on:
      - tor-rotator
```

Start the proxy services and wait for Tor before starting a scrape:

```sh
docker compose up -d tor tor-rotator
docker compose logs -f tor
# After Bootstrapped 100%, leave the log stream with Ctrl+C.
docker compose run --rm scraper
```

The reusable Compose file publishes no host ports. The scraper reaches
`http://tor-rotator:5566` on the application's default network. Tor has a separate
network shared only with the proxy; its SOCKS port is not on the scraper network.
Both images run without root and keep their root filesystem read-only.
The Tor network retains Internet access for connecting to Tor relays.

`depends_on` orders container startup; it does not wait for Tor bootstrap.
Requests can fail until Tor is ready. Client timeouts, retries, cookies and request
rates belong to the scraper. There is no retry or direct fallback in the proxy.

Not every HTTP client honors proxy environment variables. Use the client's own
proxy option when necessary. For example, Python's standard library:

```python
import urllib.request

proxy = "http://tor-rotator:5566"
client = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": proxy, "https": proxy})
)
with client.open("https://example.com", timeout=30) as response:
    print(response.read().decode())
```

Or an existing Playwright project:

```js
import { chromium } from "playwright";

const browser = await chromium.launch({
  proxy: { server: "http://tor-rotator:5566" },
});
try {
  const page = await browser.newPage();
  await page.goto("https://example.com");
  console.log(await page.title());
} finally {
  await browser.close();
}
```

Use `http://127.0.0.1:5566` instead when the scraper runs on your host against the
local Compose deployment. See the official [Compose networking guide](https://docs.docker.com/compose/how-tos/networking/)
and [Playwright proxy options](https://playwright.dev/docs/network#http-proxy).

## Rotation and configuration

Each new connection takes the next internal SOCKS identity and Tor endpoint.
There are sixteen identities per endpoint, renewed on a staggered five-minute
cycle. Destination DNS goes through Tor. **A new session does not guarantee a
new exit IP.** An existing HTTPS tunnel keeps its connection, so several requests
on the same tunnel can use the same exit. Rotation is per connection, not per
page or request made inside a reused tunnel.

Application headers pass through, except for connection-specific HTTP headers
and proxy authentication. Origin statuses, headers and bodies are forwarded,
including errors such as 429. Invalid requests, admission refusals and upstream
failures close the client connection without a custom HTTP error response.

`src/config.ts` exports the configuration object; its type is inferred with
`typeof config`. These settings are read once at startup:

| Variable          | Native default   | Purpose                             |
| ----------------- | ---------------- | ----------------------------------- |
| `PROXY_BIND`      | `127.0.0.1:5566` | Listening address                   |
| `TOR_SOCKS_ADDRS` | `127.0.0.1:9050` | Comma-separated Tor SOCKS endpoints |

Use valid `host:port` values, with brackets around IPv6 hosts. Configuration is
operator-controlled; the parser does not perform exhaustive validation. Compose
sets these addresses for its own network. `HOST_PROXY_PORT` affects only the
local Compose host mapping.

Fixed limits remain in `src/config.ts`: 256 clients, 30 seconds to connect,
60 seconds idle, ten minutes per stream and ten seconds for headers or shutdown.
HTTPS connections longer than ten minutes must reconnect. The proxy has no
client authentication; keep access limited to your local or application network.

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

To include Docker resources, supply the names of the running proxy and Tor
containers. Find them with `docker compose ps`:

```sh
corepack yarn benchmark --duration 60s --requestsPerSecond 1 \
  --containers tor-rotator-proxy-1,tor-rotator-tor-1 > benchmark.json
```

The optional `docker` summary reports mean/peak CPU, mean/peak memory in MiB,
received/sent network MiB and peak process/thread count per container. Sampling
uses `docker stats` during sending and draining, with a baseline before requests
and a final sample afterward. Its setup and final sample are excluded from
request throughput and latency. `complete: false` means samples are missing;
missing measurements are never reported as zero. No containers are created or
restarted. Without `--containers`, Docker is not required.

CPU is Docker's percentage (100% is one logical CPU). Memory follows the Docker
CLI's cache-adjusted accounting. Mean/peak values are sampled, so short spikes
can be missed. Network deltas use rounded Docker counters and include Tor's own
traffic as well as the proxy workload; they are not HTTP payload sizes. The
client process and Docker VM overhead are outside these container measurements.
See [Docker statistics](https://docs.docker.com/reference/cli/docker/container/stats/).

The probe uses [curl](https://curl.se/docs/manpage.html) for CONNECT, TLS and
transfer deadlines. The benchmark stays in TypeScript because scheduling,
cancellation and percentile calculations are clearer there than in shell jobs
and text-processing pipelines. Neither script is included in the runtime image.

## Development

Native execution needs Node 22.18+ and an existing Tor SOCKS service:

```sh
nvm use
corepack yarn install --immutable
corepack yarn format
corepack yarn lint
corepack yarn check
corepack yarn build
corepack yarn start
```

Native Node loads `.env` only when explicitly passed, for example
`node --env-file=.env dist/main.js`. `yarn dev` runs the TypeScript entry point
with file watching. `build` compiles only `src/` to `dist/`; `typecheck` also checks
tests and the benchmark. `lint` includes a Bash syntax check.

```text
src/
  main.ts       Startup and process signals
  config.ts     Endpoint settings and fixed limits
  server.ts     Server events, admission, cancellation and shutdown
  proxy.ts      HTTP/CONNECT forwarding, validation and stream deadlines
  tor.ts        Session rotation and authenticated SOCKS connections
script/
  ip-probe.sh   One exit-IP request using curl
  benchmark.ts  Request scheduling and summary statistics
  docker-stats.ts  Optional container resource measurements
```

Four integration scenarios use real local sockets and a shared fake SOCKS server:
HTTP forwarding, CONNECT transfer, session rotation and recovery after refusal.
They need neither Tor nor public traffic. The HTTP scenario also checks remote
DNS, raw-path preservation, application headers and proxy-auth removal.
The suite intentionally omits exhaustive protocol matrices and benchmark tests.

## Publish Docker images

The GitHub Actions workflow checks pull requests and pushes to `main`. It runs
`docker build --target check .` and builds both production images for Linux AMD64
and ARM64. The check stage runs without network access after dependencies have
been installed. Production builds remain independent of that stage.

Publishing a GitHub release such as `v0.2.0` reruns these checks and builds on the
release commit. Only after success does it publish these images with
`GITHUB_TOKEN`:

```text
ghcr.io/<owner>/<repository>:0.2.0
ghcr.io/<owner>/<repository>-tor:0.2.0
```

The workflow uses version tags rather than `latest`. Allow Actions to publish
packages and set the GHCR packages to public if consumers should pull without
logging in. Until a release is published, use the local source Compose file.
See [GitHub's image publishing guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).

For local image verification:

```sh
docker compose config --quiet
docker build --target check .
docker compose build
```

If Docker reports storage or daemon errors before running the build, fix the
Docker installation first. Do not remove volumes to troubleshoot a build.
Actual evidence and remaining limitations are recorded in [VALIDATION.md](VALIDATION.md).
