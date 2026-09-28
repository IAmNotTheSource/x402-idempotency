import type { IdempotencyEntry, IdempotencyStore, ReserveResult } from "./types.js";

/**
 * The four Redis operations the store needs. Build one with {@link fromNodeRedis}
 * or {@link fromIoredis}, or write your own for any other client (Upstash, Valkey, ...).
 */
export interface RedisCommands {
  get(key: string): Promise<string | null | undefined>;
  /** `SET key value PX ttlMs NX`. Resolves true only when the key was created. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** `SET key value PX ttlMs`. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Structural subset of a `redis` (node-redis v4+) client. */
export interface NodeRedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options: { PX: number; NX?: true }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Structural subset of an `ioredis` client. */
export interface IoredisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, px: "PX", ttlMs: number): Promise<unknown>;
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const asString = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : typeof v === "string" ? v : String(v);

/** Adapt a `redis` (node-redis v4+) client. */
export function fromNodeRedis(client: NodeRedisLike): RedisCommands {
  return {
    get: async key => asString(await client.get(key)),
    setIfAbsent: async (key, value, ttlMs) => (await client.set(key, value, { PX: ttlMs, NX: true })) === "OK",
    set: async (key, value, ttlMs) => {
      await client.set(key, value, { PX: ttlMs });
    },
    del: async key => {
      await client.del(key);
    },
  };
}

/** Adapt an `ioredis` client. */
export function fromIoredis(client: IoredisLike): RedisCommands {
  return {
    get: async key => asString(await client.get(key)),
    setIfAbsent: async (key, value, ttlMs) => (await client.set(key, value, "PX", ttlMs, "NX")) === "OK",
    set: async (key, value, ttlMs) => {
      await client.set(key, value, "PX", ttlMs);
    },
    del: async key => {
      await client.del(key);
    },
  };
}

export interface RedisStoreOptions {
  client: RedisCommands;
  /** Prepended to every key (engine keys already start with `x402idem:v1:`). Default "". */
  keyPrefix?: string;
  now?: () => number;
}

/**
 * Multi-replica store. `reserve` is a single `SET NX PX`, so exactly one replica
 * wins an id; Redis expires entries at the binding's `expiresAt`.
 *
 * ```ts
 * import { createClient } from "redis";
 * import { RedisStore, fromNodeRedis } from "x402-idempotency/redis";
 *
 * const redis = createClient({ url: process.env.REDIS_URL });
 * await redis.connect();
 * const idem = createIdempotency({ store: new RedisStore({ client: fromNodeRedis(redis) }) });
 * ```
 *
 * Redis errors and unreadable entries reject rather than read as "absent": a
 * request that cannot be checked must fail, not be charged again.
 */
export class RedisStore implements IdempotencyStore {
  private readonly client: RedisCommands;
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(opts: RedisStoreOptions) {
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix ?? "";
    this.now = opts.now ?? (() => Date.now());
  }

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const raw = await this.client.get(this.keyPrefix + key);
    if (raw === null || raw === undefined) return undefined;
    const entry = parseEntry(key, raw);
    // Redis expiry is authoritative; this covers clock skew and PX rounding.
    if (entry.expiresAt <= this.now()) return undefined;
    return entry;
  }

  async reserve(key: string, entry: IdempotencyEntry): Promise<ReserveResult> {
    const k = this.keyPrefix + key;
    const value = JSON.stringify(entry);
    // Bounded retry: the holder can expire or be released between SET NX and GET.
    for (let attempt = 0; attempt < 3; attempt++) {
      const ttlMs = this.ttlMs(entry);
      if (await this.client.setIfAbsent(k, value, ttlMs)) return { ok: true };
      const raw = await this.client.get(k);
      if (raw === null || raw === undefined) continue;
      const existing = parseEntry(key, raw);
      if (existing.expiresAt > this.now()) return { ok: false, existing };
      // Expired by our clock but still in Redis: overwriting would race another
      // replica doing the same, so wait out the remainder of its TTL.
      await sleep(Math.min(50, Math.max(1, existing.expiresAt - this.now() + 1)));
    }
    throw new Error(`x402-idempotency: could not reserve "${key}" (entry kept changing)`);
  }

  async set(key: string, entry: IdempotencyEntry): Promise<void> {
    await this.client.set(this.keyPrefix + key, JSON.stringify(entry), this.ttlMs(entry));
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.keyPrefix + key);
  }

  private ttlMs(entry: IdempotencyEntry): number {
    return Math.max(1, Math.ceil(entry.expiresAt - this.now()));
  }
}

function parseEntry(key: string, raw: string): IdempotencyEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`x402-idempotency: entry at "${key}" is not valid JSON`);
  }
  const e = parsed as Partial<IdempotencyEntry> | null;
  if (
    !e ||
    typeof e !== "object" ||
    typeof e.state !== "string" ||
    typeof e.fingerprint !== "string" ||
    typeof e.expiresAt !== "number"
  ) {
    throw new Error(`x402-idempotency: entry at "${key}" is not an idempotency entry`);
  }
  return e as IdempotencyEntry;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
