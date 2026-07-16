import assert from "node:assert/strict";
import test from "node:test";

import {
  FLOAT_V2_ACTIVITY_CHECKPOINT,
  FLOAT_V2_DEPLOY_BLOCK,
  FLOAT_V2_TRACKED_EXTERNAL_AGENTS,
} from "../floatV2Config.js";

test("activity checkpoint covers every tracked external agent exactly once", () => {
  const tracked = FLOAT_V2_TRACKED_EXTERNAL_AGENTS.map((entry) => entry.agent.toLowerCase()).sort();
  const checkpointed = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.map((entry) => entry.agent.toLowerCase()).sort();

  assert.deepEqual(checkpointed, tracked);
  assert.equal(new Set(checkpointed).size, checkpointed.length);
  assert.ok(FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber >= FLOAT_V2_DEPLOY_BLOCK);
  assert.ok(Number.isFinite(Date.parse(FLOAT_V2_ACTIVITY_CHECKPOINT.checkedAt)));
});

test("activity checkpoint preserves the verified V2 totals", () => {
  const totals = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.reduce(
    (sum, entry) => ({
      signedIntents: sum.signedIntents + entry.signedIntents,
      providerPaidCount: sum.providerPaidCount + entry.providerPaidCount,
      repaidCount: sum.repaidCount + entry.repaidCount,
      blockedCount: sum.blockedCount + entry.blockedCount,
      providerPaidUSDC: sum.providerPaidUSDC + BigInt(entry.providerPaidUSDC),
      repaidUSDC: sum.repaidUSDC + BigInt(entry.repaidUSDC),
      blockedUSDC: sum.blockedUSDC + BigInt(entry.blockedUSDC),
    }),
    {
      signedIntents: 0,
      providerPaidCount: 0,
      repaidCount: 0,
      blockedCount: 0,
      providerPaidUSDC: 0n,
      repaidUSDC: 0n,
      blockedUSDC: 0n,
    },
  );

  assert.deepEqual(totals, {
    signedIntents: 12,
    providerPaidCount: 12,
    repaidCount: 11,
    blockedCount: 0,
    providerPaidUSDC: 102_000n,
    repaidUSDC: 92_000n,
    blockedUSDC: 0n,
  });
  for (const entry of FLOAT_V2_ACTIVITY_CHECKPOINT.agents) {
    assert.match(entry.latestTxHash || "", /^0x[0-9a-f]{64}$/i);
  }
});
