import { MemoryStore } from "./memory-store.js";
import {
  REASONS,
  type IdempotencyEntry,
  type IdempotencyOptions,
  type IdempotencyStore,
  type PaymentPayloadLike,
  type PaymentRequirementsLike,
  type RequestFacts,
  type SettleResponseLike,
  type StoredResponse,
} from "./types.js";
import {
  buildKey,
  canonicalJson,
  defaultFingerprint,
  defaultScope,
  extractPayer,
  resolveId,
  sha256Hex,
  termsOf,
} from "./util.js";

/** Per-request bookkeeping handed back by {@link IdempotencyEngine.begin}. */
export interface Track {
  key: string;
  id: string;
  source: IdempotencyEntry["source"];
  fingerprint: string;
  payer?: string;
  createdAt: number;
  expiresAt: number;
}

export type Decision =
  /** No id could be resolved; idempotency does not apply to this request. */
  | { kind: "pass" }
  /** Server requires an extension id and none was sent. HTTP 400. */
  | { kind: "required"; reason: typeof REASONS.required }
  /** Same id, different request. HTTP 409. */
  | { kind: "conflict"; reason: typeof REASONS.conflict; entry: IdempotencyEntry; track: Track }
  /** Same id, original still running. HTTP 409 + Retry-After. */
  | { kind: "in_flight"; reason: typeof REASONS.inFlight; entry: IdempotencyEntry; track: Track; retryAfterSeconds: number }
  /** Same id, funds moved, outcome unknown. HTTP 409, names the transaction. */
  | { kind: "settled_pending"; reason: typeof REASONS.settledPending; entry: IdempotencyEntry; track: Track }
  /** Same id, same request, already paid. Serve the stored result. */
  | { kind: "replay"; entry: IdempotencyEntry; track: Track }
  /** New id. Reservation taken; caller MUST later call complete/markSettledPending/release. */
  | { kind: "reserved"; track: Track };

export class IdempotencyEngine {
  readonly store: IdempotencyStore;
  readonly options: Required<
    Pick<
      IdempotencyOptions,
      | "ttlMs"
      | "required"
      | "acceptIdempotencyKeyHeader"
      | "deriveFromPayload"
      | "inFlightRetryAfterSeconds"
      | "replay"
      | "maxStoredBodyBytes"
      | "announceReplay"
    >
  > &
    Pick<IdempotencyOptions, "scope" | "fingerprint">;
  readonly now: () => number;

  constructor(opts: IdempotencyOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.store = opts.store ?? new MemoryStore({ now: this.now });
    this.options = {
      ttlMs: opts.ttlMs ?? 24 * 60 * 60 * 1000,
      required: opts.required ?? false,
      acceptIdempotencyKeyHeader: opts.acceptIdempotencyKeyHeader ?? true,
      deriveFromPayload: opts.deriveFromPayload ?? true,
      inFlightRetryAfterSeconds: opts.inFlightRetryAfterSeconds ?? 5,
      replay: opts.replay ?? "response",
      maxStoredBodyBytes: opts.maxStoredBodyBytes ?? 1024 * 1024,
      announceReplay: opts.announceReplay ?? true,
      scope: opts.scope,
      fingerprint: opts.fingerprint,
    };
  }

