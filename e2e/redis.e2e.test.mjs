// Real Redis, real clients. Skipped unless REDIS_URL is set:
//   REDIS_URL=redis://127.0.0.1:6379 node --test redis.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { Redis as IORedis } from "ioredis";
import { IdempotencyEngine } from "../dist/index.js";
import { RedisStore, fromNodeRedis, fromIoredis } from "../dist/redis.js";
import { payload, settleResponse } from "../test/helpers.mjs";

const url = process.env.REDIS_URL;
const skip = url ? false : "REDIS_URL not set";
const facts = (over = {}) => ({ method: "POST", path: "/reports", body: { q: "btc" }, ...over });
const freshId = () => "pay_" + randomUUID().replaceAll("-", "");

async function clients() {
  const node = createClient({ url });
  await node.connect();
  const io = new IORedis(url);
  return { node, io, close: async () => Promise.all([node.quit(), io.quit()]) };
}

test("real redis: 50 concurrent retries across both clients reserve exactly once", { skip }, async () => {
  const c = await clients();
  try {
    const keyPrefix = `e2e:${randomUUID()}:`;
    const a = new IdempotencyEngine({ store: new RedisStore({ client: fromNodeRedis(c.node), keyPrefix }) });
    const b = new IdempotencyEngine({ store: new RedisStore({ client: fromIoredis(c.io), keyPrefix }) });
    const id = freshId();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).begin(payload({ id }), facts())),
    );
    const reserved = results.filter(r => r.kind === "reserved");
    assert.equal(reserved.length, 1);
    assert.equal(results.filter(r => r.kind === "in_flight").length, 49);

    await a.complete(reserved[0].track, {
      settle: settleResponse(),
      response: { status: 200, body: '{"report":"ok"}', encoding: "utf8" },
    });

    const replay = await b.begin(payload({ id }), facts());
    assert.equal(replay.kind, "replay");
    assert.equal(replay.entry.response.body, '{"report":"ok"}');
    assert.equal(replay.entry.settle.transaction, settleResponse().transaction);

    const conflict = await a.begin(payload({ id }), facts({ path: "/expensive" }));
    assert.equal(conflict.kind, "conflict");

    await b.release(reserved[0].track);
    assert.equal((await a.begin(payload({ id }), facts())).kind, "reserved");
  } finally {
    await c.close();
  }
});

test("real redis: entries carry a TTL and expire on the server", { skip }, async () => {
  const c = await clients();
  try {
    const keyPrefix = `e2e:${randomUUID()}:`;
    const engine = new IdempotencyEngine({
      ttlMs: 300,
      store: new RedisStore({ client: fromIoredis(c.io), keyPrefix }),
    });
    const id = freshId();
    const first = await engine.begin(payload({ id }), facts());
    assert.equal(first.kind, "reserved");

    const pttl = await c.io.pttl(keyPrefix + first.track.key);
    assert.ok(pttl > 0 && pttl <= 300, `PTTL ${pttl} within the binding lifetime`);

    await new Promise(r => setTimeout(r, 400));
    assert.equal(await c.io.exists(keyPrefix + first.track.key), 0);
    assert.equal((await engine.begin(payload({ id }), facts())).kind, "reserved");
  } finally {
    await c.close();
  }
});
