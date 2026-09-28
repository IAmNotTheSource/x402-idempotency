import {
  PAYMENT_IDENTIFIER,
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_PATTERN,
  type IdSource,
  type PaymentPayloadLike,
  type PaymentRequirementsLike,
  type RequestFacts,
} from "./types.js";

// ---------------------------------------------------------------------------
// Encoding helpers (runtime-agnostic: Node, Workers, Bun, Deno)
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalised = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Decode a base64 JSON header (PAYMENT-SIGNATURE / X-PAYMENT / PAYMENT-RESPONSE). */
export function decodeBase64Json<T = unknown>(b64: string): T | undefined {
  try {
    const text = new TextDecoder().decode(base64ToBytes(b64));
    const parsed = JSON.parse(text) as T;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function encodeBase64Json(value: unknown): string {
  return utf8ToBase64(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// payment-identifier extension
// ---------------------------------------------------------------------------

export function isValidPaymentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length >= PAYMENT_ID_MIN_LENGTH &&
    id.length <= PAYMENT_ID_MAX_LENGTH &&
    PAYMENT_ID_PATTERN.test(id)
  );
}

/** The client-supplied `extensions["payment-identifier"].info.id`, if valid. */
export function extractPaymentIdentifier(payload: PaymentPayloadLike | undefined): string | undefined {
  const ext = payload?.extensions?.[PAYMENT_IDENTIFIER] as { info?: { id?: unknown } } | undefined;
  const id = ext?.info?.id;
  return isValidPaymentId(id) ? id : undefined;
}

/** Payer address for scoping, best effort across schemes. */
export function extractPayer(payload: PaymentPayloadLike | undefined): string | undefined {
  const p = payload?.payload;
  if (!p) return undefined;
  const auth = p["authorization"] as { from?: unknown } | undefined;
  const from = auth?.from ?? p["from"] ?? p["payer"];
  return typeof from === "string" ? from.toLowerCase() : undefined;
}

/**
 * Identity of the *signed payment itself*. A byte-identical resend of a settled
 * payment maps to the same identity; a fresh signature (new nonce) does not.
 */
export async function derivePaymentIdentity(payload: PaymentPayloadLike): Promise<string> {
  const p = payload.payload ?? {};
  const auth = p["authorization"] as { from?: unknown; nonce?: unknown } | undefined;
  if (auth && typeof auth.from === "string" && typeof auth.nonce === "string") {
    return `evm:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
  }
  const tx = p["transaction"];
  if (typeof tx === "string" && tx.length > 0) {
    return `tx:${await sha256Hex(tx)}`;
  }
  const sig = p["signature"];
  if (typeof sig === "string" && sig.length > 0) {
    return `sig:${await sha256Hex(sig)}`;
  }
  return `payload:${await sha256Hex(canonicalJson(p))}`;
}

export interface ResolvedId {
  id: string;
  source: IdSource;
}

/**
 * Resolution order: extension id → Idempotency-Key header → derived payment identity.
 */
export async function resolveId(
  payload: PaymentPayloadLike | undefined,
  facts: RequestFacts | undefined,
  opts: { acceptHeader: boolean; derive: boolean },
): Promise<ResolvedId | undefined> {
  const ext = extractPaymentIdentifier(payload);
  if (ext) return { id: ext, source: "extension" };

  if (opts.acceptHeader && facts?.header) {
    const h = facts.header("idempotency-key");
    if (typeof h === "string") {
      const trimmed = h.trim().replace(/^"(.*)"$/, "$1");
      if (trimmed.length > 0 && trimmed.length <= 256) return { id: trimmed, source: "header" };
    }
  }

  if (opts.derive && payload) {
    return { id: await derivePaymentIdentity(payload), source: "payload" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request binding
// ---------------------------------------------------------------------------

export function termsOf(
  payload: PaymentPayloadLike | undefined,
  requirements?: PaymentRequirementsLike,
): PaymentRequirementsLike | undefined {
  const t = requirements ?? payload?.accepted;
  if (!t) return undefined;
  return { scheme: t.scheme, network: t.network, amount: t.amount, asset: t.asset, payTo: t.payTo };
}

/**
 * Default fingerprint per payment_identifier.md "Request Binding":
 * payment terms + method + path + query + body. Deliberately EXCLUDES the
 * signature and nonce so a lost-response retry that re-signs with a fresh nonce
 * (same id) is recognised as the same purchase instead of charged twice.
 */
export function defaultFingerprint(
  facts: RequestFacts,
  _payload: PaymentPayloadLike | undefined,
  terms: PaymentRequirementsLike | undefined,
): unknown {
  return {
    terms: terms
      ? {
          scheme: terms.scheme,
          network: terms.network,
          asset: typeof terms.asset === "string" ? terms.asset.toLowerCase() : terms.asset,
          amount: terms.amount,
          payTo: typeof terms.payTo === "string" ? terms.payTo.toLowerCase() : terms.payTo,
        }
      : null,
    method: facts.method.toUpperCase(),
    path: facts.path,
    query: facts.query ?? null,
    body: normaliseBody(facts.body),
  };
}

function normaliseBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body.length === 0 ? null : { text: body };
  if (body instanceof Uint8Array) return { bytes: bytesToBase64(body) };
  return body;
}

export function buildKey(scope: string, payer: string | undefined, resolved: ResolvedId): string {
  // payer is part of the id for derived identities already; harmless to repeat.
  return `x402idem:v1:${scope}:${payer ?? "-"}:${resolved.source}:${resolved.id}`;
}

export function defaultScope(): string {
  return "default";
}

export function isJsonContentType(ct: string | undefined): boolean {
  return !!ct && /(^|[;\s])(application\/json|application\/[^;\s]+\+json|text\/json)/i.test(ct);
}

export function isTextContentType(ct: string | undefined): boolean {
  return !!ct && /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+(json|xml))/i.test(ct);
}
