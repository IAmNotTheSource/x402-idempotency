import { IdempotencyEngine, type Decision, type Track } from "./engine.js";
import {
  PAYMENT_IDENTIFIER,
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_PATTERN,
  REASONS,
  type IdempotencyEntry,
  type IdempotencyOptions,
  type IdempotencyStore,
  type PaymentPayloadLike,
  type PaymentRequirementsLike,
  type RequestFacts,
  type SettleResponseLike,
  type VerifyResponseLike,
} from "./types.js";
import { derivePaymentIdentity, isJsonContentType } from "./util.js";

// ---------------------------------------------------------------------------
// Structural mirrors of @x402/core hook contexts (no import needed)
// ---------------------------------------------------------------------------

interface AdapterLike {
  getHeader?(name: string): string | undefined;
  getMethod?(): string;
  getPath?(): string;
  getUrl?(): string;
  getQueryParams?(): Record<string, unknown>;
  getBody?(): unknown;
}

interface HTTPTransportContextLike {
  request?: { adapter?: AdapterLike; method?: string; path?: string; routePattern?: string };
  responseBody?: Uint8Array;
  responseHeaders?: Record<string, string>;
}

export interface HookVerifyContext {
  paymentPayload: PaymentPayloadLike;
  requirements: PaymentRequirementsLike;
  declaredExtensions?: Record<string, unknown>;
  transportContext?: unknown;
}

export interface HookVerifyResultContext extends HookVerifyContext {
  result: VerifyResponseLike;
}

export interface HookSettleContext extends HookVerifyContext {
  phase?: "before-handler" | "after-handler" | string;
}

export interface HookSettleResultContext extends HookSettleContext {
  result: SettleResponseLike;
}

export interface HookSettleFailureContext extends HookSettleContext {
  error: unknown;
}

export interface HookCanceledContext extends HookSettleContext {
  reason?: string;
  settledPhases?: readonly string[];
}

export type BeforeVerifyResult =
  | void
  | { abort: true; reason: string; message?: string }
  | { skip: true; result: VerifyResponseLike };
export type AfterVerifyResult =
  | void
  | { skipHandler: true; response?: { contentType?: string; body?: unknown } }
  | { abort: true; reason: string; message?: string };
export type BeforeSettleResult =
  | void
  | { abort: true; reason: string; message?: string }
  | { skip: true; result: SettleResponseLike };

/** Shape accepted by `x402ResourceServer.registerExtension(...)`. */
export interface IdempotencyResourceServerExtension {
  key: typeof PAYMENT_IDENTIFIER;
  dynamicInfoFields?: string[];
  hooks: {
    onBeforeVerify(declaration: unknown, context: HookVerifyContext): Promise<BeforeVerifyResult>;
    onAfterVerify(declaration: unknown, context: HookVerifyResultContext): Promise<AfterVerifyResult>;
    onBeforeSettle(declaration: unknown, context: HookSettleContext): Promise<BeforeSettleResult>;
    onAfterSettle(declaration: unknown, context: HookSettleResultContext): Promise<void>;
    onSettleFailure(declaration: unknown, context: HookSettleFailureContext): Promise<void>;
    onVerifiedPaymentCanceled(declaration: unknown, context: HookCanceledContext): Promise<void>;
  };
  enrichSettlementResponse(declaration: unknown, context: HookSettleResultContext): Promise<unknown>;
}

export interface PaymentIdentifierDeclaration {
  info: { required: boolean };
  schema: Record<string, unknown>;
}

export const paymentIdentifierSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    required: { type: "boolean" },
    id: {
      type: "string",
      minLength: PAYMENT_ID_MIN_LENGTH,
      maxLength: PAYMENT_ID_MAX_LENGTH,
      pattern: PAYMENT_ID_PATTERN.source,
    },
  },
  required: ["required"],
} as const;

/** Declaration for `PaymentRequired.extensions["payment-identifier"]`. */
export function declarePaymentIdentifier(required = false): PaymentIdentifierDeclaration {
  return { info: { required }, schema: paymentIdentifierSchema };
}

// ---------------------------------------------------------------------------
// Per-request state shared between hooks of one request
// ---------------------------------------------------------------------------

interface RequestState {
  track: Track;
  /** Set when the request is a replay of a completed entry. */
  replayOf?: IdempotencyEntry;
  /** True once a pre-handler settle was recorded as settled_pending. */
  pendingRecorded?: boolean;
}

export interface Idempotency {
  /** The extension: `server.registerExtension(idem.extension)`. */
  extension: IdempotencyResourceServerExtension;
  /** Route declaration: `extensions: { [PAYMENT_IDENTIFIER]: idem.declare() }`. */
  declare(required?: boolean): PaymentIdentifierDeclaration;
  /** Underlying engine for custom transports / servers. */
  engine: IdempotencyEngine;
  store: IdempotencyStore;
  /** Reason → suggested HTTP status, for adapters that can set it. */
  statusFor(reason: string): number;
}

