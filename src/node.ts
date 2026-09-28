import type { IncomingMessage, ServerResponse } from "node:http";
import type { IdempotencyEngine } from "./engine.js";
import type { Idempotency } from "./extension.js";
import { errorFor, lowerHeaders, recordOutcome, replayMaterial } from "./record.js";
import type { PaymentPayloadLike, RequestFacts } from "./types.js";
import { decodeBase64Json } from "./util.js";

type NodeRequest = IncomingMessage & { body?: unknown; route?: { path?: string } };
type NodeResponse = ServerResponse;
type Next = (err?: unknown) => void;

/**
 * Express / Connect / plain `node:http` middleware. Mount it BEFORE the x402
 * payment middleware and AFTER any body parser (the parsed `req.body`, when
 * present, is part of the request-binding fingerprint).
 *
 * ```ts
 * app.use(express.json());
 * app.use(idempotentNode(idem));
 * app.use(paymentMiddleware(...));
 * ```
 */
export function idempotentNode(
  idem: Idempotency | IdempotencyEngine,
): (req: NodeRequest, res: NodeResponse, next: Next) => void {
  const engine = "engine" in idem ? idem.engine : idem;

  return function idempotent(req, res, next): void {
    const headers = lowerHeaders(req.headers as Record<string, unknown>);
    const paymentHeader = headers["payment-signature"] ?? headers["x-payment"];
    if (!paymentHeader && !headers["idempotency-key"]) return next();

    void (async () => {
      const payload = paymentHeader ? decodeBase64Json<PaymentPayloadLike>(paymentHeader) : undefined;
      if (paymentHeader && !payload) return next();

      const facts = factsFromNode(req, headers);
      const decision = await engine.begin(payload, facts);

      switch (decision.kind) {
        case "pass":
          return next();
        case "replay": {
          const m = replayMaterial(engine, decision.entry);
          if (!m.body && decision.entry.response === undefined) return next(); // re-execute for free
          res.statusCode = m.status;
          for (const [k, v] of Object.entries(m.headers)) res.setHeader(k, v);
          if (m.body) res.setHeader("content-length", String(m.body.byteLength));
          res.end(m.body ? Buffer.from(m.body) : undefined);
          return;
        }
        case "required":
        case "conflict":
        case "in_flight":
        case "settled_pending": {
          const e = errorFor(decision);
          res.statusCode = e.status;
          for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
          res.end(JSON.stringify(e.body));
          return;
        }
        case "reserved":
          break;
      }

      const { track } = decision;
      const chunks: Buffer[] = [];
      let settled = false;
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);

      const capture = (chunk: unknown, encoding?: unknown): void => {
        if (chunk === undefined || chunk === null || typeof chunk === "function") return;
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
        else chunks.push(Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8"));
      };

      res.write = function (chunk: unknown, ...rest: unknown[]) {
        capture(chunk, rest[0]);
        return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      } as typeof res.write;

      res.end = function (chunk?: unknown, ...rest: unknown[]) {
        if (typeof chunk !== "function") capture(chunk, rest[0]);
        if (settled) return (originalEnd as (...a: unknown[]) => NodeResponse)(chunk, ...rest);
        settled = true;
        const status = res.statusCode;
        const responseHeaders = lowerHeaders(res.getHeaders() as Record<string, unknown>);
        const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
        void recordOutcome(engine, track, status, responseHeaders, body)
          .catch(() => engine.release(track).catch(() => undefined))
          .finally(() => (originalEnd as (...a: unknown[]) => NodeResponse)(chunk, ...rest));
        return res;
      } as typeof res.end;

      res.on("close", () => {
        if (!settled) {
          settled = true;
          void engine.release(track).catch(() => undefined);
        }
      });

      next();
    })().catch(next);
  };
}

function factsFromNode(req: NodeRequest, headers: Record<string, string>): RequestFacts {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) {
    const prev = query[k];
    query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const facts: RequestFacts = {
    method: req.method ?? "GET",
    path: url.pathname,
    header: name => headers[name.toLowerCase()],
  };
  if (req.route?.path) facts.route = req.route.path;
  if (Object.keys(query).length > 0) facts.query = query;
  if (req.body !== undefined) facts.body = req.body;
  return facts;
}
