import type { IdempotencyEntry, IdempotencyStore, ReserveResult } from "./types.js";

export interface MemoryStoreOptions {
  /** Evict oldest entries beyond this many. Default 10_000. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Single-process store. Correct for one replica; for more than one, implement
 * {@link IdempotencyStore} over Redis (SET NX PX), Postgres (INSERT ... ON CONFLICT),
 * SQLite, or a KV namespace. `reserve` must be create-if-absent.
 */
export class MemoryStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  async reserve(key: string, entry: IdempotencyEntry): Promise<ReserveResult> {
    const existing = await this.get(key);
    if (existing) return { ok: false, existing };
    this.map.set(key, entry);
    this.evict();
    return { ok: true };
  }

  async set(key: string, entry: IdempotencyEntry): Promise<void> {
    // Re-insert to refresh insertion order (LRU-ish on write).
    this.map.delete(key);
    this.map.set(key, entry);
    this.evict();
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Number of live entries (test/diagnostic helper). */
  get size(): number {
    return this.map.size;
  }

  private evict(): void {
    const now = this.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
