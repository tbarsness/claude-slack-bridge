import { test } from "node:test";
import assert from "node:assert/strict";

// turn-queue.ts reads MAX_CONCURRENT_CLAUDE at import time. Pin it so the
// limit test does not depend on the shell's environment.
process.env.MAX_CONCURRENT_CLAUDE = "2";
const { enqueue, claudeLimiter } = await import("./turn-queue.js");

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("two jobs on the same key run in order with no overlap", async () => {
  const events: string[] = [];
  const job = (name: string) => async () => {
    events.push(`${name} start`);
    await tick();
    events.push(`${name} end`);
  };
  await Promise.all([enqueue("chat-a", job("first")), enqueue("chat-a", job("second"))]);
  assert.deepEqual(events, ["first start", "first end", "second start", "second end"]);
});

test("jobs on different keys run concurrently, up to the limit", async () => {
  let active = 0;
  let peak = 0;
  const job = () =>
    claudeLimiter.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    });
  await Promise.all(["k1", "k2", "k3", "k4"].map((key) => enqueue(key, job)));
  assert.equal(peak, 2);
});

test("a job that throws does not block the next job on that key", async () => {
  const failing = enqueue("chat-b", async () => {
    throw new Error("boom");
  });
  let ran = false;
  const next = enqueue("chat-b", async () => {
    ran = true;
  });
  await assert.rejects(failing, /boom/);
  await next;
  assert.equal(ran, true);
});
