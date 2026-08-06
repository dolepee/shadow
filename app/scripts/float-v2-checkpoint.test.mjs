import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FLOAT_V2_ACTIVITY_CHECKPOINT,
  FLOAT_V2_DEPLOY_BLOCK,
  FLOAT_V2_SHADOW_CONTROLLED_SPONSORS,
  FLOAT_V2_TRACKED_AGENTS,
  FLOAT_V2_TRACKED_EXTERNAL_AGENTS,
  FLOAT_V2_TRACKED_SYSTEM_AGENTS,
  FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS,
  FLOAT_V2_VERIFIED_POST_RECLAIM_STATE,
  FLOAT_V2_VERIFIED_SPONSOR_EPOCHS,
  countFloatV2VerifiedReturningAgents,
  countFloatV2VerifiedReturningSponsors,
  reconcileFloatV2CheckpointLatestTx,
  shouldUseFloatV2VerifiedSnapshot,
} from "../floatV2Config.js";

test("activity checkpoint covers every tracked reserve line exactly once", () => {
  const tracked = FLOAT_V2_TRACKED_AGENTS.map((entry) => entry.agent.toLowerCase()).sort();
  const checkpointed = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.map((entry) => entry.agent.toLowerCase()).sort();

  assert.deepEqual(checkpointed, tracked);
  assert.equal(new Set(checkpointed).size, checkpointed.length);
  assert.ok(FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber >= FLOAT_V2_DEPLOY_BLOCK);
  assert.ok(Number.isFinite(Date.parse(FLOAT_V2_ACTIVITY_CHECKPOINT.checkedAt)));
});

test("activity checkpoint preserves the verified V2 totals", () => {
  const external = new Set(FLOAT_V2_TRACKED_EXTERNAL_AGENTS.map((entry) => entry.agent.toLowerCase()));
  const totals = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.filter((entry) => external.has(entry.agent.toLowerCase())).reduce(
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
    signedIntents: 14,
    providerPaidCount: 14,
    repaidCount: 13,
    blockedCount: 0,
    providerPaidUSDC: 108_000n,
    repaidUSDC: 98_000n,
    blockedUSDC: 0n,
  });
  for (const entry of FLOAT_V2_ACTIVITY_CHECKPOINT.agents) {
    assert.match(entry.latestTxHash || "", /^0x[0-9a-f]{64}$/i);
  }
});

test("system lines complete reserve scope without inflating external traction", () => {
  const system = new Set(FLOAT_V2_TRACKED_SYSTEM_AGENTS.map((entry) => entry.agent.toLowerCase()));
  const checkpointed = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.filter((entry) => system.has(entry.agent.toLowerCase()));

  assert.equal(checkpointed.length, 3);
  assert.equal(FLOAT_V2_TRACKED_SYSTEM_AGENTS.reduce((sum, entry) => sum + (entry.category === "system" ? 1 : 0), 0), 3);
  assert.ok(FLOAT_V2_TRACKED_SYSTEM_AGENTS.every((entry) => entry.agentProvenance === "shadow-controlled-signer"));
  assert.equal(
    new Set(FLOAT_V2_TRACKED_AGENTS.map((entry) => entry.agent.toLowerCase())).size,
    FLOAT_V2_TRACKED_AGENTS.length,
  );
});

