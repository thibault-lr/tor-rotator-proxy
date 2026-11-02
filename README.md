# Tor Rotator Proxy

An HTTP/HTTPS proxy for scrapers, backed by Tor. Use your client's normal proxy
setting; Tor Rotator Proxy handles SOCKS session rotation and remote DNS internally.
HTTPS uses CONNECT: TLS stays between your client and the destination.

Runs as two containers managed by Docker Compose: [the proxy](https://hub.docker.com/r/tleroy13/tor-rotator)
and [Tor](https://hub.docker.com/r/tleroy13/tor-rotator-tor). Images support Linux
AMD64 and ARM64.

## Use in your scraper project

Download [compose.images.yaml](https://github.com/thibault-lr/tor-rotator-proxy/releases/download/v0.2.0/compose.images.yaml)
into your project. Requires Docker Compose 2.20.3+.

Add to your project's `.env`:

```dotenv
TOR_ROTATOR_IMAGE=tleroy13/tor-rotator
TOR_ROTATOR_VERSION=0.2.0
```

Include it in your `compose.yaml`, alongside your scraper:

```yaml
include:
  - compose.images.yaml

services:
  scraper:
    build: .
    environment:
      HTTP_PROXY: http://tor-rotator:5566
      HTTPS_PROXY: http://tor-rotator:5566
```

Start the proxy services:

```sh
docker compose up -d tor tor-rotator
docker compose logs -f tor
```

Wait for `Bootstrapped 100%`, then press Ctrl+C to leave the logs and start your
scraper with `docker compose run --rm scraper`. Containers stay running.

The scraper must share the default Compose network. If its HTTP client ignores
proxy environment variables, set **`http://tor-rotator:5566`** in the client's
proxy option directly. No SDK or session headers are needed.

## Behavior and limits

- Rotation happens per connection. Reusing an HTTPS tunnel keeps its connection.
  **A new session does not guarantee a different exit IP.**
- Tor can be slow or fail. The proxy has no retries or direct Internet fallback;
  timeouts, retries and request rates belong to your scraper.
- Limits: 256 connections, 30 seconds to connect, 60 seconds idle and ten minutes
  per stream. Clients must reconnect after the stream lifetime expires.
- The proxy has no client authentication. Keep it on a private application
  network; the supplied Compose file publishes no host ports.

## Benchmark

A 60-second run at one request/second completed **59/60 requests**, with
**20 distinct exit IPs**. Successful latency: **P50 1.28 s / P95 4.59 s**.

| Container | Mean / peak CPU |   Mean / peak RAM |
| --------- | --------------: | ----------------: |
| Proxy     |   0.97% / 3.19% | 29.28 / 30.39 MiB |
| Tor       |  1.49% / 10.36% | 15.90 / 16.17 MiB |

Measured on Apple M2 with Docker's Linux ARM64 VM on October 30, 2026. CPU 100%
means one logical CPU. This is a small Tor network test, not a capacity or
reliability guarantee. [Full report, raw data and reproduction steps](BENCHMARK.md).

## Run from source

From this repository, `docker compose up --build -d` starts both services and
exposes the proxy at `http://127.0.0.1:5566`. Wait for Tor bootstrap as above.
Then check it with `bash script/ip-probe.sh` (requires curl 8.4+).

For development with Node 22.18+ and Corepack:

```sh
corepack yarn install --immutable
corepack yarn check
corepack yarn build
```

Four integration scenarios cover HTTP forwarding, CONNECT transfer, session
rotation and recovery after a Tor refusal. [Validation history](VALIDATION.md).

## License

[MIT](LICENSE). Third-party components retain their own licenses.
