/**
 * Drives the two retry cases against server.mjs using the official @x402/fetch
 * client and @x402/evm signer. Writes evidence/<label>.json.
 *
 * Env:
 *   SERVER_URL    default http://127.0.0.1:4402
 *   PRIVATE_KEY   funded Base Sepolia key when the server uses a real
 *                 facilitator; omitted = random throwaway (fake facilitator only)
 *   LABEL         evidence file name (default: "run")
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { PAYMENT_IDENTIFIER, generatePaymentId } from "@x402/extensions/payment-identifier";

const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:4402";
const LABEL = process.env.LABEL ?? "run";
const key = process.env.PRIVATE_KEY ?? generatePrivateKey();
const account = privateKeyToAccount(key);
console.log(`[client] payer=${account.address}${process.env.PRIVATE_KEY ? "" : " (throwaway key)"}`);

// The client-chosen payment id. A real client keeps this stable across retries
// of the same logical purchase, and mints a new one per purchase. That is the
// whole mechanism. Each case below is its own purchase.
let paymentId = generatePaymentId("pay_");

// Record every outgoing PAYMENT-SIGNATURE so the mirror case can resend one byte-for-byte.
const sentSignatures = [];
const recordingFetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const sig = req.headers.get("payment-signature");
  if (sig) sentSignatures.push(sig);
  return fetch(req);
};

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(toClientEvmSigner(account)))
  .registerExtension({
    key: PAYMENT_IDENTIFIER,
    async enrichPaymentPayload(payload, paymentRequired) {
      const decl = paymentRequired.extensions?.[PAYMENT_IDENTIFIER];
      if (!decl) return payload; // server didn't advertise it; nothing to attach
      return { ...payload, extensions: { ...(payload.extensions ?? {}), [PAYMENT_IDENTIFIER]: { info: { ...decl.info, id: paymentId }, schema: decl.schema } } };
    },
  });
const fetchWithPayment = wrapFetchWithPayment(recordingFetch, client);

const body = JSON.stringify({ q: "btc" });
const post = (extraHeaders = {}) =>
  fetchWithPayment(`${SERVER_URL}/reports`, { method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body });

const b64json = v => (v ? JSON.parse(Buffer.from(v, "base64").toString("utf8")) : null);
const receipt = async r => {
  const h = r.headers.get("payment-response");
  const pr = b64json(r.headers.get("payment-required"));
  return {
    status: r.status,
    body: await r.json().catch(() => null),
    receipt: h ? decodePaymentResponseHeader(h) : null,
    paymentRequiredError: pr ? { error: pr.error ?? null, errorMessage: pr.errorMessage ?? null } : null,
  };
};
const serverLog = () => fetch(`${SERVER_URL}/__repro/log`).then(r => r.json());

const evidence = { label: LABEL, server: SERVER_URL, payer: account.address, cases: {} };

// Case A: charge succeeds, response is lost, client retries the same purchase.
// @x402/fetch signs a fresh EIP-3009 nonce on every attempt: that is normal
// client behaviour, not a bug in the client.
console.log("\n[case A] paid request whose response is lost, then a normal retry");
let lost;
try {
  await post({ "x-repro-drop-response": "1" });
  lost = "unexpected: response arrived";
} catch (e) {
  lost = `client saw: ${e.cause?.code ?? e.message}`;
}
console.log(`[case A] first attempt: ${lost}`);
const afterFirst = await serverLog();
const retry = await receipt(await post());
const afterRetry = await serverLog();
evidence.cases.A_lost_response_then_retry = {
  paymentId,
  firstAttempt: lost,
  settlementsAfterFirst: afterFirst.settlements,
  retry,
  settlementsAfterRetry: afterRetry.settlements,
  facilitatorCallsDelta: { verify: afterRetry.verify - afterFirst.verify, settle: afterRetry.settle - afterFirst.settle },
};
const txs = afterRetry.settlements.filter(s => s.success).map(s => s.transaction);
const delta = evidence.cases.A_lost_response_then_retry.facilitatorCallsDelta;
if (txs.length === 2) console.log(`[case A] CHARGED TWICE for one purchase:\n         tx1 ${txs[0]}\n         tx2 ${txs[1]}`);
else if (txs.length === 1 && retry.status === 200 && retry.receipt?.transaction === txs[0]) console.log(`[case A] charged once; retry returned the original tx ${txs[0]} with ${delta.verify} verify / ${delta.settle} settle facilitator calls`);
else console.log(`[case A] unexpected state`, JSON.stringify({ retry, afterRetry }, null, 2));

// Case B: mirror. Resend the byte-identical PAYMENT-SIGNATURE of an already
// settled payment (what a client does if it does NOT re-sign).
console.log("\n[case B] byte-identical resend of a settled PAYMENT-SIGNATURE");
paymentId = generatePaymentId("pay_"); // new purchase
const first = await receipt(await post());
const sig = sentSignatures.at(-1);
const before = await serverLog();
const again = await receipt(await fetch(`${SERVER_URL}/reports`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": sig }, body }));
const after = await serverLog();
evidence.cases.B_identical_resend = { paymentId, first, resend: again, facilitatorCallsDelta: { verify: after.verify - before.verify, settle: after.settle - before.settle } };
if (again.status === 200 && again.receipt?.transaction === first.receipt?.transaction) console.log(`[case B] replayed: same tx ${first.receipt.transaction}, ${after.verify - before.verify} verify / ${after.settle - before.settle} settle facilitator calls`);
else console.log(`[case B] rejected: status=${again.status} error=${again.paymentRequiredError?.error ?? JSON.stringify(again.body)} (paid once, delivered never)`);

mkdirSync("evidence", { recursive: true });
writeFileSync(`evidence/${LABEL}.json`, JSON.stringify(evidence, null, 2));
console.log(`\n[client] wrote evidence/${LABEL}.json`);
