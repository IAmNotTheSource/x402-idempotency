/**
 * Runs the extension inside the REAL @x402/core + @x402/express stack with a
 * fake facilitator (no chain access). Proves the hook contract composes.
 *
 *   cd e2e && npm install && node --test core.e2e.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { createIdempotency, PAYMENT_IDENTIFIER, encodeBase64Json, decodeBase64Json } from "../dist/index.js";

const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

function fakeFacilitator() {
  const calls = { verify: 0, settle: 0 };
  return {
    calls,
    async verify(p) {
      calls.verify++;
      return { isValid: true, payer: p.payload.authorization.from };
    },
    async settle(p) {
      calls.settle++;
      return { success: true, transaction: "0x" + calls.settle.toString(16).padStart(64, "0"), network: NETWORK, payer: p.payload.authorization.from };
    },
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { assetTransferMethod: "eip3009" } }], extensions: [PAYMENT_IDENTIFIER] };
    },
  };
}

const fakeExactScheme = {
  scheme: "exact",
  defaultAssetTransferMethod: "eip3009",
  paymentFlows: { eip3009: { supported: ["authorization"], default: "authorization" } },
  async parsePrice() {
    return { amount: "10000", asset: USDC, extra: { name: "USDC", version: "2" } };
  },
  async enhancePaymentRequirements(req) {
    return req;
  },
};

let nonce = 0;
async function challenge(base) {
  const r = await fetch(base + "/reports", { method: "POST" });
  return decodeBase64Json(r.headers.get("payment-required"));
}

function paymentHeader({ id, accepted }) {
  nonce++;
  const amount = accepted.amount;
  return encodeBase64Json({
    x402Version: 2,
    resource: { url: "" },
    accepted,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: { from: PAYER, to: PAY_TO, value: amount, validAfter: "1", validBefore: "9999999999", nonce: "0x" + nonce.toString(16).padStart(64, "0") },
    },
    extensions: id ? { [PAYMENT_IDENTIFIER]: { info: { required: false, id }, schema: { type: "object" } } } : {},
  });
}

async function boot({ required = false } = {}) {
  const facilitator = fakeFacilitator();
  const idem = createIdempotency({ required });
  const routes = {
    "POST /reports": {
      accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAY_TO }],
      description: "Report",
      mimeType: "application/json",
      extensions: { [PAYMENT_IDENTIFIER]: idem.declare() },
    },
  };
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, fakeExactScheme).registerExtension(idem.extension);
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  let handlerCalls = 0;
  const app = express();
  app.use(express.json());
  app.use(paymentMiddlewareFromHTTPServer(httpServer));
  app.post("/reports", (req, res) => {
    handlerCalls++;
    res.json({ report: req.body?.q ?? null, n: handlerCalls });
  });

  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const accepted = (await challenge(base)).accepts[0];
  return {
    base,
    accepted,
    facilitator,
    handlerCalls: () => handlerCalls,
    close: () => new Promise(r => server.close(r)),
  };
}

const post = (base, header, body = { q: "btc" }) =>
  fetch(base + "/reports", { method: "POST", headers: { "content-type": "application/json", ...(header ? { "payment-signature": header } : {}) }, body: JSON.stringify(body) });

test("real core: unpaid → 402 advertises payment-identifier; paid → 200 with receipt", async () => {
  const s = await boot();
  try {
    const unpaid = await post(s.base, undefined);
    assert.equal(unpaid.status, 402);
    const pr = decodeBase64Json(unpaid.headers.get("payment-required"));
    assert.equal(pr.extensions[PAYMENT_IDENTIFIER].info.required, false);

    const paid = await post(s.base, paymentHeader({ id: "pay_e2e_000000000001", accepted: s.accepted }));
    assert.equal(paid.status, 200);
    assert.deepEqual(await paid.json(), { report: "btc", n: 1 });
    const receipt = decodeBase64Json(paid.headers.get("payment-response"));
    assert.equal(receipt.success, true);
    assert.equal(receipt.extensions[PAYMENT_IDENTIFIER].info.replayed, false);
    assert.equal(s.facilitator.calls.settle, 1);
  } finally {
    await s.close();
  }
});

test("real core: lost-response retry (fresh nonce, same id) → same body, same tx, zero extra facilitator calls", async () => {
  const s = await boot();
  try {
    const id = "pay_e2e_000000000002";
    const a = await post(s.base, paymentHeader({ id, accepted: s.accepted }));
    const aBody = await a.json();
    const aTx = decodeBase64Json(a.headers.get("payment-response")).transaction;
    assert.deepEqual(s.facilitator.calls, { verify: 1, settle: 1 });

    const b = await post(s.base, paymentHeader({ id, accepted: s.accepted }));
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), aBody, "identical body replayed");
    const receipt = decodeBase64Json(b.headers.get("payment-response"));
    assert.equal(receipt.transaction, aTx, "original transaction echoed");
    assert.equal(receipt.extensions[PAYMENT_IDENTIFIER].info.replayed, true);
    assert.deepEqual(s.facilitator.calls, { verify: 1, settle: 1 }, "facilitator untouched on replay");
    assert.equal(s.handlerCalls(), 1, "handler ran once");
  } finally {
    await s.close();
  }
});

test("real core: same id, different body → 402 payment_identifier_conflict, nothing executed", async () => {
  const s = await boot();
  try {
    const id = "pay_e2e_000000000003";
    await post(s.base, paymentHeader({ id, accepted: s.accepted }), { q: "btc" });
    const c = await post(s.base, paymentHeader({ id, accepted: s.accepted }), { q: "eth" });
    assert.equal(c.status, 402);
    const pr = decodeBase64Json(c.headers.get("payment-required"));
    assert.equal(pr.error, "payment_identifier_conflict");
    assert.equal(s.handlerCalls(), 1);
    assert.equal(s.facilitator.calls.settle, 1);
  } finally {
    await s.close();
  }
});

test("real core: byte-identical resend of a settled payment (no id) replays instead of hitting the facilitator", async () => {
  const s = await boot();
  try {
    const h = paymentHeader({ accepted: s.accepted });
    await post(s.base, h);
    const again = await post(s.base, h);
    assert.equal(again.status, 200);
    assert.equal(decodeBase64Json(again.headers.get("payment-response")).extensions[PAYMENT_IDENTIFIER].info.replayed, true);
    assert.deepEqual(s.facilitator.calls, { verify: 1, settle: 1 });
  } finally {
    await s.close();
  }
});

test("real core: required: true → 402 payment_identifier_required without an id", async () => {
  const s = await boot({ required: true });
  try {
    const r = await post(s.base, paymentHeader({ accepted: s.accepted }));
    assert.equal(r.status, 402);
    assert.equal(decodeBase64Json(r.headers.get("payment-required")).error, "payment_identifier_required");
    assert.equal(s.handlerCalls(), 0);
  } finally {
    await s.close();
  }
});
