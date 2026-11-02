# Validation

## November 2, 2026 — package and image naming

Renamed the package and Yarn workspace to `tor-rotator-proxy`. The release
workflow now targets `<DOCKERHUB_USERNAME>/tor-rotator-proxy`; the repository's
Actions variable is set to `leroythib0`. Dependency versions, runtime behavior,
Compose service names and existing volumes are unchanged.

Immutable Yarn installation, format, lint, check (four tests) and build pass.
This naming change does not republish images or move the existing `v0.2.0` tag.
The README's image references still point to the published `0.2.0` images.

## November 2, 2026 — public release

Published the existing 18-commit history to GitHub after checking Git integrity,
whitespace and historical files. Gitleaks scanned all 18 commits without finding
secrets. Native check (four tests) and build passed before the initial push.

Release [v0.2.0](https://github.com/thibault-lr/tor-rotator/releases/tag/v0.2.0)
targets commit `42e4d29331d2164fd019881fd75161a2f6a84b62`. Its
[GitHub Actions run](https://github.com/thibault-lr/tor-rotator/actions/runs/41482466885)
passed Compose validation, checks and production builds for Linux AMD64 and
ARM64, then published both versioned images to Docker Hub. The reusable Compose
file is attached to the release.

Unauthenticated Docker Hub API requests confirmed both repositories are public
and both `0.2.0` tags contain Linux AMD64 and ARM64 images:

```text
tleroy13/tor-rotator:0.2.0
sha256:2ed69cadc061dd2ca47bbd93d420aa94f240741013f46b000c5c0eb444d8e637
tleroy13/tor-rotator-tor:0.2.0
sha256:d10c9c0c90d3e0264042cfbcae588f40f339c822a7d3160b0b61552fb8ec7a42
```

The README now focuses on consuming these images, proxy behavior and the measured
benchmark. No runtime code changed. Public Tor measurements were not repeated
for this release, and no existing proxy, live configuration or volume changed.

## October 30, 2026 — MIT license

Added the MIT license at the owner's request, with copyright attributed to
Thibault Leroy using the repository's existing Git author identity. package.json
now declares MIT, and README links to LICENSE. Third-party licenses are unchanged.

The proxy image includes /app/LICENSE and an MIT OCI license label. The Tor image
includes the project license at /usr/share/doc/tor-rotator/LICENSE alongside its
existing third-party license notices. Both embedded copies were compared byte
for byte with the repository file; proxy package metadata and the OCI label were
also verified.

Native format, lint, check (four tests) and build pass. The Docker check target
and both production images build successfully for Linux ARM64. No runtime code
changed; AMD64 builds and live Tor measurements were not repeated for this
licensing change. No service was restarted and no image or Git commit was pushed.

## October 30, 2026 — Docker builds, live Tor and resource benchmark

Docker Desktop is available again. Checks and production builds pass for both
Linux ARM64 and Linux AMD64 on Docker Engine 25.0.3. Each `check` target runs the
four integration scenarios, lint, formatting and type checking with networking
disabled. Production builds remain independent of checks. The AMD64 production
runtime also starts and stops without network access under Docker's emulation;
physical AMD64 hardware was not used.

The four permanent scenarios now include application headers and origin errors,
a 256 KiB binary CONNECT transfer with half-close, upstream closure after client
cancellation, SOCKS identity reuse and expiry, and recovery after Tor refusal.
No production counters, monitoring endpoint or extra runtime dependency was
added. Native format, lint, lint:fix, check and build pass under Node 22.22.1 and
Yarn 4.18.1. Reordered the Bash syntax check before Oxlint so lint:fix still sends
its --fix argument to the linter.

Started the reusable image deployment in the isolated
`tor-rotator-validation-wbn4no` project, with its own volume and networks. A
loopback port was allocated only by a temporary test override. Tor 0.4.9.11
reached Bootstrapped 100%. Both services ran without root and with read-only root
filesystems. The Node runtime in the image is 24.22.2.

A separate Python 3.13 client container received the expected HTTP 200 body
from example.com and an HTTPS 200 response with IsTor=true from the Tor check
endpoint, using its standard proxy configuration and TLS verification. One
initial Python HTTPS attempt failed during the TLS handshake; its root cause
was not isolated. A repeat and a later check against the final image both passed.
The proxy was recreated only inside this task's isolated project to test the
final built image. No pre-existing service or volume was modified.

The first 10-second smoke benchmark completed 10/10 requests with nine distinct
exit IPs. The subsequent 60-second run at one request/second completed 59/60
successfully with 20 distinct exits. Its unsuccessful request was kept in the
report; no retries were used. The benchmark exited with code 1 as expected for
a failed request. CPU, memory, network and process/thread measurements completed
with 40 Docker samples over 79.8 seconds, around the 77.56-second request/drain
window. See [BENCHMARK.md](BENCHMARK.md) and the committed
[raw JSON](benchmarks/2026-10-30.json) for the full results and reproduction steps.

Docker measurements are optional and live only in the benchmark helper.
Temporary local self-checks verified unit conversion, sample averages and peaks,
network deltas, missing-container refusal, an explicit incomplete-sampling
result, and cancellation while collecting Docker statistics. The latter also
verified that probe child processes exited and that resource collection did not
inflate request timing. The local HTTPS fixture still passes the probe's size
bound, non-Tor response handling, 403/429 stop and socket cancellation checks.

The release workflow now targets Docker Hub. actionlint 1.7.12 accepts it.
Publication requires a GitHub repository, the DOCKERHUB_USERNAME Actions variable
and DOCKERHUB_TOKEN secret, plus a release tag. These account settings and an
actual registry push have not been exercised. No license has been selected yet.

Both test services exited with code 0, without OOM termination. Their containers
and networks were removed; the task's Tor state volume was retained. Existing
services, Docker settings and volumes were preserved. The changes were split
into focused local commits; no remote push or release was performed.

These results establish local builds and standard HTTP/HTTPS operation, not
maximum capacity, browser compatibility in every client, or failure-free Tor
access. The benchmark has a failed request and an earlier TLS failure remains
unexplained. Session isolation does not guarantee a unique exit IP.

## October 28, 2026 — reusable scraper deployment

Prepared a separate `compose.images.yaml` for consuming versioned images from
scraper projects. It exposes `http://tor-rotator:5566` on the application network,
keeps Tor on a separate network shared with the proxy, and publishes no host
ports. The original local Compose file, Dockerfiles, Tor configuration, defaults
and persistent-volume setup are unchanged.

Added a GitHub Actions workflow to check and build the proxy and Tor images for
Linux AMD64 and ARM64. Release publication depends on successful checks and
production builds for that commit. Actions are pinned to upstream commit hashes.
The workflow is prepared but has not run on GitHub; no images have been published.

Replaced the 138-line TypeScript HTTPS probe with a 15-line Bash/curl script.
The benchmark keeps scheduling, response validation and summary statistics in
TypeScript. Together the scripts now have 184 lines instead of 271. The probe
ignores curlrc and NO_PROXY, keeps TLS verification, bounds responses and transfer
time, and uses a fresh connection per request. It needs curl 8.4+ and Bash; no npm
or runtime dependency was added. Latency now includes curl process startup;
its overhead differs from the former in-process probe.

The four integration scenarios remain. The HTTP scenario additionally verifies
remote DNS, raw-path preservation, application headers, proxy-auth removal and
unchanged origin 429 responses. Startup uses a direct main call and a fixed
failure message instead of logging a raw error. Endpoint parsing remains simple,
with valid operator-supplied addresses assumed as requested.

Verification on Node 22.22.1, Yarn 4.18.1 and curl 8.4.0:

- Format, lint (including Bash syntax), strict type checking, all four native
  socket integration tests and the compiled JavaScript build pass.
- A temporary local HTTPS/CONNECT fixture exercised the actual Bash probe and
  benchmark. At 20 requests/second for 0.4 seconds, all eight requests succeeded;
  delayed responses overlapped and contributed to the latency summary. Non-Tor
  responses, oversized bodies, origin 429 and proxy CONNECT 403 were accounted
  for correctly. SIGINT produced a partial summary and closed the real sockets.
  Only a temporary certificate was trusted through CURL_CA_BUNDLE for those
  processes; TLS verification stayed enabled and no public host was contacted.
- Compiled startup and SIGTERM shutdown pass. Binding an occupied port exits with
  code 1 and only the fixed failure message.
- Both Compose files validate with Docker Compose 2.24.5. A temporary scraper
  Compose file using include also validates. Its rendered configuration has the
  expected image names, no published ports and separate scraper/Tor networks.
- actionlint 1.7.12 accepts the workflow. External ShellCheck and Pyflakes
  integration were disabled for that check; Bash syntax is checked separately.
- `git diff --check` passes.

`docker build --target check .` and `docker compose build` were attempted but
cannot connect to the stopped Docker daemon. Fresh images, cross-architecture
execution, real Tor bootstrap and public exit-IP diversity remain unverified.
No existing container was started or restarted, no live configuration or volume
was changed, and no push or release was performed. No Git remote is configured;
a project license has not yet been selected.

The focused suite does not exhaustively test transport edge cases. Each HTTPS
tunnel keeps its Tor connection, and different SOCKS identities can share an
exit IP. The benchmark is a modest-rate diagnostic, not a throughput benchmark.
Earlier entries below are historical evidence for earlier versions.

## October 21, 2026 — four smoke tests and a standalone load script

Reduced the permanent suite to four integration tests: HTTP forwarding, CONNECT
transfer, SOCKS credential rotation and recovery after a Tor refusal. They use
the real proxy/server and one shared local fake SOCKS fixture. Removed the
protocol/lifecycle matrices and benchmark tests, including the configuration
and probe test files already deleted in the working tree. Runtime sources are
unchanged. The earlier endpoint-whitespace and invalid-endpoint configuration
issues are not fixed; their tests are no longer in this deliberately small suite.

The benchmark now targets an existing local proxy and accepts duration and
requests-per-second settings. It prints success/failure counts, achieved rates,
distinct IPs and successful-response mean/P50/P95/P99 latency. Measurement includes
CONNECT, TLS and full response reading. Removed container creation, resource
sampling and persisted reports. The existing bounded HTTPS probe is reused.

Format, lint, strict type checking and the JavaScript build pass under Node
22.22.1. Native yarn check reaches the four socket tests, then hits the sandbox's
loopback listen restriction. All four pass under Node 24.22.0 in the existing
local Docker image with external networking disabled and the repository mounted
read-only.

An additional temporary HTTPS fixture verified the actual benchmark CLI at
20 requests/second for one second: 20 sent and successful, with delayed responses
reflected in mean/P95/P99. Mixed failures, no successful samples, HTTP 429 stop,
SIGINT cancellation and invalid rate input also pass. The fixture used a local
certificate trusted only by the child process; no public host was contacted.
No fresh image build, live Tor load, deployment or push was performed. Timeout,
concurrency, header-filtering and configuration edge cases no longer have
exhaustive automated coverage.

## October 21, 2026 — trust internal rotation inputs

Removed the session-count/TTL guard and its invalid-argument test. The runtime
caller supplies sixteen sessions per configured endpoint and a fixed 300_000 ms
TTL. The helper no longer enforces its former 256-session cap; endpoint-input
validation remains part of the known configuration gap. Renewal and reuse tests
remain unchanged and pass.

Format, lint, strict type checking and JavaScript build pass. The isolated
Node 24.22.0 Docker suite passes 35 of 37 tests, with the same two configuration
failures. Native yarn check still encounters those failures and the sandbox's
loopback restriction. No fresh image build, public Tor request, deployment or
push was performed.

## October 21, 2026 — minimal request failure handling

Removed custom HTTP error responses, timeout error classification and the
duplicated Config type. Configuration consumers infer typeof config; Target
lives with the Tor connection function and src/types.ts is removed. Request
failures now close the client connection through one server catch boundary.
SOCKS cleanup, cancellation, deadlines and destination validation remain.

Removed project-specific and tracing-header filtering. Application headers now
pass through; stripHopHeaders retains only connection/proxy header filtering
and has a short explanation. Updated failure assertions to expect closure and
added a regression proving a failed SOCKS or malformed upstream HTTP response
does not prevent the next HTTP request from succeeding. Origin HTTP statuses
and bodies remain forwarded. Runtime source is 144 lines shorter.

Format, lint, strict type checking and JavaScript build pass under Node 22.22.1.
The isolated Node 24.22.0 Docker suite passes 36 of 38 tests. Only the known
configuration regressions fail: endpoint whitespace and invalid-endpoint
rejection. Native yarn check passes static checks but fails those tests and
30 socket tests because loopback listen is denied by the execution sandbox.
Compiled JavaScript starts, closes two invalid requests without crashing and
exits cleanly on SIGTERM with no TypeScript sources mounted. Removed the stale
generated dist/types.js. No fresh production image build, public Tor request,
deployment or push was performed.

## October 21, 2026 — stream deadlines beside proxy handling

Moved setConnectionTimeouts unchanged into src/proxy.ts and removed
src/timeouts.ts. Both upstream and client sockets use the same helper;
server.ts imports it from proxy.ts. Updated the file map and engineering rule.

Format, lint, strict type checking and JavaScript build pass under Node 22.22.1.
The complete isolated Docker socket suite passes 35 of 37 tests, including
blocked HTTP/CONNECT idle deadlines and maximum lifetime under ongoing traffic.
Only the two known configuration regressions fail. Native yarn check still
hits the sandbox's loopback restriction in addition to those configuration
failures. Verified the moved function is identical and removed the obsolete
generated dist/timeouts.js. No fresh Docker image build, public Tor request,
deployment or push was performed for this move.

## October 21, 2026 — server and proxy separation

Moved createProxy and connection lifecycle management into src/server.ts. It
owns admission, header deadlines, cancellation, pending work and graceful
shutdown. src/proxy.ts retains request validation, Tor connection opening and
HTTP/CONNECT forwarding. Handlers receive configuration, session selection,
an AbortSignal and a close callback; connection registries remain private to
server.ts. Shared Config and Target types now live in src/types.ts. Updated
startup, the socket harness, README and engineering rules for the new boundary.

The factory still returns server and stop. Existing protocol parsing, Tor
isolation, streaming, half-close behavior and timeout values are preserved.
Added one socket regression covering both HTTP and CONNECT first requests on
connections accepted before shutdown: each receives 503 without contacting SOCKS.

Format, lint, strict type checking and the JavaScript build pass under Node
22.22.1. The complete suite passes 35 of 37 tests under Node 24.22.0 in an
existing local Docker image with networking disabled and source mounted
read-only. The new shutdown regression passes. Only the two previously recorded
configuration tests fail (endpoint whitespace and invalid-endpoint rejection).
Native yarn check passes static checks, then fails those two tests and 29 socket
tests because the execution sandbox denies loopback listen.

Compiled JavaScript, including dist/server.js, starts and exits cleanly on
SIGTERM in the isolated image with no TypeScript sources mounted. A fresh
docker compose build proxy still fails in Docker's credential helper while
resolving the Dockerfile frontend, before application build commands run.
No live proxy was restarted, public Tor request sent, volume changed or push
performed.

## October 20, 2026 — compiled JavaScript production build

Added tsconfig.build.json to compile only src into dist, rewriting relative
TypeScript imports to JavaScript. Type checking still covers sources, tests and
scripts without emitting files. Native start and the production image now use
dist/main.js; Docker compiles it in a separate build stage. Generated output is
excluded from Git and the Docker build context.

Format, lint, strict type checking and the JavaScript build pass under Node
22.22.1. An isolated snapshot of the staged commit also compiles successfully.
Its generated JavaScript starts and exits cleanly on SIGTERM under Node 24.22.0
in an existing local Docker image, with no TypeScript sources mounted and no
network access. All five runtime files are emitted; tests and scripts are not.

The staged snapshot's socket suite passes 34 of 36 tests in that image. The same
two existing configuration regressions remain: whitespace in endpoint lists and
missing invalid-endpoint rejection. Native yarn check passes its static checks,
then fails these two tests and 28 socket tests because loopback listen is denied
by the execution sandbox. A fresh production image build remains unverified due
to the previously observed Docker credential-helper failure. No live Tor request,
deployment, service restart or push was performed.

## October 20, 2026 — independent Docker checks and production build

The Dockerfile now shares dependency installation between an explicit `check`
target and production dependency pruning. The final image has no dependency on
the `check` target. Checks remain available through `yarn check` or
`docker build --target check .`; successful checks and a successful production
build on the same commit are required before publishing.

Format, lint and the existing TypeScript build pass under Node 22.22.1. A fresh
`docker compose build proxy` attempt fails in Docker's credential helper while
resolving the Dockerfile frontend image, before running project commands. Full
image construction remains unverified. No runtime code changed; the two known
configuration test failures remain unresolved.

## October 20, 2026 — Git preparation and code style

Initialized the standalone Git repository on `main`. Local environment files,
editor settings, logs, dependency folders and benchmark output are excluded;
`.env.example` and the Yarn lockfile remain versioned. A credential-pattern scan
of candidate files found only the synthetic URL in the proxy-address test.

Applied mandatory control-flow braces and explicit import groups (Node built-ins,
external dependencies, relative modules), enforced by Oxlint and Oxfmt. Format,
lint and TypeScript build pass under Node 22.22.1.

The full test suite does not pass: 34 of 36 tests pass under Node 24.22.0 in an
existing local Docker image, with networking disabled, source mounted read-only
and temporary writable test directories. The two configuration regressions are
an untrimmed space in a comma-separated endpoint list and missing rejection of
invalid configuration values. These failures also occur under native Node 22;
the native socket tests additionally hit the execution sandbox's loopback limit.
Configuration changes await the requested review before implementation.

Compose configuration validation passes. A fresh image build fails when Docker's
credential helper reads registry credentials, before application checks run.
No live Tor benchmark, deployment, service restart or remote push was performed.

## October 19, 2026 — Compose startup diagnosis

Rechecked the documented startup workflow. `docker compose config --quiet`
passes. `docker compose ps -a` fails with an input/output error reading an
overlay2 layer. `docker compose build` fails before reading the Tor Dockerfile:
BuildKit cannot create a lease because writing
`/var/lib/docker/buildkit/containerdmeta.db` returns an input/output error.
The host filesystem reports 3.1 GiB available at 99% capacity. These observations
establish a Docker storage failure, but do not establish whether freeing space
alone will repair it.

Updated README startup prerequisites, bootstrap waiting and storage diagnostics.
Format, lint, check (all 36 tests) and build pass under Node 22.22.1 with
Yarn 4.18.1. No runtime or deployment configuration changed. Docker image builds,
Tor bootstrap and public proxy requests remain unverified. No service was
restarted and no Docker data or persistent volume was removed.

Source: the Tor Rotator app from the Radar repository, extracted October 19, 2026.
The original Radar checkout and live services are preserved.

The standalone project retains the HTTP/CONNECT transport, SOCKS isolation,
rotation, limits, deadlines, local monitoring, benchmark and socket regressions.
Only the Radar telemetry dependency and its external Compose network were removed.
Pino writes structured local logs directly; a regression checks credential
redaction and correlation. No production deployment is implied.

## October 19, 2026

- Installed the standalone dependency graph offline using Yarn 4.18.1 and its own
  lockfile. The project has three production dependencies: Pino, socks and Zod.
  No Radar package, parent configuration, external workspace link, secret file,
  browser profile or collected data was copied.
- Ran format, lint, strict type checking, all forty local tests and build under
  Node 22.22.1: all pass. Tests exercise real loopback sockets and fake SOCKS
  endpoints without public requests or a running Tor daemon. The new logger
  regression verifies redaction while preserving correlation fields.
- The first check used the shell's Node 20 and could not load native TypeScript;
  the supported Node 22 runtime resolves this. The first logger test exposed
  incorrect redaction paths with nested fields; corrected the paths before the
  successful run. Only synthetic test values were used.
- `docker compose config --quiet` passes. Docker's daemon is stopped, so image
  builds, Tor bootstrap and public exit checks were not run. Docker was not
  started and no existing container or volume was changed.

The default Compose name, host ports and volume remain compatible with the
original installation. Use the separate project name and alternate ports in
README.md when running both copies concurrently. A Tor session does not guarantee
a unique exit IP.

## October 19, 2026 — proxy-only runtime and instance benchmark

Removed the admin API, Prometheus exposition, readiness and exit-IP background
probes, their configuration/port and their tests. Removed per-request monitoring
counters and duplicated agent-integration documentation. Runtime startup now
creates only the proxy. Session lease accounting, rotation, native streaming,
admission limits, independent deadlines and graceful cleanup remain.

The proxy accepts a bounded list of Tor SOCKS endpoints. Each session stays on
its assigned endpoint, with no fallback after refusal. The benchmark creates a
separate Tor container per instance, sixteen isolated sessions per instance, a
proxy and ephemeral loopback port for each case. It waits for each Tor's own
bootstrap log before measuring. Docker CPU/memory samples cover the same load
period, including draining, with per-container and simultaneous aggregate data.
Reports retain failures, missing samples, interruptions and unrun cases. SIGINT
and SIGTERM trigger cleanup of only the generated project. Public requests are
bounded; provider 403/429 responses prevent later count experiments.

Thirty-eight tests pass, including two distinct fake SOCKS endpoints, pinned
session routing, refusal without fallback, resource-unit parsing and simultaneous
sums, missing-container refusal, benchmark abort accounting and an end-to-end
fake-Docker lifecycle/cleanup check. Strict type checking and build pass. An
intermediate check caught remaining counter references; updated tests now wait
for actual socket and lease closure rather than removed monitoring counters.
No public provider was contacted by these tests.

Docker's daemon remains stopped. Base Compose validation and generated Compose
configurations for one, two, four and sixteen instances pass; image builds,
real multi-container bootstrap and real CPU/memory/IP measurements remain
unverified until Docker is available. No live service, original Radar source,
secret or persistent volume was modified. The next verification is an isolated
one-instance five-second smoke benchmark, then the requested count comparison.

## October 19, 2026 — minimal runtime configuration

Removed the generic parseAuthority helper and Zod. Node URL parsing now handles
configuration endpoints and request authorities. Ingress checks retain port,
host-length, userinfo and path restrictions; HTTP forwarding preserves the raw
path/query, including dot segments. Remote SOCKS DNS, authenticated isolation,
stream handling and the existing noDelay socket option remain.

Only PROXY_BIND and TOR_SOCKS_ADDRS configure the runtime. Sessions are derived
as sixteen per Tor endpoint; rotation, deadlines, client limits and info logging
use fixed defaults. Former environment overrides are ignored. The benchmark,
examples and README match; the separate Compose host-port mapping remains.

Offline dependency installation, format, lint, strict type checking, all 38 tests,
build and Compose configuration validation pass under Node 22.22.1. An initial
test run exposed a stale expected HTTP path in the revised fixture; the final
assertion verifies exact raw-path preservation. Invalid endpoints and IPv6
CONNECT are covered without public traffic.

Disk exhaustion blocked two attempted writes before source modification.
Removed only generated dependency/cache copies in the two task staging folders
and the standalone Yarn download cache; installed dependencies, source backups
and lockfile remain. Future installation may need to fetch packages again.
Free space remains critically low. No original Radar source, live service,
credential, profile or persistent volume changed. Docker image builds and live
Tor benchmarks were not run; local tests do not establish public Tor performance.

## October 19, 2026 — light proxy architecture

Implemented the approved standalone simplification. The runtime now has five
files: main, config, proxy, tor and timeouts. Session selection and staggered
credential renewal are internal. Removed the session pool class, leases,
generations, per-request tracing, custom response metadata and the Pino logger.
SOCKS connection creation uses the native noDelay option. HTTP helpers now live
beside the forwarding code instead of in a separate module.

The benchmark has one command and three options: instance counts, duration and
request rate. It retains isolated Docker projects, bootstrap checks, CPU/memory
samples, all attempted outcomes and bounded cleanup. Request scheduling lives
in benchmark.ts; ip-probe.ts performs one fixed HTTPS exit-IP request. Removed
the separate load command, session controls, latency breakdowns and configurable
concurrency/deadlines. Eight outstanding requests and a thirty-second deadline
remain fixed. Provider refusals stop new work without retries or redirects.

Compared with the pre-change backup, runtime source is 654 lines instead of 856;
benchmark source is 709 instead of 905. These counts include blank lines and
comments. The only direct production dependency is socks. An offline Yarn
installation removed Pino and its unused transitive dependencies. README and
repository instructions now describe the supported minimal interface.

Compatibility is intentionally limited to standard HTTP/CONNECT proxy clients.
Old session-selection/correlation headers no longer select sessions or produce
metadata. Plain HTTP forwarding strips them. The old benchmark:load command and
benchmark timeout/concurrency flags are gone. Existing streams keep their current
Tor connection; renewed credentials affect new connections only. No unique exit
IP is promised.

Verification under Node 22.22.1:

- Format and lint passed after each edit. Final check and build passed, with all
  36 tests successful and none skipped. Existing real loopback regressions cover
  SOCKS authentication, remote destination names, HTTP/CONNECT streaming,
  half-closes, cancellation, timeouts, admission and cleanup. The updated tests
  observe socket closure instead of deleted production counters.
- An ordinary Node HTTP client, using only a proxy address and an absolute URL,
  receives origin JSON, headers and both 200 and 429 statuses unchanged. Two
  requests use two internal credentials, with no retry or client session control.
- The fake-Docker benchmark lifecycle, resource summaries, refusal handling and
  abort cleanup pass. These checks do not run real containers.
- An additional temporary local TLS smoke check exercised the actual ip-probe
  function against five HTTPS responses: a valid Tor IP, IsTor=false, an invalid
  IP, an oversized response and HTTP 429. All expected outcomes passed. A synthetic
  certificate was trusted only through NODE_EXTRA_CA_CERTS for that test process;
  TLS verification stayed enabled and no public destination was contacted. This
  was an ad hoc check, not an addition to the permanent test suite.
- docker compose config --quiet passes. Dockerfile and compose.yaml remain
  byte-for-byte unchanged from the pre-change backup.

No Docker image build, public Tor benchmark or deployment was performed. The
original Radar project, running services and persistent volumes were not changed.
The remaining validation is an explicitly run isolated Docker benchmark; local
fixtures do not establish Tor bootstrap time, resource usage or exit-IP diversity.

## October 19, 2026 — exported configuration object

Replaced readConfig with an exported constant object checked using satisfies
Config. The proxy owns its explicit Config input type, and main passes the
imported object directly to createProxy(config). Fixed limits and the two
Docker/native endpoint environment settings retain their values and validation.
Environment settings are now read once at module import.

Adapted the socket harness to spread the default object. Environment validation
and the generated three-instance benchmark configuration are checked in isolated
Node processes, so each import receives its own settings. No live configuration,
Docker service, volume or Radar source was changed.

Format, lint, strict type checking, all 36 local tests and build pass under
Node 22.22.1. No Docker image rebuild or live Tor benchmark was performed for
this structural change.
