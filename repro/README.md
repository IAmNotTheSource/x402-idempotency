# repro: lost-response retry on an x402 resource server

Validates retry safety of **your own** x402 resource server. It does not touch
anyone else's deployment. Testnet only: the server refuses mainnet network ids.

## What it shows

A paid x402 request has one dangerous window: after the facilitator has settled
the payment and before the client reads the response. If the connection dies
there, the client has paid and has nothing. What happens next depends on the
client and on the server:

| client retries with…                   | server without idempotency          | server with `x402-idempotency`        |
|----------------------------------------|-------------------------------------|---------------------------------------|
| a fresh signature (what `@x402/fetch` does) | **charged again**, second tx hash | original body + original tx, no facilitator call |
| the identical `PAYMENT-SIGNATURE`      | 402, authorization already used, **never delivered** | original body + original tx, no facilitator call |

This is not a defect in any particular sample. The x402 client owns the nonce,
so a fresh signature is a fresh charge unless the *server* recognises the
retry. The spec's `payment-identifier` extension exists for exactly that, and
this package implements it. The repro measures the difference.

Note the client here does nothing unusual: it is the official `@x402/fetch` +
`@x402/evm` client with the `payment-identifier` id attached, retrying the way
any client would after a socket error.

## Files

- `server.mjs`: the resource server from the `@x402/express` README. `IDEMPOTENT=1`
  registers the extension. A request with header `x-repro-drop-response: 1` has
  its socket destroyed *after* settlement, which is the failure being modelled.
- `client.mjs`: official client. Case A: lost response then normal retry. Case B:
  byte-identical resend. Writes `evidence/<LABEL>.json`.
- `fake-facilitator.mjs`: offline stand-in for `x402.org/facilitator` that
  enforces one rule: an authorization nonce settles once.

Evidence of the charge count is taken at the server's facilitator HTTP client,
so a replay served from the idempotency store cannot be mistaken for a charge.

## Run offline (no keys, no chain)

```
cd repro && npm install
node server.mjs &            LABEL=offline-baseline node client.mjs
IDEMPOTENT=1 node server.mjs &   LABEL=offline-fixed node client.mjs
```

## Run against your testnet deployment (Base Sepolia)

You need a Base Sepolia key holding a little testnet USDC. Never a mainnet key.

```
# terminal 1: your server, talking to the public testnet facilitator
FACILITATOR_URL=https://x402.org/facilitator PAY_TO=0xYourReceiver node server.mjs
# (add IDEMPOTENT=1 for the fixed run)

# terminal 2
PRIVATE_KEY=0x... LABEL=sepolia-baseline node client.mjs
```

The two `SETTLED` lines in the server log (and the `settlements` array in the
evidence file) are the two on-chain transaction hashes for one purchase; look
them up on sepolia.basescan.org. In the `IDEMPOTENT=1` run there is one.

The `x-repro-drop-response` knob is the only server-side cooperation the repro
needs. It exists because a client cannot abort precisely between "settled" and
"response read"; the server can. It changes nothing about verification or
settlement.
