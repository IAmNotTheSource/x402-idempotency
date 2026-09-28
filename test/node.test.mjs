import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createIdempotency, idempotentNode, encodeBase64Json, REASONS } from "../dist/index.js";
import { payload, header, settleResponse, decodeSettle } from "./helpers.mjs";

const ID = "pay_node_wrapper_000001";

/** Tiny Connect-style composer so the test needs no Express dependency. */
function compose(...mws) {
  return (req, res) => {
    let i = 0;
    const next = err => {
      if (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }
      const mw = mws[i++];
      if (!mw) {
        res.statusCode = 404;
        res.end();
        return;
      }
      mw(req, res, next);
    };
    next();
  };
}

/** Body parser stand-in (express.json()). */
function json(req, res, next) {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    req.body = text ? JSON.parse(text) : undefined;
    next();
  });
}

/** Fake x402 payment middleware + route handler. */
function fakePaid({ status = 200, settle = settleResponse() } = {}) {
  let calls = 0;
  const mw = (req, res) => {
    if (!req.headers["payment-signature"]) {
      res.statusCode = 402;
      res.setHeader("payment-required", encodeBase64Json({ x402Version: 2, accepts: [] }));
      res.end(JSON.stringify({ error: "Payment required" }));
      return;
    }
    calls++;
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    if (settle) res.setHeader("payment-response", encodeBase64Json(settle));
    res.write(JSON.stringify({ n: calls, body: req.body ?? null }));
    res.end();
  };
  return { mw, calls: () => calls };
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

const post = (base, p, body = { q: "btc" }, extra = {}) =>
  fetch(base + "/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": header(p), ...extra },
    body: JSON.stringify(body),
  });

test("node middleware: replay on retry, handler runs once, receipt marked replayed", async () => {
  const paid = fakePaid();
  const idem = createIdempotency();
  await withServer(compose(json, idempotentNode(idem), paid.mw), async base => {
    const a = await post(base, payload({ id: ID, nonce: "0x" + "01".repeat(32) }));
    assert.equal(a.status, 200);
    const aBody = await a.json();
    const b = await post(base, payload({ id: ID, nonce: "0x" + "02".repeat(32) }));
    assert.equal(b.status, 200);
    assert.equal(b.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(await b.json(), aBody);
    assert.equal(decodeSettle(b).extensions["payment-identifier"].info.replayed, true);
    assert.equal(paid.calls(), 1);
  });
});

test("node middleware: 409 on conflicting body, 402 passthrough when unpaid", async () => {
  const paid = fakePaid();
  await withServer(compose(json, idempotentNode(createIdempotency()), paid.mw), async base => {
    const unpaid = await fetch(base + "/reports");
    assert.equal(unpaid.status, 402);
    await post(base, payload({ id: ID }));
    const conflict = await post(base, payload({ id: ID }), { q: "eth" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, REASONS.conflict);
    assert.equal(paid.calls(), 1);
  });
});

test("node middleware: failure without a receipt releases; failure with a receipt is settled_pending", async () => {
  const noReceipt = fakePaid({ status: 500, settle: null });
  await withServer(compose(json, idempotentNode(createIdempotency()), noReceipt.mw), async base => {
    assert.equal((await post(base, payload({ id: ID }))).status, 500);
    assert.equal((await post(base, payload({ id: ID }))).status, 500);
    assert.equal(noReceipt.calls(), 2);
  });
  const withReceipt = fakePaid({ status: 500 });
  await withServer(compose(json, idempotentNode(createIdempotency()), withReceipt.mw), async base => {
    assert.equal((await post(base, payload({ id: ID }))).status, 500);
    const r = await post(base, payload({ id: ID }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, REASONS.settledPending);
    assert.equal(withReceipt.calls(), 1);
  });
});

test("node middleware: works without a body parser (GET) and honours Idempotency-Key", async () => {
  const paid = fakePaid();
  await withServer(compose(idempotentNode(createIdempotency()), paid.mw), async base => {
    const get = () => fetch(base + "/quote?pair=btc", { headers: { "payment-signature": header(payload()), "idempotency-key": "quote-btc-1" } });
    assert.equal((await get()).status, 200);
    assert.equal((await get()).headers.get("idempotent-replayed"), "true");
    assert.equal(paid.calls(), 1);
  });
});
