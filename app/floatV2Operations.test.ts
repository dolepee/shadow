import assert from "node:assert/strict";
import test from "node:test";
import { buildFloatV2OperationalHealth, type FloatV2OperationalAgent } from "./floatV2Operations.js";

function agent(overrides: Partial<FloatV2OperationalAgent> = {}): FloatV2OperationalAgent {
  return {
    label: "Pilot agent",
    agent: "0x0000000000000000000000000000000000000001",
    activeDebtUSDC: "0",
    sponsorReserveUSDC: "50000",
    sponsorState: "active-reserve",
    statusName: "ELIGIBLE",
    ...overrides,
  };
}

test("healthy reserve with ordinary open debt stays healthy and reports exposure", () => {
  const result = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: "40000",
    totalSponsoredReserveUSDC: "50000",
    agents: [agent({ activeDebtUSDC: "10000", statusName: "LIMITED" })],
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.reserve.solvent, true);
  assert.equal(result.reserve.scopeComplete, true);
  assert.equal(result.reserve.sponsoredDebtDeployedUSDC, "10000");
  assert.equal(result.reserve.custodialReserveFloorUSDC, "40000");
  assert.equal(result.reserve.surplusUSDC, "0");
  assert.equal(result.counts.openDebt, 1);
  assert.equal(result.alerts[0]?.code, "OPEN_DEBT");
  assert.equal(result.alerts[0]?.severity, "info");
});

test("expired debt requires attention without mislabeling it as a default", () => {
  const result = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: "50000",
    totalSponsoredReserveUSDC: "50000",
    agents: [agent({ activeDebtUSDC: "10000", sponsorState: "expired-debt-open", statusName: "LIMITED" })],
  });

  assert.equal(result.status, "attention");
  assert.equal(result.counts.expiredDebtOpen, 1);
  assert.deepEqual(result.alerts.map((alert) => alert.code), ["EXPIRED_DEBT_OPEN"]);
});

test("reserve insolvency is critical and never reports a negative surplus", () => {
  const result = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: "49999",
    totalSponsoredReserveUSDC: "50000",
    agents: [agent()],
  });

  assert.equal(result.status, "critical");
  assert.equal(result.reserve.solvent, false);
  assert.equal(result.reserve.surplusUSDC, "0");
  assert.equal(result.alerts[0]?.code, "RESERVE_INVARIANT_BREACH");
});

test("untracked sponsored lines degrade global solvency instead of raising a false breach", () => {
  const result = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: "40000",
    totalSponsoredReserveUSDC: "100000",
    agents: [agent({ activeDebtUSDC: "10000" })],
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.reserve.solvent, null);
  assert.equal(result.reserve.scopeComplete, false);
  assert.equal(result.reserve.observedFloorCovered, true);
  assert.equal(result.reserve.sponsoredReserveUSDC, "100000");
  assert.equal(result.reserve.observedSponsoredReserveUSDC, "50000");
  assert.equal(result.reserve.custodialReserveFloorUSDC, "40000");
  assert.deepEqual(result.alerts.map((alert) => alert.code), ["RESERVE_SCOPE_INCOMPLETE", "OPEN_DEBT"]);
  assert.equal(result.alerts.some((alert) => alert.code === "RESERVE_INVARIANT_BREACH"), false);
});

test("a tracked reserve deficit remains critical even when global tracking is incomplete", () => {
  const result = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: "39999",
    totalSponsoredReserveUSDC: "100000",
    agents: [agent({ activeDebtUSDC: "10000" })],
  });

  assert.equal(result.status, "critical");
  assert.equal(result.reserve.solvent, null);
  assert.equal(result.reserve.observedFloorCovered, false);
  assert.deepEqual(
    result.alerts.slice(0, 2).map((alert) => alert.code),
    ["RESERVE_SCOPE_INCOMPLETE", "RESERVE_INVARIANT_BREACH"],
  );
});

test("deployed debt is capped by its sponsor reserve when deriving the custody floor", () => {
  const result = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: "1",
    totalSponsoredReserveUSDC: "50000",
    agents: [agent({ activeDebtUSDC: "60000" })],
  });

  assert.equal(result.reserve.sponsoredDebtDeployedUSDC, "50000");
  assert.equal(result.reserve.custodialReserveFloorUSDC, "0");
  assert.equal(result.reserve.solvent, true);
});

test("checkpoint fallback is explicitly degraded and not fresh authorization", () => {
  const result = buildFloatV2OperationalHealth({
    source: "verified-checkpoint",
    degraded: true,
    treasuryBalanceUSDC: "50000",
    totalSponsoredReserveUSDC: "50000",
    agents: [agent({ sponsorState: "expired-reserve-reclaimable" })],
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.alerts.map((alert) => alert.code), ["DATA_DEGRADED", "RESERVE_RECLAIMABLE"]);
});

test("defaulted line is critical even when reserve custody is solvent", () => {
  const result = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: "50000",
    totalSponsoredReserveUSDC: "50000",
    agents: [agent({ activeDebtUSDC: "10000", statusName: "DEFAULTED" })],
  });

  assert.equal(result.status, "critical");
  assert.equal(result.counts.defaulted, 1);
  assert.equal(result.alerts[0]?.code, "DEFAULTED_LINE");
});

test("malformed amounts fail closed", () => {
  assert.throws(
    () => buildFloatV2OperationalHealth({
      source: "live-rpc",
      degraded: false,
      treasuryBalanceUSDC: "not-an-amount",
      totalSponsoredReserveUSDC: "50000",
      agents: [],
    }),
    /treasuryBalanceUSDC/,
  );
});
