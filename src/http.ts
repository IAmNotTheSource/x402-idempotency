import type { IdempotencyEngine } from "./engine.js";
import type { Idempotency } from "./extension.js";
import { errorFor, recordOutcome, replayMaterial } from "./record.js";
import type { PaymentPayloadLike, RequestFacts } from "./types.js";
import { decodeBase64Json, isJsonContentType } from "./util.js";

export interface FetchWrapperOptions {
  /** Request bodies larger than this are fingerprinted by length only. Default 1 MiB. */
  maxFingerprintBodyBytes?: number;
  /** Route pattern resolver, e.g. from your router, to include in RequestFacts.route. */
  route?: (req: Request) => string | undefined;
}

type FetchHandler = (req: Request) => Promise<Response> | Response;

/**
 * Wrap any `(Request) => Response` handler so paid requests are charged once
 * and delivered once. Works in front of any x402 server implementation — the
 * wrapper only reads the PAYMENT-SIGNATURE / X-PAYMENT request header and the
 * PAYMENT-RESPONSE response header.
 *
 * ```ts
 * export default { fetch: idempotentFetch(idem, app.fetch) };
 * ```
 */
export function idempotentFetch(
  idem: Idempotency | IdempotencyEngine,
  handler: FetchHandler,
  opts: FetchWrapperOptions = {},
): (req: Request) => Promise<Response> {
  const engine = "engine" in idem ? idem.engine : idem;
  const maxBody = opts.maxFingerprintBodyBytes ?? 1024 * 1024;

  return async function idempotent(req: Request): Promise<Response> {
    const paymentHeader = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
    const idemHeader = req.headers.get("idempotency-key");
    if (!paymentHeader && !idemHeader) return handler(req);

    const payload = paymentHeader ? decodeBase64Json<PaymentPayloadLike>(paymentHeader) : undefined;
    if (paymentHeader && !payload) return handler(req); // malformed: let the server answer

    const facts = await factsFromRequest(req, maxBody, opts.route);
    const decision = await engine.begin(payload, facts);

    switch (decision.kind) {
      case "pass":
        return handler(req);
      case "replay": {
        const m = replayMaterial(engine, decision.entry);
        if (!m.body && decision.entry.response === undefined) {
          // Paid, but nothing stored to replay (e.g. body over the cap): re-execute for free.
          return handler(req);
        }
        return new Response(m.body ? (m.body as BodyInit) : null, { status: m.status, headers: m.headers });
      }
      case "required":
      case "conflict":
      case "in_flight":
      case "settled_pending": {
        const e = errorFor(decision);
        return new Response(JSON.stringify(e.body), { status: e.status, headers: e.headers });
      }
      case "reserved":
        break;
    }

    const { track } = decision;
    let res: Response;
    try {
      res = await handler(req);
    } catch (err) {
      await engine.release(track);
      throw err;
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    let bodyBytes: Uint8Array | undefined;
    let out = res;
    if (res.body) {
      const [forStore, forClient] = res.body.tee();
      out = new Response(forClient, { status: res.status, statusText: res.statusText, headers: res.headers });
      bodyBytes = new Uint8Array(await new Response(forStore).arrayBuffer());
    }
    await recordOutcome(engine, track, res.status, headers, bodyBytes);
    return out;
  };
}

async function factsFromRequest(
  req: Request,
  maxBody: number,
  route?: (req: Request) => string | undefined,
): Promise<RequestFacts> {
  const url = new URL(req.url);
  const query: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) {
    const prev = query[k];
    query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const facts: RequestFacts = {
    method: req.method,
    path: url.pathname,
    header: name => req.headers.get(name) ?? undefined,
  };
  const r = route?.(req);
  if (r) facts.route = r;
  if (Object.keys(query).length > 0) facts.query = query;

  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > maxBody) {
      facts.body = { oversized: declared };
    } else {
      const bytes = new Uint8Array(await req.clone().arrayBuffer());
      if (bytes.byteLength > maxBody) {
        facts.body = { oversized: bytes.byteLength };
      } else {
        const text = new TextDecoder().decode(bytes);
        if (isJsonContentType(req.headers.get("content-type") ?? undefined)) {
          try {
            facts.body = JSON.parse(text);
          } catch {
            facts.body = text;
          }
        } else {
          facts.body = text;
        }
      }
    }
  }
  return facts;
}
