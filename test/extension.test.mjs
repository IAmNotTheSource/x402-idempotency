import test from "node:test";
import assert from "node:assert/strict";
import { createIdempotency, PAYMENT_IDENTIFIER, REASONS } from "../dist/index.js";
import { payload, settleResponse, transport, TERMS } from "./helpers.mjs";

const ID = "pay_extension_test_00001";
const decl = { info: { required: false }, schema: {} };

/**
 * Drive the hooks the way x402ResourceServer / x402HTTPResourceServer do for one
 * request. Returns what the "adapter" would observe.
 */
async function runRequest(idem, p, { adapterOpts = { method: "POST", path: "/reports", body: { q: "btc" } }, handler, settle = settleResponse(), phase = "after-handler" } = {}) {
  const h = idem.extension.hooks;
  const tcVerify = transport(adapterOpts);
  const ctx = { paymentPayload: p, requirements: TERMS, declaredExtensions: { [PAYMENT_IDENTIFIER]: decl }, transportContext: tcVerify };

  const before = await h.onBeforeVerify(decl, ctx);
  if (before && before.abort) return { status: 402, reason: before.reason, message: before.message };

  const verifyResult = before && before.skip ? before.result : { isValid: true, payer: p.payload.authorization.from };
  const after = await h.onAfterVerify(decl, { ...ctx, result: verifyResult });
  if (after && after.abort) return { status: 402, reason: after.reason };

  let body;
  let handlerRan = false;
  if (after && after.skipHandler) {
    body = after.response?.body;
  } else {
    handlerRan = true;
    body = handler ? await handler() : { report: "sunny" };
  }

  const tcSettle = transport(adapterOpts, { body });
  const sctx = { ...ctx, transportContext: tcSettle, phase };
  const bs = await h.onBeforeSettle(decl, sctx);
  if (bs && bs.abort) return { status: 402, reason: bs.reason, handlerRan };
  const settleResult = bs && bs.skip ? bs.result : settle;
  if (!settleResult.success && !(bs && bs.skip)) {
    await h.onSettleFailure(decl, { ...sctx, error: settleResult });
    return { status: 402, settle: settleResult, handlerRan };
  }
  await h.onAfterSettle(decl, { ...sctx, result: settleResult });
  const enriched = await idem.extension.enrichSettlementResponse(decl, { ...sctx, result: settleResult });
  return { status: 200, body, settle: settleResult, enriched, handlerRan, skippedSettle: Boolean(bs && bs.skip) };
}

test("lost-response retry with a fresh nonce: same body, same transaction, no second settle", async () => {
  const idem = createIdempotency();
  let calls = 0;
  const handler = async () => ({ report: "sunny", n: ++calls });

  const first = await runRequest(idem, payload({ id: ID, nonce: "0x" + "01".repeat(32) }), { handler });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { report: "sunny", n: 1 });
  assert.equal(first.enriched.info.replayed, false);

  const retry = await runRequest(idem, payload({ id: ID, nonce: "0x" + "02".repeat(32) }), { handler });
  assert.equal(retry.status, 200);
  assert.equal(retry.handlerRan, false, "handler must not run twice");
  assert.equal(retry.skippedSettle, true, "settle must be skipped");
  assert.deepEqual(retry.body, { report: "sunny", n: 1 });
  assert.equal(retry.settle.transaction, first.settle.transaction);
  assert.equal(retry.enriched.info.replayed, true);
  assert.equal(retry.enriched.info.id, ID);
  assert.equal(calls, 1);
});

test("same id on another route → abort with payment_identifier_conflict, handler never runs", async () => {
  const idem = createIdempotency();
  await runRequest(idem, payload({ id: ID }), { adapterOpts: { method: "GET", path: "/cheap" } });
  const r = await runRequest(idem, payload({ id: ID }), { adapterOpts: { method: "GET", path: "/expensive" } });
  assert.equal(r.status, 402);
  assert.equal(r.reason, REASONS.conflict);
  assert.equal(idem.statusFor(r.reason), 409);
});

test("settle failure releases the key so the client can pay again", async () => {
  const idem = createIdempotency();
  const failed = await runRequest(idem, payload({ id: ID }), { settle: settleResponse({ success: false, errorReason: "insufficient_funds", transaction: "" }) });
  assert.equal(failed.status, 402);
  const again = await runRequest(idem, payload({ id: ID }), {});
  assert.equal(again.status, 200);
  assert.equal(again.handlerRan, true);
});

