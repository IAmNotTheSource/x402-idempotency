/**
 * A minimal x402 resource server built exactly the way the official
 * @x402/express README shows, plus two repro-only knobs:
 *
 *   IDEMPOTENT=1          register x402-idempotency (the fix under test)
 *   x-repro-drop-response request header: after settlement succeeds, destroy
 *                         the socket instead of sending the response. This is
 *                         the "network died after the charge" case.
 *
 * Env:
 *   FACILITATOR_URL  e.g. https://x402.org/facilitator (default: in-process fake)
 *   PAY_TO           address that receives the payment (default: throwaway)
 *   NETWORK          default eip155:84532 (Base Sepolia). Mainnet ids refused.
 *   PRICE            default $0.001
 *   PORT             default 4402
 */
import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { createIdempotency, PAYMENT_IDENTIFIER } from "x402-idempotency";
import { startFakeFacilitator } from "./fake-facilitator.mjs";

const NETWORK = process.env.NETWORK ?? "eip155:84532";
if (NETWORK === "eip155:8453" || NETWORK === "eip155:1") throw new Error("repro refuses mainnet networks");
const PAY_TO = process.env.PAY_TO ?? "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PRICE = process.env.PRICE ?? "$0.001";
const PORT = Number(process.env.PORT ?? 4402);
const IDEMPOTENT = process.env.IDEMPOTENT === "1";

const fake = process.env.FACILITATOR_URL ? null : await startFakeFacilitator({ network: NETWORK });
const facilitatorUrl = process.env.FACILITATOR_URL ?? fake.url;
const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Facilitator call log. Every /settle that reaches the facilitator is a charge,
// so this is the evidence of how many times the payer was charged. Counted at
// the HTTP client so replays served from the idempotency store never show up.
const log = { verify: 0, settle: 0, settlements: [], replays: 0 };
for (const m of ["verify", "settle"]) {
  const orig = facilitator[m].bind(facilitator);
  facilitator[m] = async (...args) => {
    log[m]++;
    const r = await orig(...args);
    if (m === "settle") {
      log.settlements.push({ transaction: r.transaction, success: r.success, errorReason: r.errorReason ?? null, payer: r.payer });
      console.log(`[server] facilitator /settle #${log.settle} success=${r.success} tx=${r.transaction || "-"}${r.errorReason ? " error=" + r.errorReason : ""}`);
    }
    return r;
  };
}
const resourceServer = new x402ResourceServer(facilitator)
  .register(NETWORK, new ExactEvmScheme())
  .onAfterSettle(async ({ result }) => {
    if (result.extensions?.[PAYMENT_IDENTIFIER]?.info?.replayed) {
      log.replays++;
      console.log(`[server] REPLAYED from idempotency store tx=${result.transaction} (no facilitator call)`);
    }
  });

const route = {
  accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO }],
  description: "Repro resource",
  mimeType: "application/json",
};

let idem;
if (IDEMPOTENT) {
  idem = createIdempotency();
  route.extensions = { [PAYMENT_IDENTIFIER]: idem.declare() };
  resourceServer.registerExtension(idem.extension);
}

const httpServer = new x402HTTPResourceServer(resourceServer, { "POST /reports": route });

let handlerCalls = 0;
const app = express();
app.use(express.json());

// Repro knob: simulate the connection dying AFTER settlement, BEFORE the client
// sees the response. Installed before the payment middleware so its buffered
// replay of res.end lands here, i.e. after processSettlement has completed.
app.use((req, res, next) => {
  if (req.headers["x-repro-drop-response"] === "1") {
    const end = res.end.bind(res);
    res.end = (...args) => {
      if (res.getHeader("payment-response")) {
        console.log("[server] settlement done; dropping the response on the floor (simulated network failure)");
        res.socket.destroy();
        return res;
      }
      return end(...args);
    };
  }
  next();
});

app.use(paymentMiddlewareFromHTTPServer(httpServer));
app.post("/reports", (req, res) => {
  handlerCalls++;
  res.json({ report: req.body?.q ?? null, handlerCall: handlerCalls });
});
app.get("/__repro/log", (_req, res) => res.json({ ...log, handlerCalls, facilitatorCalls: fake?.calls ?? null }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] http://127.0.0.1:${PORT}  network=${NETWORK}  facilitator=${facilitatorUrl}  idempotent=${IDEMPOTENT}`);
});
