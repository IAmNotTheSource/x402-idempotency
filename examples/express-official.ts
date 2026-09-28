// Official @x402 stack + x402-idempotency (mode 1).
import express from "express";
import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createIdempotency, PAYMENT_IDENTIFIER } from "x402-idempotency";

const idem = createIdempotency(); // swap in a Redis-backed store for >1 replica
const payTo = process.env.ADDRESS as `0x${string}`;

const routes = {
  "POST /reports": {
    accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:84532", payTo }],
    description: "Generate a report (charged once per payment identifier)",
    mimeType: "application/json",
    extensions: { [PAYMENT_IDENTIFIER]: idem.declare() },
  },
};

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }))
  .register("eip155:84532", new ExactEvmScheme())
  .registerExtension(idem.extension);

const app = express();
app.use(express.json());
app.use(paymentMiddlewareFromHTTPServer(new x402HTTPResourceServer(server, routes)));
app.post("/reports", (req, res) => res.json({ report: `about ${req.body.topic}`, generatedAt: Date.now() }));
app.listen(4022);