/**
 * Create an idempotency layer for an x402 resource server.
 *
 * ```ts
 * const idem = createIdempotency({ store: new MemoryStore() });
 * const server = new x402ResourceServer(facilitator)
 *   .register("eip155:8453", new ExactEvmScheme())
 *   .registerExtension(idem.extension);
 * const routes = { "POST /reports": { accepts: [...], extensions: { [PAYMENT_IDENTIFIER]: idem.declare() } } };
 * ```
 */
export function createIdempotency(options: IdempotencyOptions = {}): Idempotency {
  const engine = new IdempotencyEngine(options);
  const required = options.required ?? false;

  // WeakMap on the PaymentPayload object (the reference the core threads through
  // verify → handler → settle). Falls back to the payment identity for adapters
  // that clone the payload between phases.
  const byObject = new WeakMap<object, RequestState>();
  const byIdentity = new Map<string, { state: RequestState; at: number }>();
  const STATE_TTL_MS = 10 * 60 * 1000;

  async function identityOf(payload: PaymentPayloadLike): Promise<string> {
    return derivePaymentIdentity(payload);
  }

  function pruneIdentity(): void {
    const cutoff = engine.now() - STATE_TTL_MS;
    for (const [k, v] of byIdentity) if (v.at < cutoff) byIdentity.delete(k);
  }

  async function getState(payload: PaymentPayloadLike): Promise<RequestState | undefined> {
    return byObject.get(payload) ?? byIdentity.get(await identityOf(payload))?.state;
  }

  async function setState(payload: PaymentPayloadLike, state: RequestState): Promise<void> {
    byObject.set(payload, state);
    if (byIdentity.size > 512) pruneIdentity();
    byIdentity.set(await identityOf(payload), { state, at: engine.now() });
  }

  async function clearState(payload: PaymentPayloadLike): Promise<void> {
    byObject.delete(payload);
    byIdentity.delete(await identityOf(payload));
  }

  function abortFor(decision: Decision): { abort: true; reason: string; message?: string } | undefined {
    switch (decision.kind) {
      case "required":
        return {
          abort: true,
          reason: REASONS.required,
          message: "This resource requires extensions.payment-identifier.info.id in the PaymentPayload",
        };
      case "conflict":
        return {
          abort: true,
          reason: REASONS.conflict,
          message: `payment identifier ${decision.track.id} is already bound to a different request`,
        };
      case "in_flight":
        return {
          abort: true,
          reason: REASONS.inFlight,
          message: `a request with payment identifier ${decision.track.id} is still being processed; retry after ${decision.retryAfterSeconds}s`,
        };
      case "settled_pending":
        return {
          abort: true,
          reason: REASONS.settledPending,
          message: `payment identifier ${decision.track.id} was settled (transaction ${decision.entry.settle?.transaction ?? "unknown"} on ${decision.entry.settle?.network ?? "unknown"}) but the outcome is unknown; reconcile before retrying`,
        };
      default:
        return undefined;
    }
  }

  const extension: IdempotencyResourceServerExtension = {
    key: PAYMENT_IDENTIFIER,
    dynamicInfoFields: [],
    hooks: {
      async onBeforeVerify(_decl, ctx) {
        const facts = factsFromTransport(ctx.transportContext, ctx.paymentPayload);
        const decision = await engine.begin(ctx.paymentPayload, facts, ctx.requirements);
        const abort = abortFor(decision);
        if (abort) return abort;
        if (decision.kind === "pass") return;
        if (decision.kind === "replay") {
          await setState(ctx.paymentPayload, { track: decision.track, replayOf: decision.entry });
          const payer = decision.entry.payer ?? decision.entry.settle?.payer;
          return { skip: true, result: { isValid: true, ...(payer ? { payer } : {}) } };
        }
        if (decision.kind !== "reserved") return;
        await setState(ctx.paymentPayload, { track: decision.track });
        return;
      },

      async onAfterVerify(_decl, ctx) {
        const state = await getState(ctx.paymentPayload);
        const entry = state?.replayOf;
        if (!entry) return;
        if (engine.options.replay !== "response") return; // re-execute: handler runs, settle is skipped
        const directive = replayDirective(entry);
        if (!directive) return; // body not replayable through the core; re-execute for free
        return { skipHandler: true, response: directive };
      },

      async onBeforeSettle(_decl, ctx) {
        const state = await getState(ctx.paymentPayload);
        if (!state?.replayOf) return;
        const settle = state.replayOf.settle;
        if (!settle) {
          return {
            abort: true,
            reason: REASONS.settledPending,
            message: "payment identifier is recorded as paid but no settlement receipt was stored",
          };
        }
        return { skip: true, result: { ...settle } };
      },

      async onAfterSettle(_decl, ctx) {
        const state = await getState(ctx.paymentPayload);
        if (!state || state.replayOf) return;
        const result = ctx.result;
        if (!result.success) {
          if (result.errorReason === "settlement_pending" && result.transaction) {
            await engine.markSettledPending(state.track, result);
            state.pendingRecorded = true;
          }
          return;
        }
        if (ctx.phase === "before-handler") {
          // Money is committed but the resource hasn't run yet. If the process dies
          // here the key stays taken and names the transaction.
          await engine.markSettledPending(state.track, result);
          state.pendingRecorded = true;
          return;
        }
        const tc = ctx.transportContext as HTTPTransportContextLike | undefined;
        const response = tc?.responseBody || tc?.responseHeaders
          ? engine.toStoredResponse(200, tc.responseHeaders ?? {}, tc.responseBody)
          : undefined;
        await engine.complete(state.track, { settle: result, response });
        // State is cleared by enrichSettlementResponse, which the core runs next.
      },

      async onSettleFailure(_decl, ctx) {
        const state = await getState(ctx.paymentPayload);
        if (!state || state.replayOf) return;
        const err = (ctx.error ?? {}) as { errorReason?: string; transaction?: string; network?: string; payer?: string };
        if (err.errorReason === "settlement_pending" && err.transaction) {
          await engine.markSettledPending(state.track, {
            success: false,
            errorReason: err.errorReason,
            transaction: err.transaction,
            network: err.network ?? ctx.requirements.network,
            ...(err.payer ? { payer: err.payer } : {}),
          });
        } else if (!state.pendingRecorded) {
          await engine.release(state.track);
        }
        await clearState(ctx.paymentPayload);
      },

      async onVerifiedPaymentCanceled(_decl, ctx) {
        const state = await getState(ctx.paymentPayload);
        if (!state || state.replayOf) return;
        const settledSomething = (ctx.settledPhases?.length ?? 0) > 0 || state.pendingRecorded;
        if (!settledSomething) await engine.release(state.track);
        await clearState(ctx.paymentPayload);
      },
    },

    async enrichSettlementResponse(_decl, ctx) {
      const state = await getState(ctx.paymentPayload);
      if (!state) return undefined;
      // Settlement is over for this request (replayed or fresh): drop the per-request state.
      await clearState(ctx.paymentPayload);
      if (!engine.options.announceReplay) return undefined;
      return {
        info: { required, id: state.track.id, replayed: Boolean(state.replayOf) },
        schema: paymentIdentifierSchema,
      };
    },
  };

  return {
    extension,
    declare: (r = required) => declarePaymentIdentifier(r),
    engine,
    store: engine.store,
    statusFor,
  };
}

