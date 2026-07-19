import assert from "node:assert/strict";
import test from "node:test";
import { buildFloatV2OperationalHealth, type FloatV2OperationalAgent } from "./floatV2Operations.ts";

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
    treasuryBalanceUSDC: "100000",
    totalSponsoredReserveUSDC: "50000",
    agents: [agent({ activeDebtUSDC: "10000", statusName: "LIMITED" })],
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.reserve.solvent, true);
  assert.equal(result.reserve.surplusUSDC, "50000");
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
