import test from "node:test";
import assert from "node:assert/strict";
import { IdempotencyEngine } from "../dist/index.js";
import { RedisStore, fromNodeRedis, fromIoredis } from "../dist/redis.js";
import { payload, settleResponse } from "./helpers.mjs";

/** In-memory stand-in speaking both the node-redis and ioredis `set` dialects. */
function fakeRedis(now = () => Date.now()) {
  const data = new Map();
  const calls = [];
  const live = key => {
    const hit = data.get(key);
    if (hit && hit.expiresAt <= now()) data.delete(key);
    return data.get(key);
  };
  return {
    data,
    calls,
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ...args) {
      calls.push(["set", key, ...args]);
      let px;
      let nx = false;
      if (typeof args[0] === "object") {
        px = args[0].PX;
        nx = args[0].NX === true;
      } else {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "PX") px = args[++i];
          else if (args[i] === "NX") nx = true;
        }
      }
      assert.ok(Number.isInteger(px) && px > 0, "every write carries a positive integer PX");
      if (nx && live(key)) return null;
      data.set(key, { value, expiresAt: now() + px });
      return "OK";
    },
    async del(key) {
      return data.delete(key) ? 1 : 0;
    },
  };
}

const entry = (over = {}) => ({
  state: "in_flight",
  source: "extension",
  id: "pay_0123456789abcdef",
  fingerprint: "f".repeat(64),
  createdAt: 1_000,
  expiresAt: 61_000,
  ...over,
});

const facts = (over = {}) => ({ method: "POST", path: "/reports", body: { q: "btc" }, ...over });
const ID = "pay_0123456789abcdef";

for (const [name, adapt] of [
  ["node-redis", fromNodeRedis],
  ["ioredis", fromIoredis],
]) {
  test(`${name}: reserve is create-if-absent and returns the holder`, async () => {
    let t = 1_000;
    const now = () => t;
    const redis = fakeRedis(now);
    const store = new RedisStore({ client: adapt(redis), now });

    assert.deepEqual(await store.reserve("k", entry()), { ok: true });
    const second = await store.reserve("k", entry({ fingerprint: "e".repeat(64) }));
    assert.equal(second.ok, false);
    assert.equal(second.existing.fingerprint, "f".repeat(64));
  });

  test(`${name}: set overwrites, get round-trips, delete frees the key`, async () => {
    let t = 1_000;
    const now = () => t;
    const store = new RedisStore({ client: adapt(fakeRedis(now)), now });

    await store.reserve("k", entry());
    const done = entry({
      state: "completed",
      settle: settleResponse(),
      response: { status: 200, body: '{"ok":true}', encoding: "utf8", headers: { "content-type": "application/json" } },
    });
    await store.set("k", done);
    assert.deepEqual(await store.get("k"), done);

    await store.delete("k");
    assert.equal(await store.get("k"), undefined);
    assert.deepEqual(await store.reserve("k", entry()), { ok: true });
  });

  test(`${name}: TTL follows expiresAt, and an expired id can be reserved again`, async () => {
    let t = 1_000;
    const now = () => t;
    const redis = fakeRedis(now);
    const store = new RedisStore({ client: adapt(redis), now });

    await store.reserve("k", entry({ expiresAt: 61_000 }));
    assert.equal(redis.data.get("k").expiresAt, 61_000);

    t = 31_000;
    await store.set("k", entry({ state: "completed", expiresAt: 61_000 }));
    assert.equal(redis.data.get("k").expiresAt, 61_000, "completing does not extend the binding");

    t = 61_000;
    assert.equal(await store.get("k"), undefined);
    assert.deepEqual(await store.reserve("k", entry({ createdAt: t, expiresAt: t + 60_000 })), { ok: true });
  });
}

test("keyPrefix namespaces every operation", async () => {
  const redis = fakeRedis();
  const store = new RedisStore({ client: fromNodeRedis(redis), keyPrefix: "shop-a:" });
  const e = entry({ createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  await store.reserve("k", e);
  assert.deepEqual([...redis.data.keys()], ["shop-a:k"]);
  assert.deepEqual(await store.get("k"), e);
  await store.delete("k");
  assert.equal(redis.data.size, 0);
});

test("unreadable entries reject instead of reading as absent", async () => {
  const redis = fakeRedis();
  const store = new RedisStore({ client: fromNodeRedis(redis) });
  const live = Date.now() + 60_000;

  redis.data.set("bad-json", { value: "{not json", expiresAt: live });
  await assert.rejects(store.get("bad-json"), /not valid JSON/);
  await assert.rejects(store.reserve("bad-json", entry({ expiresAt: live })), /not valid JSON/);

  redis.data.set("wrong-shape", { value: '{"hello":"world"}', expiresAt: live });
  await assert.rejects(store.get("wrong-shape"), /not an idempotency entry/);
  assert.equal(redis.data.size, 2, "nothing was overwritten");
});

test("Redis failures propagate (a request that cannot be checked must not proceed)", async () => {
  const down = {
    get: async () => {
      throw new Error("ECONNREFUSED");
    },
    set: async () => {
      throw new Error("ECONNREFUSED");
    },
    del: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  const engine = new IdempotencyEngine({ store: new RedisStore({ client: fromIoredis(down) }) });
  await assert.rejects(engine.begin(payload({ id: ID }), facts()), /ECONNREFUSED/);
});

test("reserve retries when the holder disappears between SET NX and GET", async () => {
  const redis = fakeRedis();
  let first = true;
  const client = fromNodeRedis(redis);
  const racy = {
    ...client,
    setIfAbsent: async (k, v, ttl) => {
      if (first) {
        first = false;
        return false; // another replica held it...
      }
      return client.setIfAbsent(k, v, ttl);
    },
    // ...and released it before we could read it.
  };
  const store = new RedisStore({ client: racy });
  const e = entry({ createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  assert.deepEqual(await store.reserve("k", e), { ok: true });
  assert.deepEqual(await store.get("k"), e);
});

test("two replicas, one Redis: concurrent retries reserve once and replay after completion", async () => {
  const redis = fakeRedis();
  const replicaA = new IdempotencyEngine({ store: new RedisStore({ client: fromNodeRedis(redis) }) });
  const replicaB = new IdempotencyEngine({ store: new RedisStore({ client: fromIoredis(redis) }) });

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? replicaA : replicaB).begin(payload({ id: ID }), facts())),
  );
  const reserved = results.filter(r => r.kind === "reserved");
  assert.equal(reserved.length, 1);
  assert.equal(results.filter(r => r.kind === "in_flight").length, 19);

  await replicaA.complete(reserved[0].track, {
    settle: settleResponse(),
    response: { status: 200, body: "{}", encoding: "utf8" },
  });

  const retry = await replicaB.begin(payload({ id: ID }), facts());
  assert.equal(retry.kind, "replay");
  assert.equal(retry.entry.settle.transaction, settleResponse().transaction);

  const other = await replicaB.begin(payload({ id: ID }), facts({ body: { q: "eth" } }));
  assert.equal(other.kind, "conflict");
});