test("renewed CitePay line proves one returning sponsor and one returning agent", () => {
  const citePaySponsor = "0x5389688243328c26a92b301faeeab5fbf9aff105";
  const citePayLines = FLOAT_V2_TRACKED_EXTERNAL_AGENTS.filter(
    (entry) => entry.verifiedSponsor?.toLowerCase() === citePaySponsor,
  );

  assert.equal(citePayLines.length, 2);
  assert.equal(citePayLines.filter((entry) => entry.retired).length, 1);
  assert.equal(new Set(citePayLines.map((entry) => entry.agent.toLowerCase())).size, 2);

  assert.equal(countFloatV2VerifiedReturningSponsors(), 1);
  assert.equal(countFloatV2VerifiedReturningAgents(), 1);

  const allIntentTxs = FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.flatMap((epoch) =>
    epoch.cycles.map((cycle) => cycle.intentTx),
  );
  const allRepayTxs = FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.flatMap((epoch) =>
    epoch.cycles.map((cycle) => cycle.repayTx),
  );
  const epochKeys = FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.map(
    (epoch) => `${epoch.agent.toLowerCase()}:${epoch.lineEpoch}`,
  );
  assert.equal(new Set(allIntentTxs.map((txHash) => txHash.toLowerCase())).size, allIntentTxs.length);
  assert.equal(new Set(allRepayTxs.map((txHash) => txHash.toLowerCase())).size, allRepayTxs.length);
  assert.equal(new Set(epochKeys).size, epochKeys.length);
  assert.ok(FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.every((epoch) => epoch.lineEpoch > 0));
  assert.ok(FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.every((epoch) => /^0x[0-9a-f]{64}$/i.test(epoch.openedTx)));
  assert.ok(
    FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.every((epoch) =>
      FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS.some(
        (sponsor) => sponsor.toLowerCase() === epoch.sponsor.toLowerCase(),
      ),
    ),
  );

  for (const epoch of FLOAT_V2_VERIFIED_SPONSOR_EPOCHS) {
    const checkpoint = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.find(
      (candidate) => candidate.agent.toLowerCase() === epoch.agent.toLowerCase(),
    );
    assert.ok(checkpoint);
    const attributedIntents = FLOAT_V2_VERIFIED_SPONSOR_EPOCHS
      .filter((candidate) => candidate.agent.toLowerCase() === epoch.agent.toLowerCase())
      .reduce((sum, candidate) => sum + candidate.cycles.length, 0);
    assert.ok(attributedIntents <= checkpoint.signedIntents);
    assert.ok(attributedIntents <= checkpoint.repaidCount);
  }

  const renewedEpoch = FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.find(
    (epoch) => epoch.agent.toLowerCase() === "0x236652ead43fbb0948173fc4ddf23bc0971b274d",
  );
  assert.equal(renewedEpoch?.cycles.length, 2);
  assert.equal(
    countFloatV2VerifiedReturningSponsors(renewedEpoch ? [renewedEpoch] : []),
    1,
  );
  assert.equal(
    countFloatV2VerifiedReturningAgents(renewedEpoch ? [renewedEpoch] : []),
    1,
    "closing a debt-free reserve must not erase completed returning-agent history",
  );

  const retiredEpoch = FLOAT_V2_VERIFIED_SPONSOR_EPOCHS.find(
    (epoch) => epoch.agent.toLowerCase() === "0xdfdea2015f0b176e89a79cb8b4d5ef22be6e044f",
  );
  assert.ok(retiredEpoch);
  const operatorEpoch = {
    ...retiredEpoch,
    sponsor: FLOAT_V2_SHADOW_CONTROLLED_SPONSORS[0],
    lineEpoch: retiredEpoch.lineEpoch + 1,
    openedTx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    cycles: [{
      intentTx: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      repayTx: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }],
  };
  assert.equal(
    countFloatV2VerifiedReturningAgents([retiredEpoch, operatorEpoch]),
    0,
    "a later operator-sponsored intent must not turn a one-intent external epoch into returning traction",
  );
});

test("frontend fallback identifies the renewed CitePay reserve as reclaimed", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const renewedLine = source.match(
    /label: "CitePay sponsor \(renewed line\)"[\s\S]*?latestTxHash: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE\.citePayRenewedLine\.closeTxHash,/,
  );

  assert.ok(renewedLine, "renewed CitePay fallback line must remain present");
  assert.match(renewedLine[0], /sponsorProvenance: "none"/);
  assert.match(renewedLine[0], /behaviorStateReset: true/);
  assert.match(source, /floatV2SponsorProvenance\(agent\) === "verified-external"/);
});

