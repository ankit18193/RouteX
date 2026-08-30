# Changelog

All notable changes to **RouteX** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-08-30

### General Availability Release — RouteX Edge API Gateway & Reverse Proxy

#### Added
- **Core Gateway Foundation (Phase 1)**:
  - Declarative YAML configuration loading with strict Zod schema validation.
  - Standard JSON error envelopes (`statusCode`, `error`, `message`, `requestId`, `timestamp`).
  - High-resolution timing tracking (`hrtime.bigint`) and structured Pino JSON logging with latency breakdowns.
  - Correlation ID engine with RFC 4122 UUIDv4 assignment and propagation.
- **Mock Service Ecosystem (Phase 2)**:
  - Mock User Service (port 4001) with cryptographic JWT token issuance, identity reflection, and fault injection.
  - Mock Chat Service (port 4002) with chunked stream generation, slow responses, and crash simulations.
- **Zero-Buffer Reverse Proxy & Connection Pooling (Phase 3)**:
  - `ProxyRouter` with longest-prefix path matching, method validation, and prefix stripping.
  - `UpstreamPoolManager` Undici connection pooling with keep-alive and configurable socket timeouts.
  - Duplex streaming proxy (`handleProxyStream`) piping directly to downstream response sockets.
  - RFC 7230/9110 hop-by-hop header stripping and CRLF injection neutralization.
- **Authentication & Identity Engine (Phase 4)**:
  - Multi-mode route authentication (`public`, `jwt`, `api-key`, `any`).
  - Asymmetric RS256 and symmetric HS256 JWT signature verification with cryptographic key caching.
  - Constant-time API-key hash comparison (`crypto.timingSafeEqual`) and bounded LRU key cache.
  - RBAC role enforcement rejecting unauthorized requests with 403 `FORBIDDEN`.
  - Downstream identity header injection (`x-user-id`, `x-user-roles`, `x-auth-type`).
  - Unconditional stripping of spoofed internal headers.
- **Distributed Redis Rate Limiter (Phase 5)**:
  - Atomic Redis Sliding Window Log implemented in SHA-hashed Lua scripts (`EVALSHA` / `NOSCRIPT`).
  - Two-tier rate limiting: Tier-1 IP protection and Tier-2 authenticated Identity limits (`free`, `premium`).
  - RFC-compliant `X-RateLimit-*` and `Retry-After` response headers on 429 `TOO_MANY_REQUESTS`.
  - Configurable Redis fail-open and fail-closed fault tolerance policies.
- **Response Caching & Circuit Breaker (Phase 6)**:
  - Redis-backed HTTP response caching for safe GET requests with deterministic query-sorted cache keys.
  - SingleFlight stampede protection coalescing concurrent cache misses into a single upstream fetch.
  - Per-origin Circuit Breaker state machine (`CLOSED` $\rightarrow$ `OPEN` $\rightarrow$ `HALF_OPEN`) with origin isolation and 503 `UPSTREAM_CIRCUIT_OPEN` fast-fail.
- **Production Packaging & Reliability Hardening (Phase 7)**:
  - Multi-stage production `Dockerfile` running as non-root `node` user with native Docker `HEALTHCHECK`.
  - Production `docker-compose.yml` orchestrating Redis, Mock Services, and RouteX on bridge network `routex-net`.
  - Health and lifecycle probes: `/livez`, `/readyz` (with Redis ping checks), and `/healthz`.
  - Graceful socket draining via `server.closeIdleConnections()`.
  - Automated 300-test E2E acceptance suite covering functional, resilience, fault-injection, and memory benchmarks.
