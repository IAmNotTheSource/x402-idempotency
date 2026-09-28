/**
 * x402-idempotency — shared types.
 *
 * All protocol shapes here are *structural* (duck-typed) so this package has no
 * runtime or type dependency on @x402/core. They mirror x402 v2:
 *   specs/x402-specification-v2.md, specs/extensions/payment_identifier.md
 */

/** Extension key defined by specs/extensions/payment_identifier.md */
export const PAYMENT_IDENTIFIER = "payment-identifier" as const;

export const PAYMENT_ID_MIN_LENGTH = 16;
export const PAYMENT_ID_MAX_LENGTH = 128;
export const PAYMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Machine-readable reasons this package emits (x402 `error` / `invalidReason`). */
export const REASONS = {
  /** Server declared `required: true` and the client sent no extension `id`. → HTTP 400 */
  required: "payment_identifier_required",
  /** Same id, different request fingerprint. → HTTP 409 */
  conflict: "payment_identifier_conflict",
  /** Same id, first request still executing. → HTTP 409 + Retry-After */
  inFlight: "payment_identifier_in_flight",
  /** Same id, money moved but outcome unknown (crash / settlement_pending). → HTTP 409 */
  settledPending: "payment_identifier_settled_pending",
} as const;

export type Reason = (typeof REASONS)[keyof typeof REASONS];

// ---------------------------------------------------------------------------
// x402 wire shapes (minimal, structural)
// ---------------------------------------------------------------------------

export interface PaymentRequirementsLike {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface PaymentPayloadLike {
  x402Version: number;
  resource?: { url?: string; [k: string]: unknown };
  /** v2 */
  accepted?: PaymentRequirementsLike;
  /** v1 carried scheme/network at the top level */
  scheme?: string;
  network?: string;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponseLike {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  [k: string]: unknown;
}

export interface SettleResponseLike {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Store model
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one idempotency key.
 *
 *   (none) --reserve--> in_flight --settle ok--> completed
 *                           |--settle failed (terminal)--> (released)
 *                           |--settlement_pending / crash after settle--> settled_pending
 */
export type EntryState = "in_flight" | "settled_pending" | "completed";

export type IdSource = "extension" | "header" | "payload";

export interface StoredResponse {
  status: number;
  contentType?: string;
  /** Subset of response headers worth replaying (PAYMENT-RESPONSE, content-type, ...). */
  headers?: Record<string, string>;
  /** Body, encoded per `encoding`. Absent when the body was too large or unavailable. */
  body?: string;
  encoding?: "utf8" | "base64";
}

export interface IdempotencyEntry {
  state: EntryState;
  /** Where the id came from. */
  source: IdSource;
  /** The id as seen on the wire (or derived). */
  id: string;
  /** Request-binding fingerprint (sha256 hex) per payment_identifier.md "Request Binding". */
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  payer?: string;
  /** Facilitator settle result (present for completed and settled_pending). */
  settle?: SettleResponseLike;
  /** Captured resource response (present for completed when capture was possible). */
  response?: StoredResponse;
}

export type ReserveResult = { ok: true } | { ok: false; existing: IdempotencyEntry };

/**
 * Storage contract. Implement this over Redis / Postgres / SQLite / KV for
 * multi-replica deployments. `reserve` MUST be atomic (create-if-absent).
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | undefined>;
  /** Atomically create `entry` under `key` unless a live entry exists. */
  reserve(key: string, entry: IdempotencyEntry): Promise<ReserveResult>;
  set(key: string, entry: IdempotencyEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Request facts (transport-agnostic view of the incoming request)
// ---------------------------------------------------------------------------

export interface RequestFacts {
  method: string;
  /** Concrete request path (e.g. "/reports/42"). */
  path: string;
  /** Route pattern if the framework knows it (e.g. "/reports/:id"). */
  route?: string;
  query?: Record<string, unknown>;
  /** Parsed body (object), raw string, or undefined when unavailable. */
  body?: unknown;
  header?: (name: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface IdempotencyOptions {
  /** Defaults to an in-process MemoryStore (single replica only). */
  store?: IdempotencyStore;
  /** How long a key stays bound. Default 24h. */
  ttlMs?: number;
  /** Advertise `required: true` — clients MUST send an extension `id`. Default false. */
  required?: boolean;
  /** Also honour an `Idempotency-Key` HTTP header (draft-ietf-httpapi-idempotency-key-header). Default true. */
  acceptIdempotencyKeyHeader?: boolean;
  /**
   * When the client sends no id at all, derive one from the signed payment itself
   * (EIP-3009 payer+nonce, SVM transaction hash, or a hash of the scheme payload).
   * This makes a byte-identical resend of an already-settled payment a safe replay
   * instead of a facilitator error. Default true.
   */
  deriveFromPayload?: boolean;
  /**
   * Extra key scope (tenant, merchant, facilitator account). The route/path is part
   * of the *fingerprint*, not the scope — reuse of one id across routes is a 409.
   */
  scope?: (facts: RequestFacts, payload: PaymentPayloadLike | undefined) => string | Promise<string>;
  /**
   * Override the request-binding fingerprint. Return any JSON-able value; it is
   * canonicalised and hashed. Default: payment terms + method + path + query + body.
   */
  fingerprint?: (
    facts: RequestFacts,
    payload: PaymentPayloadLike | undefined,
    terms: PaymentRequirementsLike | undefined,
  ) => unknown | Promise<unknown>;
  /** Seconds suggested in Retry-After for in-flight duplicates. Default 5. */
  inFlightRetryAfterSeconds?: number;
  /**
   * "response": replay the captured response body (default).
   * "re-execute": never replay bodies; run the handler again but skip settlement
   *   (only sensible for read-only resources).
   */
  replay?: "response" | "re-execute";
  /** Bodies larger than this are not stored; such entries replay by re-execution. Default 1 MiB. */
  maxStoredBodyBytes?: number;
  /** Annotate SettleResponse.extensions["payment-identifier"].info.replayed on replays. Default true. */
  announceReplay?: boolean;
  /** Clock override for tests. */
  now?: () => number;
}
