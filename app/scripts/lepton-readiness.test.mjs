import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LEPTON_M1_DEPLOYMENTS,
  LEPTON_WRITE_REASON,
  classifyLeptonV4Readiness,
  runLeptonWalletAction,
  transactionInputContainsAddress,
} from "../leptonM1Config.js";

const current = LEPTON_M1_DEPLOYMENTS.currentRead;

function readyInput(overrides = {}) {
  return {
    readConfigured: true,
    rpcOk: true,
    adapterHasCode: true,
    sinkHasCode: true,
    adapterBondUSDC: 10_000_000n,
    minBondUSDC: 10_000_000n,
    generationWriteAllowlisted: true,
    generationSourceVerified: true,
    actualEnforcer: current.bondedEnforcer,
    expectedEnforcer: current.bondedEnforcer,
    actualSink: current.v4StyleSink,
    expectedSink: current.v4StyleSink,
    sinkAdapter: current.v4StyleAdapter,
    expectedAdapter: current.v4StyleAdapter,
    sinkRecoverable: true,
    ...overrides,
  };
}

test("zero and sub-minimum bonds disable V4 writes", () => {
  const zero = classifyLeptonV4Readiness(readyInput({ adapterBondUSDC: 0n }));
  const low = classifyLeptonV4Readiness(readyInput({ adapterBondUSDC: 9_999_999n }));
  assert.equal(zero.writeReady, false);
  assert.ok(zero.reasonCodes.includes(LEPTON_WRITE_REASON.BOND_ZERO));
  assert.equal(low.writeReady, false);
  assert.ok(low.reasonCodes.includes(LEPTON_WRITE_REASON.BOND_BELOW_MINIMUM));
});

test("RPC failure disables V4 writes", () => {
  const result = classifyLeptonV4Readiness(readyInput({ rpcOk: false }));
  assert.equal(result.writeReady, false);
  assert.ok(result.reasonCodes.includes(LEPTON_WRITE_REASON.RPC_READ_FAILED));
});

test("sufficient bond cannot make an unverified or nonrecoverable generation write-ready", () => {
  const result = classifyLeptonV4Readiness(
    readyInput({
      generationWriteAllowlisted: false,
      generationSourceVerified: false,
      sinkRecoverable: false,
    }),
  );
  assert.equal(result.writeReady, false);
  assert.deepEqual(result.reasonCodes, [
    LEPTON_WRITE_REASON.GENERATION_NOT_ALLOWLISTED,
    LEPTON_WRITE_REASON.SOURCE_NOT_VERIFIED,
    LEPTON_WRITE_REASON.SINK_NOT_RECOVERABLE,
  ]);
});

test("wrong enforcer or sink binding disables V4 writes", () => {
  const wrongEnforcer = classifyLeptonV4Readiness(
    readyInput({ actualEnforcer: "0x0000000000000000000000000000000000000001" }),
  );
  const wrongSink = classifyLeptonV4Readiness(
    readyInput({ sinkAdapter: "0x0000000000000000000000000000000000000002" }),
  );
  assert.ok(wrongEnforcer.reasonCodes.includes(LEPTON_WRITE_REASON.WRONG_ENFORCER));
  assert.ok(wrongSink.reasonCodes.includes(LEPTON_WRITE_REASON.WRONG_SINK_BINDING));
});

test("disabled readiness produces zero wallet, bundler, or transaction calls", async () => {
  const calls = { wallet: 0, bundler: 0, transaction: 0 };
  const disabled = classifyLeptonV4Readiness(readyInput({ adapterBondUSDC: 0n }));
  await assert.rejects(
    runLeptonWalletAction(disabled, async () => {
      calls.wallet += 1;
      calls.bundler += 1;
      calls.transaction += 1;
    }),
    /No wallet request will be made/,
  );
  assert.deepEqual(calls, { wallet: 0, bundler: 0, transaction: 0 });
});

test("the Lepton handler gates the complete wallet path and does not gate unrelated follower onboarding", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const leptonHandler = source.slice(
    source.indexOf("async function onSponsoredLeptonMandate"),
    source.indexOf("async function onTunePolicy"),
  );
  const followHandler = source.slice(
    source.indexOf("async function onSponsoredFollow"),
    source.indexOf("async function onSponsoredLeptonMandate"),
  );
  assert.ok(leptonHandler.indexOf("runLeptonWalletAction") < leptonHandler.indexOf("loadCredential"));
  assert.ok(leptonHandler.indexOf("runLeptonWalletAction") < leptonHandler.indexOf("sendUserOperation"));
  assert.equal(followHandler.includes("runLeptonWalletAction"), false);
});

test("historical passkey proof and current read deployment remain separate", () => {
  const historical = LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey;
  assert.equal(historical.txHash.startsWith("0x98b8"), true);
  assert.equal(historical.v4StyleAdapter.toLowerCase().startsWith("0x16eb"), true);
  assert.notEqual(historical.v4StyleAdapter.toLowerCase(), current.v4StyleAdapter.toLowerCase());
  assert.equal(LEPTON_M1_DEPLOYMENTS.historicalProofs.morphoStyle.label, "Morpho-style testnet proof");
  assert.equal(LEPTON_M1_DEPLOYMENTS.historicalProofs.morphoStyle.adapter.toLowerCase(), current.morphoStyleAdapter.toLowerCase());
  assert.deepEqual(current.expectedWriteBlockers, [
    LEPTON_WRITE_REASON.BOND_ZERO,
    LEPTON_WRITE_REASON.GENERATION_NOT_ALLOWLISTED,
    LEPTON_WRITE_REASON.SOURCE_NOT_VERIFIED,
    LEPTON_WRITE_REASON.SINK_NOT_RECOVERABLE,
  ]);
});

test("proof input verification fails when the declared generation adapter is absent", () => {
  const historical = LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey;
  const encodedAddress = historical.v4StyleAdapter.slice(2).padStart(64, "0");
  const input = `0x12345678${encodedAddress}`;
  assert.equal(transactionInputContainsAddress(input, historical.v4StyleAdapter), true);
  assert.equal(transactionInputContainsAddress(input, current.v4StyleAdapter), false);
});
