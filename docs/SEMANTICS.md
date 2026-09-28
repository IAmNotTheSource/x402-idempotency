# Semantics

Behaviour of `x402-idempotency`, with the spec text each rule comes from.
Spec: `x402-foundation/x402` — `specs/x402-specification-v2.md` (§5, §9, §10) and
`specs/extensions/payment_identifier.md`.

## Identity

An idempotency **key** is `scope : payer : source : id`.

| source | where the id comes from | spec basis |
|---|---|---|
| `extension` | `PaymentPayload.extensions["payment-identifier"].info.id`, 16–128 chars `[A-Za-z0-9_-]` | payment_identifier.md "`id` Format" |
| `header` | `Idempotency-Key` request header | draft-ietf-httpapi-idempotency-key-header (compat) |
| `payload` | derived: `evm:<from>:<nonce>` (EIP-3009), `tx:sha256(transaction)` (SVM), else hash of the scheme payload | v2 §5.2.2 (nonce unique per authorization), §10.1 |

Payer scoping: two wallets using the same `id` never collide. Tenant scoping: the `scope` option
("Scope the key by tenant, merchant, route…" — payment_identifier.md "Request Binding").

## Fingerprint (request binding)

Spec: *"bind each `id` to a normalized request fingerprint … scheme, network, asset, amount, payTo,
resource path and method, application-level operation or order identifier."*

Default: `sha256(canonicalJSON({terms, method, path, query, body}))`. Excludes signature and nonce on
purpose (see README). Route/path lives in the **fingerprint**, not the key, so reusing one id across
routes is a *conflict*, not a fresh purchase.

## State machine

```
            begin()                           settle ok (after-handler)
 (absent) ─────────▶ in_flight ──────────────────────────────────────▶ completed
                        │                                                   ▲
                        │ settle ok (before-handler)  /  settlement_pending  │ after-handler settle
                        └──────────────────────────▶ settled_pending ────────┘
                        │
                        │ settle failed (terminal) / handler failed with nothing settled
                        └──────────────────────────▶ (released)
```

All states expire after `ttlMs`.

## Decision table

| existing entry | fingerprint | decision | mode 1 (core hooks) | wrappers |
|---|---|---|---|---|
| none | — | `reserved` | proceed | proceed |
| any | differs | `conflict` | 402 `payment_identifier_conflict` | 409 |
| `in_flight` | same | `in_flight` | 402 `payment_identifier_in_flight` | 409 + `Retry-After` |
| `settled_pending` | same | `settled_pending` | 402 `payment_identifier_settled_pending` (message names tx) | 409, body has `transaction`, `network` |
| `completed` | same | `replay` | skip verify, skip handler (JSON/HTML), skip settle, echo original receipt, `info.replayed: true` | stored status/headers/body, `Idempotent-Replayed: true`, receipt annotated |
| `required` and no extension id | — | `required` | 402 `payment_identifier_required` | 400 |

Spec table (payment_identifier.md "Idempotency Behavior"): new id → process; same id same payload →
cached; same id different payload → 409; required without id → 400. `in_flight` and
`settled_pending` refine "same id" while the first outcome is not yet known — both are 409-class
because the request cannot be honoured *right now* without risking a second charge.

## Recording the outcome (wrappers)

| response | receipt (`PAYMENT-RESPONSE`) | recorded as |
|---|---|---|
| 2xx | `success: true` | `completed` (body stored ≤ cap) |
| any | `errorReason: settlement_pending` + `transaction` | `settled_pending` (v2 §9: non-terminal, caller reconciles on chain) |
| non-2xx | `success: true` | `settled_pending` (funds moved, resource failed — never auto re-charge) |
| any | none / failure | released (nothing charged; client may pay again) |

Mode 1 applies the same table through `onAfterSettle` / `onSettleFailure` / `onVerifiedPaymentCanceled`,
with `phase: "before-handler"` settles recorded as `settled_pending`.

## Receipt annotation

On every settlement the extension merges into `SettleResponse.extensions["payment-identifier"]`:

```json
{ "info": { "required": false, "id": "pay_…", "replayed": true }, "schema": { … } }
```

`replayed` is not in the published extension schema (which lists only `required` and `id`); it is
additive and disabled with `announceReplay: false`. Proposed upstream as the standard way for a client
to learn it was served from cache.

## Non-goals

- Facilitator `/verify` `/settle` idempotency (x402#452). Same engine, different call sites.
- Refunds, reconciliation, accounting.
