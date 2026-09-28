// Any fetch-style runtime (mode 3). `app.fetch` can be Hono, itty-router, or your own x402 server.
import { createIdempotency, idempotentFetch } from "x402-idempotency/http";
import app from "./app";

const idem = createIdempotency();
export default { fetch: idempotentFetch(idem, app.fetch) };