test("API fallback derives its totals and preserves the renewed CitePay cycle", () => {
  const source = readFileSync(new URL("../api/float.ts", import.meta.url), "utf8");
  const renewedLine = source.match(
    /label: "CitePay sponsor \(renewed line\)"[\s\S]*?latestTxHash: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE\.citePayRenewedLine\.closeTxHash,/,
  );

  assert.ok(renewedLine, "API fallback must include the completed Clear-gated cycle");
  assert.match(renewedLine[0], /signedIntents: 2/);
  assert.match(renewedLine[0], /paid: 2/);
  assert.match(renewedLine[0], /repaid: 2/);
  assert.match(source, /const signedIntents = visibleAgents\.reduce/);
  assert.match(source, /const repaidLifecycles = visibleAgents\.reduce/);
  assert.match(source, /agents: operationalAgents/);
});

test("post-reclaim fallback state and no-KV scan budget are coherent", () => {
  const reclaimed = FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine;
  const checkpointEntry = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.find(
    (entry) => entry.agent.toLowerCase() === reclaimed.agent.toLowerCase(),
  );
  assert.equal(checkpointEntry?.latestTxHash, reclaimed.closeTxHash);
  assert.equal(
    reconcileFloatV2CheckpointLatestTx(
      FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.blockNumber,
      reclaimed.agent,
      reclaimed.preReclaimLatestTxHash,
    ),
    reclaimed.closeTxHash,
  );
  assert.equal(
    reconcileFloatV2CheckpointLatestTx(
      FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.blockNumber - 1n,
      reclaimed.agent,
      reclaimed.preReclaimLatestTxHash,
    ),
    reclaimed.preReclaimLatestTxHash,
  );
  assert.equal(
    reconcileFloatV2CheckpointLatestTx(
      FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.blockNumber + 1n,
      reclaimed.agent,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.deepEqual(
    {
      blockNumber: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber,
      checkedAt: FLOAT_V2_ACTIVITY_CHECKPOINT.checkedAt,
      treasuryBalanceUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.treasuryBalanceUSDC,
      totalAvailableCreditUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.totalAvailableCreditUSDC,
      totalSponsoredReserveUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.totalSponsoredReserveUSDC,
      trackedExternalAgentLines: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.trackedExternalAgentLines,
      externallySponsoredLines: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.externallySponsoredLines,
      operatorSponsoredLines: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.operatorSponsoredLines,
    },
    {
      blockNumber: 52_836_679n,
      checkedAt: "2026-07-20T21:02:14.000Z",
      treasuryBalanceUSDC: "1519762",
      totalAvailableCreditUSDC: "540000",
      totalSponsoredReserveUSDC: "1450000",
      trackedExternalAgentLines: 9,
      externallySponsoredLines: 1,
      operatorSponsoredLines: 8,
    },
  );
  assert.equal(shouldUseFloatV2VerifiedSnapshot("source-checkpoint", 52_836_679n, 55_600_911n), true);
  assert.equal(shouldUseFloatV2VerifiedSnapshot("source-checkpoint", 55_590_000n, 55_600_911n), false);
  assert.equal(shouldUseFloatV2VerifiedSnapshot("kv-checkpoint", 52_836_679n, 55_600_911n), false);

  const frontend = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api/float.ts", import.meta.url), "utf8");
  for (const source of [frontend, api]) {
    assert.match(source, /FLOAT_V2_VERIFIED_POST_RECLAIM_STATE\.treasuryBalanceUSDC/);
    assert.match(source, /FLOAT_V2_VERIFIED_POST_RECLAIM_STATE\.totalSponsoredReserveUSDC/);
    assert.match(source, /FLOAT_V2_VERIFIED_POST_RECLAIM_STATE\.citePayRenewedLine/);
  }
});
