# Tor Rotator Proxy

An HTTP/HTTPS proxy for scrapers, with Tor included in one Docker image.
Use your client's normal proxy setting; session rotation and destination DNS
are handled internally. HTTPS uses CONNECT, without intercepting TLS.

[Docker Hub](https://hub.docker.com/r/leroythib0/tor-rotator-proxy) · Linux AMD64 / ARM64

## Quick start

```sh
docker run -d --name tor-rotator --stop-timeout 20 \
  -p 127.0.0.1:5566:5566 -v tor-data:/var/lib/tor \
  leroythib0/tor-rotator-proxy:0.3.0
docker logs -f tor-rotator
```

Wait for `Bootstrapped 100%`, then press Ctrl+C to leave the logs. The container
keeps running. Your proxy is **`http://127.0.0.1:5566`**:

```sh
curl --proxy http://127.0.0.1:5566 --noproxy '' https://check.torproject.org/api/ip
```

## Use in a scraper project

Add the proxy alongside your scraper in `compose.yaml`:

```yaml
services:
  tor-rotator:
    image: leroythib0/tor-rotator-proxy:0.3.0
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stop_grace_period: 20s
    volumes:
      - tor-data:/var/lib/tor

  scraper:
    build: .
    environment:
      HTTP_PROXY: http://tor-rotator:5566
      HTTPS_PROXY: http://tor-rotator:5566

volumes:
  tor-data:
```

Run `docker compose up -d tor-rotator`, wait for Tor bootstrap in
`docker compose logs -f tor-rotator`, then run `docker compose run --rm scraper`.
Both services share the default Compose network; no proxy port needs publishing.
If your client ignores proxy environment variables, set
**`http://tor-rotator:5566`** in its proxy option directly.

## Behavior and limits

- Rotation happens per connection. Reusing an HTTPS tunnel keeps its connection.
  **A new session does not guarantee a different exit IP.**
- Tor can be slow or fail. The proxy has no retries or direct Internet fallback;
  timeouts, retries and request rates belong to your scraper.
- Limits: 256 connections, 30 seconds to connect, 60 seconds idle and ten minutes
  per stream. Clients must reconnect after the stream lifetime expires.
- The container runs without root. Tor's SOCKS port is local to the container.
  The HTTP proxy has no client authentication: keep access private.
- If Node or Tor exits, the container stops. Keep the Tor data volume across
  restarts. When upgrading from `0.2.0`, stop the old deployment first, preserve
  its volume, and replace its two services with the single service above.

## Benchmark

The `0.2.0` two-container deployment completed **59/60 requests** at one
request/second, with **20 distinct exit IPs**. Successful latency:
**P50 1.28 s / P95 4.59 s**.

| Container | Mean / peak CPU |   Mean / peak RAM |
| --------- | --------------: | ----------------: |
| Proxy     |   0.97% / 3.19% | 29.28 / 30.39 MiB |
| Tor       |  1.49% / 10.36% | 15.90 / 16.17 MiB |

Measured on Apple M2 on October 30, 2026; CPU 100% means one logical CPU.
These are historical measurements, not a benchmark of the combined `0.3.0` image
or a capacity guarantee. [Full report and reproduction steps](BENCHMARK.md).

## Development

From this repository, `docker compose up --build -d` exposes the proxy at
`http://127.0.0.1:5566`. For Node 22.18+ with Corepack:

```sh
corepack yarn install --immutable
corepack yarn check
corepack yarn build
```

Four integration scenarios cover HTTP, CONNECT, session rotation and recovery
from a Tor refusal. CI also checks container shutdown and process failures.
[Validation history](VALIDATION.md).

## License

[MIT](LICENSE). Third-party components retain their own licenses.
