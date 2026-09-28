/**
 * Offline stand-in for https://x402.org/facilitator so the repro runs with no
 * chain access. It models the one chain rule that matters here: an EIP-3009
 * authorization nonce can be settled exactly once.
 *
 * Not used when FACILITATOR_URL is set.
 */
import express from "express";

export function startFakeFacilitator({ network }) {
  const settledNonces = new Map(); // nonce -> tx
  const calls = { verify: 0, settle: 0 };
  let txCounter = 0;

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network, extra: { assetTransferMethod: "eip3009" } }],
      extensions: ["payment-identifier"],
      signers: {},
    });
  });

  app.post("/verify", (req, res) => {
    calls.verify++;
    const auth = req.body?.paymentPayload?.payload?.authorization;
    if (!auth?.nonce) return res.json({ isValid: false, invalidReason: "invalid_payload" });
    if (settledNonces.has(auth.nonce)) {
      return res.json({ isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_already_used", payer: auth.from });
    }
    res.json({ isValid: true, payer: auth.from });
  });

  app.post("/settle", (req, res) => {
    calls.settle++;
    const auth = req.body?.paymentPayload?.payload?.authorization;
    if (settledNonces.has(auth.nonce)) {
      return res.json({ success: false, errorReason: "invalid_exact_evm_payload_authorization_already_used", transaction: "", network, payer: auth.from });
    }
    const transaction = "0xfake" + (++txCounter).toString(16).padStart(59, "0");
    settledNonces.set(auth.nonce, transaction);
    res.json({ success: true, transaction, network, payer: auth.from });
  });

  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => server.close(r)) });
    });
  });
}