/** Suggested HTTP status per reason (payment_identifier.md "Idempotency Behavior"). */
export function statusFor(reason: string): number {
  switch (reason) {
    case REASONS.required:
      return 400;
    case REASONS.conflict:
    case REASONS.inFlight:
    case REASONS.settledPending:
      return 409;
    default:
      return 402;
  }
}

function factsFromTransport(tc: unknown, payload: PaymentPayloadLike): RequestFacts {
  const t = (tc ?? {}) as HTTPTransportContextLike;
  const req = t.request;
  const adapter = req?.adapter;
  const method = adapter?.getMethod?.() ?? req?.method ?? "-";
  const path = adapter?.getPath?.() ?? req?.path ?? pathOfUrl(payload.resource?.url) ?? "-";
  const facts: RequestFacts = { method, path };
  if (req?.routePattern) facts.route = req.routePattern;
  const query = adapter?.getQueryParams?.();
  if (query && Object.keys(query).length > 0) facts.query = query;
  const body = adapter?.getBody?.();
  if (body !== undefined) facts.body = body;
  if (adapter?.getHeader) facts.header = name => adapter.getHeader!(name);
  return facts;
}

function pathOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Turn a stored response into a `skipHandler` directive. The core writes JSON via
 * `res.json` and HTML via `res.send`, so only those two shapes replay through
 * hooks; anything else re-executes the handler (payment still skipped).
 */
function replayDirective(entry: IdempotencyEntry): { contentType: string; body: unknown } | undefined {
  const r = entry.response;
  if (!r?.body || r.encoding === "base64") return undefined;
  const ct = r.contentType ?? "application/json";
  if (isJsonContentType(ct)) {
    try {
      return { contentType: ct, body: JSON.parse(r.body) };
    } catch {
      return undefined;
    }
  }
  if (/text\/html/i.test(ct)) return { contentType: ct, body: r.body };
  return undefined;
}
