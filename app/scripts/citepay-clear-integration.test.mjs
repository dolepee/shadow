import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CitePay clearance and checkpoint stay before every Float write", async () => {
  const binder = await readFile(new URL("./float-v2-bind-intent.mjs", import.meta.url), "utf8");
  const gate = binder.indexOf("const citepayClearance = await runCitePayClearGate");
  const checkpoint = binder.indexOf("const citepayCheckpoint = await persistCitePayClearanceCheckpoint");
  const mandateWrite = binder.indexOf("const providerMandateTx = await maybeRefreshSponsoredProviderMandate");
  const spendWrite = binder.indexOf("const txHash = await wallet.writeContract");

  assert.ok(gate >= 0, "CitePay gate call is missing");
  assert.ok(checkpoint > gate, "checkpoint must follow the verified clearance");
  assert.ok(mandateWrite > checkpoint, "provider-mandate writes must follow the checkpoint");
  assert.ok(spendWrite > mandateWrite, "Float spend must follow gate, checkpoint, and preview setup");
});

test("production activation stays disabled and no settlement route is callable", async () => {
  const [envExample, gate, checkpoint, binder] = await Promise.all([
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
    readFile(new URL("./citepay-clear-gate.mjs", import.meta.url), "utf8"),
    readFile(new URL("./citepay-clear-checkpoint.mjs", import.meta.url), "utf8"),
    readFile(new URL("./float-v2-bind-intent.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(envExample, /^CITEPAY_CLEAR_ENABLED=0$/m);
  for (const source of [gate, checkpoint, binder]) {
    assert.equal(source.includes("settle_clearance"), false);
    assert.equal(source.includes("/api/clear/settle"), false);
  }
});

test("checkpoint confirmation is downstream of exact provider-payment evidence", async () => {
  const binder = await readFile(new URL("./float-v2-bind-intent.mjs", import.meta.url), "utf8");
  const receiptEvidenceStart = binder.indexOf("const providerPaidFromReceipt");
  const receiptEvidenceEnd = binder.indexOf("const checks", receiptEvidenceStart);
  const receiptEvidence = binder.slice(receiptEvidenceStart, receiptEvidenceEnd);
  const exactPaymentCheck = binder.indexOf("providerPaidExactAmount:");
  const paidBranch = binder.indexOf("checks.providerPaidExactAmount");
  const confirmation = binder.indexOf("? confirmCitePayClearanceCheckpoint");
  const blockedOutcome = binder.indexOf(": recordBlockedCitePayClearanceCheckpoint");

  assert.ok(receiptEvidenceStart >= 0, "receipt payment evidence is missing");
  assert.match(receiptEvidence, /Boolean\(providerTransfer\)/);
  assert.match(receiptEvidence, /paidSpendCommitment/);
  assert.doesNotMatch(receiptEvidence, /providerDelta/);
  assert.ok(exactPaymentCheck >= 0, "exact provider-payment check is missing");
  assert.ok(paidBranch > exactPaymentCheck, "checkpoint outcome must use the completed payment check");
  assert.ok(confirmation > paidBranch, "paid confirmation must be selected only after exact payment");
  assert.ok(blockedOutcome > confirmation, "no-payment receipts need an explicit blocked outcome");
});

test("a previously bound request requires historical direct-provider payment evidence", async () => {
  const binder = await readFile(new URL("./float-v2-bind-intent.mjs", import.meta.url), "utf8");
  const existingBranch = binder.indexOf("if (!isZeroHash(existingReceipt))");
  const paidRead = binder.indexOf('functionName: "paidSpendCommitments"', existingBranch);
  const paymentEvidence = binder.indexOf("await findBoundDirectProviderPayment", existingBranch);
  const checkpointRecovery = binder.indexOf("await recoverCitePayClearanceCheckpoint", existingBranch);
  const paidResult = binder.indexOf("ok: providerPaid", existingBranch);
  const blockedExit = binder.indexOf("process.exit(providerPaid ? 0 : 1)", existingBranch);

  assert.ok(existingBranch >= 0, "existing receipt branch is missing");
  assert.ok(paidRead > existingBranch, "existing receipt must read the paid-spend commitment");
  assert.ok(paymentEvidence > paidRead, "CitePay recovery must inspect the original transaction receipt");
  assert.ok(checkpointRecovery > paymentEvidence, "existing receipts must repair their CitePay checkpoint after payment proof");
  assert.match(
    binder.slice(checkpointRecovery, paidResult),
    /directProviderPayment: paymentEvidence\.providerPaidExactAmount/,
  );
  assert.ok(paidResult > checkpointRecovery, "existing receipt success must follow checkpoint recovery");
  assert.ok(blockedExit > paidResult, "a bound but unpaid receipt must exit as failure");
});
