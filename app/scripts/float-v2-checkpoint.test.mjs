import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FLOAT_V2_ACTIVITY_CHECKPOINT,
  FLOAT_V2_DEPLOY_BLOCK,
  FLOAT_V2_TRACKED_AGENTS,
  FLOAT_V2_TRACKED_EXTERNAL_AGENTS,
  FLOAT_V2_TRACKED_SYSTEM_AGENTS,
  countFloatV2VerifiedReturningSponsors,
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

  const trackedWithActivity = FLOAT_V2_TRACKED_EXTERNAL_AGENTS.map((entry) => {
    const checkpoint = FLOAT_V2_ACTIVITY_CHECKPOINT.agents.find(
      (candidate) => candidate.agent.toLowerCase() === entry.agent.toLowerCase(),
    );
    assert.ok(checkpoint);
    return { ...entry, signedIntents: checkpoint.signedIntents };
  });

  assert.equal(countFloatV2VerifiedReturningSponsors(trackedWithActivity), 1);
  assert.equal(
    countFloatV2VerifiedReturningSponsors(
      trackedWithActivity.filter((entry) => !entry.retired),
    ),
    1,
  );

  const renewedLine = trackedWithActivity.find(
    (entry) => !entry.retired && entry.verifiedSponsor?.toLowerCase() === citePaySponsor,
  );
  assert.equal(renewedLine?.signedIntents, 2);
});

test("frontend fallback identifies the renewed CitePay reserve as verified external capital", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const renewedLine = source.match(
    /label: "CitePay sponsor \(renewed line\)"[\s\S]*?sponsorState: "active-reserve",/,
  );

  assert.ok(renewedLine, "renewed CitePay fallback line must remain present");
  assert.match(renewedLine[0], /sponsorProvenance: "verified-external"/);
  assert.match(source, /floatV2SponsorProvenance\(agent\) === "verified-external"/);
});

test("API fallback derives its totals and preserves the renewed CitePay cycle", () => {
  const source = readFileSync(new URL("../api/float.ts", import.meta.url), "utf8");
  const renewedLine = source.match(
    /label: "CitePay sponsor \(renewed line\)"[\s\S]*?latestTxHash: "0x1e0279903aba3e728385825e983bc840f9db804142e6314662df33afec54527f",/,
  );

  assert.ok(renewedLine, "API fallback must include the completed Clear-gated cycle");
  assert.match(renewedLine[0], /signedIntents: 2/);
  assert.match(renewedLine[0], /paid: 2/);
  assert.match(renewedLine[0], /repaid: 2/);
  assert.match(source, /const signedIntents = visibleAgents\.reduce/);
  assert.match(source, /const repaidLifecycles = visibleAgents\.reduce/);
  assert.match(source, /agents: operationalAgents/);
});