  /**
   * Decide what to do with an incoming paid request. Pure with respect to the
   * request; the only side effect is taking a reservation on a new id.
   */
  async begin(
    payload: PaymentPayloadLike | undefined,
    facts: RequestFacts,
    requirements?: PaymentRequirementsLike,
  ): Promise<Decision> {
    const resolved = await resolveId(payload, facts, {
      acceptHeader: this.options.acceptIdempotencyKeyHeader,
      derive: this.options.deriveFromPayload,
    });

    if (this.options.required && resolved?.source !== "extension") {
      return { kind: "required", reason: REASONS.required };
    }
    if (!resolved) return { kind: "pass" };

    const scope = this.options.scope ? await this.options.scope(facts, payload) : defaultScope();
    const payer = extractPayer(payload);
    const terms = termsOf(payload, requirements);
    const fpInput = this.options.fingerprint
      ? await this.options.fingerprint(facts, payload, terms)
      : defaultFingerprint(facts, payload, terms);
    const fingerprint = await sha256Hex(canonicalJson(fpInput));
    const key = buildKey(scope, payer, resolved);
    const createdAt = this.now();
    const track: Track = {
      key,
      id: resolved.id,
      source: resolved.source,
      fingerprint,
      payer,
      createdAt,
      expiresAt: createdAt + this.options.ttlMs,
    };

    const candidate: IdempotencyEntry = {
      state: "in_flight",
      source: resolved.source,
      id: resolved.id,
      fingerprint,
      createdAt,
      expiresAt: track.expiresAt,
      payer,
    };

    const reservation = await this.store.reserve(key, candidate);
    if (reservation.ok) return { kind: "reserved", track };

    const entry = reservation.existing;
    if (entry.fingerprint !== fingerprint) {
      return { kind: "conflict", reason: REASONS.conflict, entry, track };
    }
    switch (entry.state) {
      case "in_flight":
        return {
          kind: "in_flight",
          reason: REASONS.inFlight,
          entry,
          track,
          retryAfterSeconds: this.options.inFlightRetryAfterSeconds,
        };
      case "settled_pending":
        return { kind: "settled_pending", reason: REASONS.settledPending, entry, track };
      case "completed":
        return { kind: "replay", entry, track };
    }
  }

  /** Funds moved and the resource was produced: bind the result to the id. */
  async complete(
    track: Track,
    result: { settle: SettleResponseLike; response?: StoredResponse },
  ): Promise<IdempotencyEntry> {
    const entry: IdempotencyEntry = {
      state: "completed",
      source: track.source,
      id: track.id,
      fingerprint: track.fingerprint,
      createdAt: track.createdAt,
      expiresAt: track.expiresAt,
      payer: result.settle.payer ?? track.payer,
      settle: result.settle,
      response: this.options.replay === "re-execute" ? undefined : result.response,
    };
    await this.store.set(track.key, entry);
    return entry;
  }

  /**
   * Funds (may have) moved but we cannot vouch for the outcome — e.g. the
   * facilitator returned `settlement_pending`, or a pre-handler settle ran and the
   * handler has not finished. Keep the key taken; never silently re-charge.
   */
  async markSettledPending(track: Track, settle: SettleResponseLike): Promise<IdempotencyEntry> {
    const entry: IdempotencyEntry = {
      state: "settled_pending",
      source: track.source,
      id: track.id,
      fingerprint: track.fingerprint,
      createdAt: track.createdAt,
      expiresAt: track.expiresAt,
      payer: settle.payer ?? track.payer,
      settle,
    };
    await this.store.set(track.key, entry);
    return entry;
  }

  /** Nothing settled: free the id so the client can retry with a new payment. */
  async release(track: Track): Promise<void> {
    await this.store.delete(track.key);
  }

  /** Build a StoredResponse from raw bytes, honouring the size cap. */
  toStoredResponse(
    status: number,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
  ): StoredResponse {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const keep: Record<string, string> = {};
    for (const name of ["content-type", "payment-response", "x-payment-response", "cache-control", "etag"]) {
      const v = lower[name];
      if (v !== undefined) keep[name] = v;
    }
    const stored: StoredResponse = { status, contentType: lower["content-type"], headers: keep };
    if (body && body.byteLength <= this.options.maxStoredBodyBytes) {
      if (isUtf8(body)) {
        stored.body = new TextDecoder().decode(body);
        stored.encoding = "utf8";
      } else {
        stored.body = bytesToBase64(body);
        stored.encoding = "base64";
      }
    }
    return stored;
  }
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Decode a StoredResponse body back to bytes. */
export function storedBodyBytes(r: StoredResponse | undefined): Uint8Array | undefined {
  if (!r?.body) return undefined;
  if (r.encoding === "base64") {
    const bin = atob(r.body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(r.body);
}
