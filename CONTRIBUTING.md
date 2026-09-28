# Contributing

Small package, tight scope: the `payment-identifier` extension's idempotency behaviour for resource servers. Please keep it that way.

## Dev loop

```
npm install
npm test                       # builds dist/ and runs test/*.test.mjs (no network, no chain)
cd e2e && npm install && node --test core.e2e.test.mjs   # real @x402/core + @x402/express, fake facilitator
```

## Good first contributions

- **Stores**: `RedisStore` (SET NX PX for reserve), `PostgresStore`, `SqliteStore`, Cloudflare KV / Durable Objects. Ship each as `x402-idempotency-store-<name>` or a PR under `src/stores/` with tests against a fake.
- **Adapters**: Fastify / Koa wrappers if `idempotentNode` doesn't fit.
- **Spec**: field reports where a real facilitator/SDK behaves differently from `docs/SEMANTICS.md`. Open an issue with the wire capture.

## Rules

- Zero runtime dependencies in the main package.
- Every behaviour change comes with a test and a line in `docs/SEMANTICS.md`.
- Never silently re-charge. When unsure whether money moved, the answer is `settled_pending`, not "retry".