test("settlement_pending keeps the key and the next attempt is refused with the transaction", async () => {
  const idem = createIdempotency();
  const tx = "0x" + "77".repeat(32);
  const pending = await runRequest(idem, payload({ id: ID }), { settle: { success: false, errorReason: "settlement_pending", transaction: tx, network: TERMS.network } });
  assert.equal(pending.status, 402);
  const r = await runRequest(idem, payload({ id: ID }), {});
  assert.equal(r.status, 402);
  assert.equal(r.reason, REASONS.settledPending);
  assert.match(r.message, new RegExp(tx));
});

test("before-handler settle (upfront/escrow flows) is recorded as settled_pending, then completed by the after-handler settle", async () => {
  const idem = createIdempotency();
  const h = idem.extension.hooks;
  const p = payload({ id: ID });
  const tc = transport({ method: "POST", path: "/reports", body: { q: "btc" } });
  const ctx = { paymentPayload: p, requirements: TERMS, declaredExtensions: { [PAYMENT_IDENTIFIER]: decl }, transportContext: tc };
  assert.equal(await h.onBeforeVerify(decl, ctx), undefined);
  await h.onAfterSettle(decl, { ...ctx, phase: "before-handler", result: settleResponse() });

  // A duplicate arriving now must not re-run the resource for free.
  const dup = await h.onBeforeVerify(decl, { ...ctx, paymentPayload: payload({ id: ID }) });
  assert.equal(dup.reason, REASONS.settledPending);

  await h.onAfterSettle(decl, { ...ctx, phase: "after-handler", result: settleResponse(), transportContext: transport({ method: "POST", path: "/reports", body: { q: "btc" } }, { body: { ok: true } }) });
  const replay = await h.onBeforeVerify(decl, { ...ctx, paymentPayload: payload({ id: ID }) });
  assert.equal(replay.skip, true);
});

test("handler failure after verify (nothing settled) releases the key", async () => {
  const idem = createIdempotency();
  const h = idem.extension.hooks;
  const p = payload({ id: ID });
  const ctx = { paymentPayload: p, requirements: TERMS, declaredExtensions: {}, transportContext: transport({ method: "POST", path: "/reports" }) };
  await h.onBeforeVerify(decl, ctx);
  await h.onVerifiedPaymentCanceled(decl, { ...ctx, reason: "handler_threw", settledPhases: [] });
  const next = await h.onBeforeVerify(decl, { ...ctx, paymentPayload: payload({ id: ID }) });
  assert.equal(next, undefined, "fresh reservation expected");
});

test("required: true → abort payment_identifier_required (400) when the client sends no id", async () => {
  const idem = createIdempotency({ required: true });
  const r = await runRequest(idem, payload(), {});
  assert.equal(r.reason, REASONS.required);
  assert.equal(idem.statusFor(r.reason), 400);
  assert.equal(idem.declare().info.required, true);
});

test("replay: 're-execute' mode never replays bodies but still skips settlement", async () => {
  const idem = createIdempotency({ replay: "re-execute" });
  let calls = 0;
  const handler = async () => ({ n: ++calls });
  await runRequest(idem, payload({ id: ID }), { handler });
  const r = await runRequest(idem, payload({ id: ID }), { handler });
  assert.equal(r.handlerRan, true);
  assert.equal(r.skippedSettle, true);
  assert.equal(calls, 2);
});

test("non-JSON, non-HTML bodies fall back to re-execution through the core hooks", async () => {
  const idem = createIdempotency();
  const h = idem.extension.hooks;
  const p = payload({ id: ID });
  const ctx = { paymentPayload: p, requirements: TERMS, declaredExtensions: {}, transportContext: transport({ method: "GET", path: "/csv" }) };
  await h.onBeforeVerify(decl, ctx);
  await h.onAfterSettle(decl, { ...ctx, phase: "after-handler", result: settleResponse(), transportContext: transport({ method: "GET", path: "/csv" }, { body: "a,b\n1,2", contentType: "text/csv" }) });
  const p2 = payload({ id: ID });
  const ctx2 = { ...ctx, paymentPayload: p2 };
  const bv = await h.onBeforeVerify(decl, ctx2);
  assert.equal(bv.skip, true);
  const av = await h.onAfterVerify(decl, { ...ctx2, result: bv.result });
  assert.equal(av, undefined, "handler should re-run for non-replayable bodies");
  const bs = await h.onBeforeSettle(decl, ctx2);
  assert.equal(bs.skip, true);
});

test("no id and derivation disabled → hooks are inert", async () => {
  const idem = createIdempotency({ deriveFromPayload: false, acceptIdempotencyKeyHeader: false });
  let calls = 0;
  const handler = async () => ({ n: ++calls });
  await runRequest(idem, payload(), { handler });
  const r = await runRequest(idem, payload(), { handler });
  assert.equal(r.handlerRan, true);
  assert.equal(r.skippedSettle, false);
  assert.equal(r.enriched, undefined);
});
