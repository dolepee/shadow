import assert from "node:assert/strict";
import test from "node:test";

import { createRpcReadQueue, isTransientRpcReadError } from "./rpc-read-queue.mjs";

test("serializes concurrent RPC reads", async () => {
  let active = 0;
  let maxActive = 0;
  const queue = createRpcReadQueue({ maxAttempts: 1, spacingMs: 0 });
  const operation = async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value;
  };

  const values = await Promise.all([
    queue("first", () => operation(1)),
    queue("second", () => operation(2)),
    queue("third", () => operation(3)),
  ]);

  assert.deepEqual(values, [1, 2, 3]);
  assert.equal(maxActive, 1);
});

test("retries nested Arc request-limit errors", async () => {
  let attempts = 0;
  const retries = [];
  const queue = createRpcReadQueue({
    maxAttempts: 4,
    baseDelayMs: 1,
    maxDelayMs: 2,
    spacingMs: 0,
    random: () => 0,
    sleep: async () => {},
    onRetry: (event) => retries.push(event),
  });

  const result = await queue("lineSponsors", async () => {
    attempts += 1;
    if (attempts < 3) {
      throw Object.assign(new Error("RPC Request failed"), {
        cause: { code: -32011, message: "request limit reached" },
      });
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.equal(retries.length, 2);
});

test("does not retry deterministic contract errors", async () => {
  let attempts = 0;
  const queue = createRpcReadQueue({
    maxAttempts: 4,
    baseDelayMs: 0,
    spacingMs: 0,
    sleep: async () => {},
  });

  await assert.rejects(
    queue("previewSpend", async () => {
      attempts += 1;
      throw new Error("execution reverted: mandate inactive");
    }),
    /mandate inactive/,
  );
  assert.equal(attempts, 1);
});

test("continues queued reads after one operation fails", async () => {
  const queue = createRpcReadQueue({ maxAttempts: 1, spacingMs: 0 });
  const failed = queue("failed", async () => {
    throw new Error("execution reverted");
  });
  const succeeded = queue("succeeded", async () => "ok");

  await assert.rejects(failed, /execution reverted/);
  assert.equal(await succeeded, "ok");
});

test("recognizes common transient transport failures", () => {
  assert.equal(isTransientRpcReadError(new Error("HTTP 429 too many requests")), true);
  assert.equal(isTransientRpcReadError(new Error("fetch failed: ETIMEDOUT")), true);
  assert.equal(isTransientRpcReadError(new Error("execution reverted")), false);
});
