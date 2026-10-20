# Tor Rotator engineering contract

- Write all code identifiers, comments and docstrings in English only (100%). UI labels, messages, logs, test descriptions and documentation must also be in English. Preserve external content, protocol identifiers and historical collected data.
- Read `README.md` and the affected callers before changing the proxy. This project owns proxy transport and Tor deployment; keep client integrations compatible.
- Keep the runtime on native Node HTTP/TCP/streams. Prefer small functions with clear responsibilities and explicit inputs; do not add frameworks, dependency injection layers, generic transports or classes with a single artificial implementation.
- Keep server construction, connection admission, cancellation and shutdown in server.ts. Keep request validation and HTTP/CONNECT forwarding in proxy.ts. Pass request context to handlers instead of sharing mutable connection registries.
- Keep server factories focused on assembling handlers. Put parsing, configuration and request helpers at module scope. Small event callbacks are fine. Keep lifecycle closures local when they own a socket, timer or idempotent cleanup; extracting them must make the code easier to follow.
- Group decimal integer literals of four or more digits with underscores: `1_000`, `60_000`, `65_536`. Do not change numeric strings, wire formats or external identifiers.
- Always use braces for control-flow bodies, including single-statement `if`, `else` and loops. Oxlint enforces this with `curly`.
- Group imports in this order: Node built-ins, external dependencies, relative modules, with a blank line between groups. Keep type imports with their module group; Oxfmt enforces the grouping.
- Route every destination through the configured Tor SOCKS endpoint, with remote DNS and authenticated session isolation. Never add direct egress or an unauthenticated SOCKS fallback. CONNECT remains opaque; never intercept TLS.
- Preserve streaming, backpressure, TCP half-closes, admission limits and independent header/connection/idle/lifetime deadlines. Do not buffer entire streams. Bound optimistic CONNECT data.
- Cancel pending work when its client closes. Close both sides of failed connections. Cleanup must be idempotent. Verify closure with real socket behavior rather than production counters added only for tests.
- Keep proxy authentication and old internal control headers away from the origin. Use simple startup/error messages; never log credentials, payloads, query strings or raw errors that expose them. Do not reintroduce tracing or client-controlled sessions.
- Keep the runtime limited to proxying. Resource measurements and exit-IP checks belong to the explicit benchmark; do not add an admin server, Prometheus or background probes.
- Add regressions for behavior defects using the existing `node:test` socket harness. Verify success, refusal, cancellation and cleanup paths. Run `yarn check`; `docker build --target check .` runs the same checks without network access. Production image builds are independent of checks; require both to pass on the same commit before publishing.
- Document actual evidence and limitations in `VALIDATION.md`. A Tor circuit or session does not guarantee a unique exit IP. Validate builds after runtime changes while preserving configuration. Restart the running proxy only when the task authorizes deployment.

## Standalone project

- Own all sources, tests, dependency declarations and the Yarn 4.18.1 lockfile here. Do not import Radar workspaces or add a build orchestrator.
- After edits, run `corepack yarn format` then `corepack yarn lint`. Run `corepack yarn check` and `corepack yarn build` before delivery.
- Preserve the standard HTTP/CONNECT interface, native streaming, bounds, isolation, cancellation and cleanup. The only production dependency is socks. Rotation is internal; clients supply only their usual proxy setting.
- Do not restart an existing proxy, change live configuration or remove volumes without deployment authorization.
