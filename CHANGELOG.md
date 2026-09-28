# Changelog

## 0.2.0

- `RedisStore` at `x402-idempotency/redis` — multi-replica store (`SET NX PX` reserve, server-side expiry) with `fromNodeRedis` / `fromIoredis` adapters. No new dependencies; the client is passed in.

## 0.1.0

- `createIdempotency()` — `payment-identifier` extension for `@x402/core` resource servers (before/after verify, before/after settle, settle failure, cancel; receipt annotation).
- `idempotentNode()` — Node/Express/Connect middleware for any x402 server.
- `idempotentFetch()` — web-standard wrapper for Workers/Bun/Deno/Hono/Next.
- `MemoryStore` + `IdempotencyStore` contract.
- Id resolution: extension id → `Idempotency-Key` → derived payment identity.
- Spec-aligned fingerprint (terms + method + path + query + body; excludes signature/nonce).
- States: `in_flight`, `settled_pending`, `completed`; statuses 400/409; `Retry-After`; `Idempotent-Replayed`.
