import test from "node:test";
import assert from "node:assert/strict";
import { createIdempotency, idempotentFetch, encodeBase64Json, REASONS } from "../dist/index.js";
import { payload, header, settleResponse, decodeSettle } from "./helpers.mjs";

const ID = "pay_http_wrapper_000001";

/** Minimal fake x402 resource server: 402 without payment, 200 + PAYMENT-RESPONSE with it. */
function fakeServer({ status = 200, settle = settleResponse(), delay = 0 } = {}) {
  let calls = 0;
  const handler = async req => {
    calls++;
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (!req.headers.get("payment-signature")) {
      return new Response(JSON.stringify({ error: "Payment required" }), {
        status: 402,
        headers: { "content-type": "application/json", "payment-required": encodeBase64Json({ x402Version: 2, accepts: [] }) },
      });
    }
    const url = new URL(req.url);
    const bodyText = req.method === "POST" ? await req.text() : "";
    return new Response(JSON.stringify({ path: url.pathname, echo: bodyText, n: calls }), {
      status,
      headers: { "content-type": "application/json", ...(settle ? { "payment-response": encodeBase64Json(settle) } : {}) },
    });
  };
  return { handler, calls: () => calls };
}

const post = (p, { path = "/reports", body = { q: "btc" } } = {}) =>
  new Request("https://api.example.com" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": header(p) },
    body: JSON.stringify(body),
  });

test("unpaid requests pass straight through", async () => {
  const srv = fakeServer();
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  const res = await fetch(new Request("https://api.example.com/reports"));
  assert.equal(res.status, 402);
  assert.equal(srv.calls(), 1);
});

test("retry with the same id replays the body, the receipt, and marks the replay", async () => {
  const srv = fakeServer();
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  const first = await fetch(post(payload({ id: ID, nonce: "0x" + "01".repeat(32) })));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.n, 1);

  const retry = await fetch(post(payload({ id: ID, nonce: "0x" + "02".repeat(32) })));
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(await retry.json(), firstBody);
  assert.equal(srv.calls(), 1, "handler ran once");
  const settle = decodeSettle(retry);
  assert.equal(settle.transaction, settleResponse().transaction);
  assert.equal(settle.extensions["payment-identifier"].info.replayed, true);
});

test("same id, different body → 409 payment_identifier_conflict", async () => {
  const srv = fakeServer();
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  await fetch(post(payload({ id: ID })));
  const res = await fetch(post(payload({ id: ID }), { body: { q: "eth" } }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, REASONS.conflict);
  assert.equal(body.paymentIdentifier, ID);
  assert.equal(srv.calls(), 1);
});

test("concurrent duplicate → 409 in_flight with Retry-After, then replay", async () => {
  const srv = fakeServer({ delay: 30 });
  const fetch = idempotentFetch(createIdempotency({ inFlightRetryAfterSeconds: 3 }), srv.handler);
  const a = fetch(post(payload({ id: ID })));
  await new Promise(r => setTimeout(r, 5));
  const b = await fetch(post(payload({ id: ID })));
  assert.equal(b.status, 409);
  assert.equal(b.headers.get("retry-after"), "3");
  assert.equal((await b.json()).error, REASONS.inFlight);
  assert.equal((await a).status, 200);
  const c = await fetch(post(payload({ id: ID })));
  assert.equal(c.headers.get("idempotent-replayed"), "true");
  assert.equal(srv.calls(), 1);
});

test("handler failure (no settlement) releases the id; the next attempt executes", async () => {
  const srv = fakeServer({ status: 500, settle: null });
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  assert.equal((await fetch(post(payload({ id: ID })))).status, 500);
  assert.equal((await fetch(post(payload({ id: ID })))).status, 500);
  assert.equal(srv.calls(), 2);
});

test("money moved but the resource failed → 409 settled_pending naming the transaction", async () => {
  const srv = fakeServer({ status: 500 });
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  assert.equal((await fetch(post(payload({ id: ID })))).status, 500);
  const res = await fetch(post(payload({ id: ID })));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, REASONS.settledPending);
  assert.equal(body.transaction, settleResponse().transaction);
  assert.equal(srv.calls(), 1);
});

test("Idempotency-Key header works for clients that predate the extension", async () => {
  const srv = fakeServer();
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  const mk = () =>
    new Request("https://api.example.com/reports", {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": header(payload()), "idempotency-key": "order-42-attempt" },
      body: JSON.stringify({ q: "btc" }),
    });
  const a = await fetch(mk());
  const b = await fetch(mk());
  assert.equal(a.status, 200);
  assert.equal(b.headers.get("idempotent-replayed"), "true");
  assert.equal(srv.calls(), 1);
});

test("byte-identical resend of an already-settled payment (no id at all) is a replay, not a facilitator error", async () => {
  const srv = fakeServer();
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  const p = payload();
  await fetch(post(p));
  const again = await fetch(post(p));
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(srv.calls(), 1);
});

test("required: true → 400 when the client omits the extension id", async () => {
  const srv = fakeServer();
  const fetch = idempotentFetch(createIdempotency({ required: true }), srv.handler);
  const res = await fetch(post(payload()));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, REASONS.required);
  assert.equal(srv.calls(), 0);
});

test("2xx without a PAYMENT-RESPONSE receipt is not treated as paid", async () => {
  const srv = fakeServer({ settle: null });
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  await fetch(post(payload({ id: ID })));
  await fetch(post(payload({ id: ID })));
  assert.equal(srv.calls(), 2);
});

test("GET query strings are part of the binding", async () => {
  const srv = fakeServer();
  const fetch = idempotentFetch(createIdempotency(), srv.handler);
  const get = q => new Request("https://api.example.com/quote?" + q, { headers: { "payment-signature": header(payload({ id: ID })) } });
  assert.equal((await fetch(get("pair=btc"))).status, 200);
  assert.equal((await fetch(get("pair=eth"))).status, 409);
  assert.equal((await fetch(get("pair=btc"))).headers.get("idempotent-replayed"), "true");
});
