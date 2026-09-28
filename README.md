# x402-idempotency

**Charge once. Deliver once. Replay safely.**

The missing implementation of x402's [`payment-identifier`](https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md) extension for resource servers — the piece the official SDK leaves as `// In production, use Redis`.

```
npm install x402-idempotency
```

Zero runtime dependencies. Works in Node, Workers, Bun, Deno. Plugs into the official `@x402/core` server as an extension, or wraps any x402 server (any language's SDK behind it) as HTTP middleware.

## The problem

Network errors happen in the worst possible place: after the signed payment is sent and before the client sees the response.

- The agent times out. It retries. It signs a **fresh nonce** — the chain sees two independent authorizations and settles both. **Paid twice, delivered once.**
- Or it resends the **same** payment. The facilitator hits `AuthorizationUsed` and returns a failure. **Paid once, delivered never.**
- Or the server hand-rolls a "seen transactions" cache keyed only by the payment, and one paid header now buys `/cheap` *and* `/expensive`, forever.

The spec answers all three with the `payment-identifier` extension: a client-chosen `id`, bound server-side to a **request fingerprint**, with defined behaviour (`same id + same request → cached`, `same id + different request → 409`, `required + no id → 400`). Every server was re-implementing that table by hand, usually wrong. This package is the table.

## Three ways in

### 1. Official `@x402/core` server — register the extension

```ts
import { createIdempotency, PAYMENT_IDENTIFIER } from "x402-idempotency";
import { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } from "@x402/express";

const idem = createIdempotency({ /* store: new RedisStore(...) — see Stores */ });

const routes = {
  "POST /reports": {
    accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:8453", payTo }],
    extensions: { [PAYMENT_IDENTIFIER]: idem.declare() },   // advertise (idem.declare(true) to require)
  },
};

const server = new x402ResourceServer(facilitator)
  .register("eip155:8453", new ExactEvmScheme())
  .registerExtension(idem.extension);                        // ← that's it

app.use(paymentMiddlewareFromHTTPServer(new x402HTTPResourceServer(server, routes)));
```

The extension uses the core's own lifecycle hooks — no adapter needed, so Express, Hono, Fastify and Next all get it:

| phase | on a replay |
|---|---|
| `onBeforeVerify` | skips the facilitator `/verify` |
| `onAfterVerify` | skips your handler, returns the stored body |
| `onBeforeSettle` | skips `/settle`, echoes the **original** `PAYMENT-RESPONSE` |
| `enrichSettlementResponse` | adds `extensions["payment-identifier"].info.replayed: true` |

Verified end-to-end against the real `@x402/core` + `@x402/express` (`e2e/`): a lost-response retry returns the identical body and transaction with **zero** facilitator calls.

### 2. Any x402 server on Node / Express — middleware

Works in front of *any* implementation: it only reads `PAYMENT-SIGNATURE` in and `PAYMENT-RESPONSE` out.

```ts
import { createIdempotency, idempotentNode } from "x402-idempotency";

app.use(express.json());                 // body is part of the binding
app.use(idempotentNode(createIdempotency()));
app.use(paymentMiddleware(...));         // your x402 layer, whatever it is
```

### 3. Any fetch-style runtime — Workers, Bun, Deno, Hono, Next

```ts
import { createIdempotency, idempotentFetch } from "x402-idempotency/http";

const idem = createIdempotency();
export default { fetch: idempotentFetch(idem, app.fetch) };
```

Wrappers reply with the spec's statuses directly (`400`, `409` + `Retry-After`) and add `Idempotent-Replayed: true` on replays.

## What a client gets

| situation | official core (mode 1) | HTTP wrappers (modes 2–3) |
|---|---|---|
| new id | normal flow | normal flow |
| same id, same request, already paid | 200, stored body, original receipt | same, plus `Idempotent-Replayed: true` |
| same id, different route / body / query / terms | 402 `payment_identifier_conflict` | **409** `payment_identifier_conflict` |
| same id, first request still running | 402 `payment_identifier_in_flight` | **409** + `Retry-After` |
| same id, money moved, outcome unknown | 402 `payment_identifier_settled_pending` (names the tx) | **409**, body names `transaction`/`network` |
| server requires id, none sent | 402 `payment_identifier_required` | **400** |
| settle failed (nothing charged) | id released — client may pay again | same |

Mode 1 can only speak 402 because that's what the core's hooks can return; the reason code is machine-readable in `PAYMENT-REQUIRED.error`. Put a wrapper in front if you need the exact numbers.

## How an id is resolved

1. `PaymentPayload.extensions["payment-identifier"].info.id` — the spec.
2. `Idempotency-Key` request header — for clients that predate the extension ([IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)). Off with `acceptIdempotencyKeyHeader: false`.
3. Derived from the signed payment itself (EIP-3009 `from + nonce`, SVM transaction, or a hash of the scheme payload). This turns a *byte-identical resend* of a settled payment into a replay instead of a facilitator error. Off with `deriveFromPayload: false`.

`required: true` accepts only (1).

## The fingerprint (why retries with a fresh nonce still work)

The spec binds an id to a **normalised request** — payment terms, path and method, operation — not to the signature. So the default fingerprint is:

```
sha256(canonical({ terms: {scheme, network, asset, amount, payTo}, method, path, query, body }))
```

The signature and nonce are deliberately **excluded**. A client that lost the response, kept its `id`, and re-signed is doing exactly what the spec tells it to; it gets the stored response, not a second charge. (The official example hashes the full payload including the signature, which makes that retry a 409 — the opposite of what the extension is for.)

Override with `fingerprint: (facts, payload, terms) => any` — return anything JSON-able, e.g. add an order id and drop the body.

## Stores

`MemoryStore` (default) is correct for one process. For anything else, implement four methods:

```ts
interface IdempotencyStore {
  get(key): Promise<IdempotencyEntry | undefined>;
  reserve(key, entry): Promise<{ ok: true } | { ok: false; existing }>;  // MUST be create-if-absent (SET NX / INSERT … ON CONFLICT)
  set(key, entry): Promise<void>;
  delete(key): Promise<void>;
}
```

### Redis (more than one replica)

```ts
import { createClient } from "redis";
import { createIdempotency } from "x402-idempotency";
import { RedisStore, fromNodeRedis } from "x402-idempotency/redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const idem = createIdempotency({ store: new RedisStore({ client: fromNodeRedis(redis) }) });
```

Bring your own client: `fromNodeRedis` (`redis` v4+) or `fromIoredis` (`ioredis`). Neither is a dependency of this package. For anything else (Upstash, Valkey clients, ...) pass an object with four functions, `get`, `setIfAbsent`, `set`, `del`.

`reserve` is one `SET NX PX`, so exactly one replica wins an id, and Redis expires the entry when the binding does. If Redis is unreachable or an entry is unreadable the request fails; it is never treated as new. `keyPrefix` namespaces keys on a shared instance.

Entries are small JSON (settle receipt + captured response ≤ `maxStoredBodyBytes`, default 1 MiB). TTL defaults to 24 h. Keys look like `x402idem:v1:<scope>:<payer>:<source>:<id>`; add tenant/merchant boundaries with `scope`.

## Options

| option | default | |
|---|---|---|
| `store` | `MemoryStore` | see above |
| `ttlMs` | 24 h | binding lifetime |
| `required` | `false` | advertise `required: true`; reject requests without an extension id |
| `acceptIdempotencyKeyHeader` | `true` | honour `Idempotency-Key` |
| `deriveFromPayload` | `true` | identity from the signed payment when no id |
| `scope(facts, payload)` | `"default"` | tenant / merchant partition of the key space |
| `fingerprint(facts, payload, terms)` | see above | request binding |
| `replay` | `"response"` | `"re-execute"`: never store bodies; retries re-run the handler but skip settlement (read-only resources) |
| `maxStoredBodyBytes` | 1 MiB | larger bodies aren't stored; those entries replay by re-execution |
| `inFlightRetryAfterSeconds` | 5 | |
| `announceReplay` | `true` | `info.replayed` in the receipt |

## Limitations (honest list)

- Mode 1 replays JSON and HTML bodies through the core's `skipHandler`; other content types re-run the handler (still without settling). Use a wrapper for exact replay of binary/text.
- `upfront` / `escrow` flows: a pre-handler settle is recorded as `settled_pending`; mode 1 completes it on the after-handler settle. Wrappers see the final response and handle all flows uniformly.
- `MemoryStore` is single-replica; use `RedisStore` for more. Postgres/SQLite/KV adapters welcome — see `CONTRIBUTING.md`.
- `RedisStore` assumes writes are not lost: on failover with asynchronous replication, a reservation acknowledged by the old primary can be missing on the new one.
- Facilitator-side idempotency (`/verify`, `/settle` retries, [x402#452](https://github.com/x402-foundation/x402/issues/452)) is a separate layer; the `IdempotencyEngine` here is reusable for it.

## Semantics in one page

See [`docs/SEMANTICS.md`](docs/SEMANTICS.md) — the state machine, every status code, and the spec clause behind each.

## License

MIT
