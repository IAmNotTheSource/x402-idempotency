import type { Decision, IdempotencyEngine, Track } from "./engine.js";
import { storedBodyBytes } from "./engine.js";
import { PAYMENT_IDENTIFIER, REASONS, type IdempotencyEntry, type SettleResponseLike } from "./types.js";
import { decodeBase64Json, encodeBase64Json } from "./util.js";

/** Case-insensitive header bag → lowercase record. */
export function lowerHeaders(input: Iterable<[string, string]> | Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: Iterable<[string, unknown]> =
    typeof (input as Iterable<[string, string]>)[Symbol.iterator] === "function"
      ? (input as Iterable<[string, string]>)
      : Object.entries(input as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

export function settleFromHeaders(headers: Record<string, string>): SettleResponseLike | undefined {
  const raw = headers["payment-response"] ?? headers["x-payment-response"];
  if (!raw) return undefined;
  const settle = decodeBase64Json<SettleResponseLike>(raw);
  return settle && typeof settle.success === "boolean" ? settle : undefined;
}

/**
 * After the wrapped handler produced a response, bind the outcome to the key:
 *   2xx + successful PAYMENT-RESPONSE  → completed (replayable)
 *   any status + settlement_pending    → settled_pending (never re-charge)
 *   non-2xx + successful settle        → settled_pending (money moved, resource failed)
 *   otherwise                          → released (nothing was charged)
 */
export async function recordOutcome(
  engine: IdempotencyEngine,
  track: Track,
  status: number,
  headers: Record<string, string>,
  body: Uint8Array | undefined,
): Promise<IdempotencyEntry | undefined> {
  const settle = settleFromHeaders(headers);
  const ok = status >= 200 && status < 300;
  if (ok && settle?.success) {
    return engine.complete(track, { settle, response: engine.toStoredResponse(status, headers, body) });
  }
  if (settle && settle.transaction && (settle.success || settle.errorReason === "settlement_pending")) {
    return engine.markSettledPending(track, settle);
  }
  await engine.release(track);
  return undefined;
}

export interface ErrorBody {
  error: string;
  message: string;
  paymentIdentifier?: string;
  transaction?: string;
  network?: string;
}

/** Status + JSON body for the non-replay decisions. */
export function errorFor(decision: Exclude<Decision, { kind: "pass" | "replay" | "reserved" }>): {
  status: number;
  headers: Record<string, string>;
  body: ErrorBody;
} {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  switch (decision.kind) {
    case "required":
      return {
        status: 400,
        headers,
        body: {
          error: REASONS.required,
          message: "This resource requires extensions.payment-identifier.info.id in the PaymentPayload",
        },
      };
    case "conflict":
      return {
        status: 409,
        headers,
        body: {
          error: REASONS.conflict,
          message: "This payment identifier is already bound to a different request",
          paymentIdentifier: decision.track.id,
        },
      };
    case "in_flight":
      return {
        status: 409,
        headers: { ...headers, "retry-after": String(decision.retryAfterSeconds) },
        body: {
          error: REASONS.inFlight,
          message: "A request with this payment identifier is still being processed",
          paymentIdentifier: decision.track.id,
        },
      };
    case "settled_pending":
      return {
        status: 409,
        headers,
        body: {
          error: REASONS.settledPending,
          message: "This payment identifier was settled but the outcome is unknown; reconcile on chain before retrying",
          paymentIdentifier: decision.track.id,
          ...(decision.entry.settle?.transaction ? { transaction: decision.entry.settle.transaction } : {}),
          ...(decision.entry.settle?.network ? { network: decision.entry.settle.network } : {}),
        },
      };
  }
}

/** Headers + bytes to replay a completed entry, with replay markers. */
export function replayMaterial(
  engine: IdempotencyEngine,
  entry: IdempotencyEntry,
): { status: number; headers: Record<string, string>; body: Uint8Array | undefined } {
  const stored = entry.response;
  const headers: Record<string, string> = { ...(stored?.headers ?? {}) };
  headers["idempotent-replayed"] = "true";
  headers["cache-control"] = "no-store";
  if (entry.settle) {
    const settle: SettleResponseLike = { ...entry.settle };
    if (engine.options.announceReplay) {
      settle.extensions = {
        ...(settle.extensions ?? {}),
        [PAYMENT_IDENTIFIER]: { info: { id: entry.id, replayed: true } },
      };
    }
    headers["payment-response"] = encodeBase64Json(settle);
    delete headers["x-payment-response"];
  }
  return { status: stored?.status ?? 200, headers, body: storedBodyBytes(stored) };
}
