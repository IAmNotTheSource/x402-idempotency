import test from "node:test";
import assert from "node:assert/strict";
import { IdempotencyEngine, MemoryStore, REASONS, derivePaymentIdentity } from "../dist/index.js";
import { payload, settleResponse, TERMS, PAYER } from "./helpers.mjs";

const facts = (over = {}) => ({ method: "POST", path: "/reports", body: { q: "btc" }, ...over });
const ID = "pay_0123456789abcdef";

test("resolution order: extension id > Idempotency-Key header > derived payment identity", async () => {
  const e = new IdempotencyEngine();
  const withExt = await e.begin(payload({ id: ID }), facts({ header: () => "hdr-key-000000001" }));
  assert.equal(withExt.kind, "reserved");
  assert.equal(withExt.track.source, "extension");
  assert.equal(withExt.track.id, ID);

  const withHeader = await e.begin(payload(), facts({ header: n => (n === "idempotency-key" ? "hdr-key-000000001" : undefined) }));
  assert.equal(withHeader.track.source, "header");
  assert.equal(withHeader.track.id, "hdr-key-000000001");

  const p = payload();
  const derived = await e.begin(p, facts());
  assert.equal(derived.track.source, "payload");
  assert.equal(derived.track.id, await derivePaymentIdentity(p));
  assert.match(derived.track.id, /^evm:0x[0-9a-f]+:0x[0-9a-f]+$/);
});

test("same id + fresh signature/nonce + same request → replay (this is the lost-response retry)", async () => {
  const e = new IdempotencyEngine();
  const first = await e.begin(payload({ id: ID, nonce: "0x" + "01".repeat(32) }), facts());
  assert.equal(first.kind, "reserved");
  await e.complete(first.track, { settle: settleResponse(), response: { status: 200, body: "{}", encoding: "utf8" } });

  const retry = await e.begin(payload({ id: ID, nonce: "0x" + "02".repeat(32) }), facts());
  assert.equal(retry.kind, "replay");
  assert.equal(retry.entry.settle.transaction, settleResponse().transaction);
});

test("same id, different route/body/terms → conflict (spec: 409)", async () => {
  const e = new IdempotencyEngine();
  const first = await e.begin(payload({ id: ID }), facts());
  await e.complete(first.track, { settle: settleResponse() });

  const otherRoute = await e.begin(payload({ id: ID }), facts({ path: "/expensive" }));
  assert.equal(otherRoute.kind, "conflict");
  assert.equal(otherRoute.reason, REASONS.conflict);

  const otherBody = await e.begin(payload({ id: ID }), facts({ body: { q: "eth" } }));
  assert.equal(otherBody.kind, "conflict");

  const otherAmount = await e.begin(payload({ id: ID, terms: { ...TERMS, amount: "5000000" } }), facts());
  assert.equal(otherAmount.kind, "conflict");
});

test("derived identity: the same signed payment cannot buy a second route", async () => {
  const e = new IdempotencyEngine();
  const p = payload({ nonce: "0x" + "aa".repeat(32) });
  const first = await e.begin(p, facts({ path: "/cheap" }));
  await e.complete(first.track, { settle: settleResponse() });
  const reuse = await e.begin(p, facts({ path: "/expensive" }));
  assert.equal(reuse.kind, "conflict");
  const resend = await e.begin(p, facts({ path: "/cheap" }));
  assert.equal(resend.kind, "replay");
});

test("in_flight while the first request is still running, then replay", async () => {
  const e = new IdempotencyEngine({ inFlightRetryAfterSeconds: 7 });
  const first = await e.begin(payload({ id: ID }), facts());
  const dup = await e.begin(payload({ id: ID }), facts());
  assert.equal(dup.kind, "in_flight");
  assert.equal(dup.retryAfterSeconds, 7);
  await e.complete(first.track, { settle: settleResponse() });
  const later = await e.begin(payload({ id: ID }), facts());
  assert.equal(later.kind, "replay");
});

test("release frees the id; settled_pending keeps it taken and names the transaction", async () => {
  const e = new IdempotencyEngine();
  const a = await e.begin(payload({ id: ID }), facts());
  await e.release(a.track);
  const b = await e.begin(payload({ id: ID }), facts());
  assert.equal(b.kind, "reserved");
  await e.markSettledPending(b.track, settleResponse({ success: false, errorReason: "settlement_pending" }));
  const c = await e.begin(payload({ id: ID }), facts());
  assert.equal(c.kind, "settled_pending");
  assert.equal(c.entry.settle.transaction, settleResponse().transaction);
});

test("required: true rejects header-only and derived ids", async () => {
  const e = new IdempotencyEngine({ required: true });
  const noId = await e.begin(payload(), facts());
  assert.equal(noId.kind, "required");
  const hdr = await e.begin(payload(), facts({ header: () => "hdr-key-000000001" }));
  assert.equal(hdr.kind, "required");
  const ok = await e.begin(payload({ id: ID }), facts());
  assert.equal(ok.kind, "reserved");
});

test("deriveFromPayload:false and no id → pass (idempotency does not apply)", async () => {
  const e = new IdempotencyEngine({ deriveFromPayload: false, acceptIdempotencyKeyHeader: false });
  assert.equal((await e.begin(payload(), facts())).kind, "pass");
});

test("TTL: bindings expire", async () => {
  let t = 1_000_000;
  const now = () => t;
  const e = new IdempotencyEngine({ ttlMs: 1000, now, store: new MemoryStore({ now }) });
  const a = await e.begin(payload({ id: ID }), facts());
  await e.complete(a.track, { settle: settleResponse() });
  t += 999;
  assert.equal((await e.begin(payload({ id: ID }), facts())).kind, "replay");
  t += 2;
  assert.equal((await e.begin(payload({ id: ID }), facts())).kind, "reserved");
});

test("scope separates tenants; payer is part of the key", async () => {
  const e = new IdempotencyEngine({ scope: f => f.header?.("x-tenant") ?? "none" });
  const a = await e.begin(payload({ id: ID }), facts({ header: () => "acme" }));
  await e.complete(a.track, { settle: settleResponse() });
  const otherTenant = await e.begin(payload({ id: ID }), facts({ header: () => "globex" }));
  assert.equal(otherTenant.kind, "reserved");
  const otherPayer = await e.begin(payload({ id: ID, from: "0x" + "99".repeat(20) }), facts({ header: () => "acme" }));
  assert.equal(otherPayer.kind, "reserved");
  assert.notEqual(otherPayer.track.payer, PAYER.toLowerCase());
});

test("stored bodies over the cap are dropped (entry replays by re-execution)", async () => {
  const e = new IdempotencyEngine({ maxStoredBodyBytes: 8 });
  const a = await e.begin(payload({ id: ID }), facts());
  const big = e.toStoredResponse(200, { "content-type": "application/json" }, new TextEncoder().encode("{\"x\":\"0123456789\"}"));
  assert.equal(big.body, undefined);
  const small = e.toStoredResponse(200, { "Content-Type": "text/plain" }, new TextEncoder().encode("hi"));
  assert.equal(small.body, "hi");
  assert.equal(small.encoding, "utf8");
  assert.equal(small.contentType, "text/plain");
  await e.complete(a.track, { settle: settleResponse(), response: big });
  const r = await e.begin(payload({ id: ID }), facts());
  assert.equal(r.kind, "replay");
  assert.equal(r.entry.response.body, undefined);
});
