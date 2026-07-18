import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CitePayCheckpointError,
  confirmCitePayClearanceCheckpoint,
  persistCitePayClearanceCheckpoint,
  recordBlockedCitePayClearanceCheckpoint,
  recoverCitePayClearanceCheckpoint,
} from "./citepay-clear-checkpoint.mjs";

const requestHash = `0x${"ab".repeat(32)}`;
const clearanceHash = `sha256:${"11".repeat(32)}`;
const inputCommitment = `sha256:${"22".repeat(32)}`;
const clearance = {
  enabled: true,
  decision: "CLEARED",
  clearanceId: "clr_shadow_test",
  clearanceHash,
  externalRef: requestHash,
  inputCommitment,
  persisted: {
    verified: true,
    quoteVerified: true,
    amountDueMicro: 1_000,
    settlement: null,
  },
};
const intent = {
  agent: "0x1111111111111111111111111111111111111111",
  provider: "0x2222222222222222222222222222222222222222",
  endpointHash: `0x${"33".repeat(32)}`,
  amountUSDC: 1_000n,
  nonce: 7n,
  expiry: 1_800_000_000n,
  reason: `citepay-clear:${inputCommitment}`,
};

test("persists a secret-free mode-600 checkpoint before spend and confirms it after receipt", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-checkpoint-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const checkpoint = await persistCitePayClearanceCheckpoint({
    env: {},
    clearance,
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
  });
  assert.equal(checkpoint.summary.status, "cleared_not_submitted");
  assert.equal(checkpoint.summary.reused, false);

  const before = JSON.parse(await readFile(checkpoint.filePath, "utf8"));
  assert.equal(before.citepay.clearanceId, clearance.clearanceId);
  assert.equal(before.citepay.externalRef, requestHash);
  assert.equal(before.citepay.clearanceHash, clearanceHash);
  assert.equal(before.status, "cleared_not_submitted");
  assert.equal(JSON.stringify(before).includes("cpk_"), false);
  assert.equal(JSON.stringify(before).includes("USDC settles"), false);
  assert.equal((await stat(checkpoint.filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(cwd, ".tmp", "citepay-clearances"))).mode & 0o777, 0o700);

  const confirmed = await confirmCitePayClearanceCheckpoint({
    checkpoint,
    txHash: `0x${"55".repeat(32)}`,
    receiptHash: `0x${"66".repeat(32)}`,
    paidSpendCommitment: `0x${"aa".repeat(32)}`,
    cwd,
    now: () => new Date("2026-07-18T12:01:00.000Z"),
  });
  assert.equal(confirmed.status, "confirmed");

  const after = JSON.parse(await readFile(checkpoint.filePath, "utf8"));
  assert.equal(after.transaction.txHash, `0x${"55".repeat(32)}`);
  assert.equal(after.transaction.receiptHash, `0x${"66".repeat(32)}`);
  assert.equal(after.transaction.providerPaid, true);
  assert.equal(after.transaction.paidSpendCommitment, `0x${"aa".repeat(32)}`);
  assert.equal(after.confirmedAt, "2026-07-18T12:01:00.000Z");

  await assert.rejects(
    persistCitePayClearanceCheckpoint({
      env: {},
      clearance,
      requestHash,
      float: "0x4444444444444444444444444444444444444444",
      chainId: 5_042_002,
      intent,
      cwd,
    }),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_terminal",
  );
});

test("a successful blocked Float receipt is terminal but never confirmed as paid", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-blocked-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const checkpoint = await persistCitePayClearanceCheckpoint({
    env: {},
    clearance,
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
  });

  const blocked = await recordBlockedCitePayClearanceCheckpoint({
    checkpoint,
    txHash: `0x${"77".repeat(32)}`,
    receiptHash: `0x${"88".repeat(32)}`,
    cwd,
  });
  assert.equal(blocked.status, "blocked_no_payment");
  const record = JSON.parse(await readFile(checkpoint.filePath, "utf8"));
  assert.equal(record.status, "blocked_no_payment");
  assert.equal(record.transaction.providerPaid, false);

  await assert.rejects(
    confirmCitePayClearanceCheckpoint({
      checkpoint,
      txHash: `0x${"77".repeat(32)}`,
      receiptHash: `0x${"88".repeat(32)}`,
      paidSpendCommitment: `0x${"99".repeat(32)}`,
      cwd,
    }),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_conflict",
  );
});

test("recovers a directly paid checkpoint after a crash without resubmitting", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const input = {
    env: { CITEPAY_CLEAR_ENABLED: "1" },
    clearance,
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
  };
  const checkpoint = await persistCitePayClearanceCheckpoint(input);
  const recovered = await recoverCitePayClearanceCheckpoint({
    ...input,
    txHash: `0x${"44".repeat(32)}`,
    receiptHash: `0x${"55".repeat(32)}`,
    paidSpendCommitment: `0x${"66".repeat(32)}`,
    directProviderPayment: true,
  });
  assert.equal(recovered.status, "confirmed");
  const recoveredRecord = JSON.parse(await readFile(checkpoint.filePath, "utf8"));
  assert.equal(recoveredRecord.transaction.txHash, `0x${"44".repeat(32)}`);
  assert.equal(recoveredRecord.transaction.recovered, false);
  assert.equal(recoveredRecord.transaction.providerPaid, true);

  const normalCwd = await mkdtemp(join(tmpdir(), "shadow-citepay-normal-retry-"));
  t.after(() => rm(normalCwd, { recursive: true, force: true }));
  const normalInput = { ...input, cwd: normalCwd };
  const normalCheckpoint = await persistCitePayClearanceCheckpoint(normalInput);
  await confirmCitePayClearanceCheckpoint({
    checkpoint: normalCheckpoint,
    txHash: `0x${"77".repeat(32)}`,
    receiptHash: `0x${"88".repeat(32)}`,
    paidSpendCommitment: `0x${"99".repeat(32)}`,
    cwd: normalCwd,
  });
  const normalRetry = await recoverCitePayClearanceCheckpoint({
    ...normalInput,
    txHash: `0x${"77".repeat(32)}`,
    receiptHash: `0x${"88".repeat(32)}`,
    paidSpendCommitment: `0x${"99".repeat(32)}`,
    directProviderPayment: true,
  });
  assert.equal(normalRetry.status, "confirmed");
  const normalRecord = JSON.parse(await readFile(normalCheckpoint.filePath, "utf8"));
  assert.equal(normalRecord.transaction.txHash, `0x${"77".repeat(32)}`);
  assert.equal(normalRecord.transaction.recovered, false);
});

test("a paid commitment without a direct provider transfer cannot confirm recovery", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-x402-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const input = {
    env: { CITEPAY_CLEAR_ENABLED: "1" },
    clearance,
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
  };
  const checkpoint = await persistCitePayClearanceCheckpoint(input);

  await assert.rejects(
    recoverCitePayClearanceCheckpoint({
      ...input,
      txHash: `0x${"44".repeat(32)}`,
      receiptHash: `0x${"55".repeat(32)}`,
      paidSpendCommitment: `0x${"66".repeat(32)}`,
      directProviderPayment: false,
    }),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_payment_unverified",
  );
  assert.equal(JSON.parse(await readFile(checkpoint.filePath, "utf8")).status, "cleared_not_submitted");
});

test("enabled recovery fails closed when its pre-spend checkpoint is missing", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-missing-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await assert.rejects(
    recoverCitePayClearanceCheckpoint({
      env: { CITEPAY_CLEAR_ENABLED: "1" },
      requestHash,
      float: "0x4444444444444444444444444444444444444444",
      chainId: 5_042_002,
      intent,
      receiptHash: `0x${"55".repeat(32)}`,
      paidSpendCommitment: `0x${"66".repeat(32)}`,
      cwd,
    }),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_missing",
  );
});

test("pending checkpoint blocks a second binder; changed bindings fail as conflicts", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-retry-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const input = {
    env: {},
    clearance,
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
  };

  await persistCitePayClearanceCheckpoint(input);
  await assert.rejects(
    persistCitePayClearanceCheckpoint(input),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_in_progress",
  );

  await assert.rejects(
    persistCitePayClearanceCheckpoint({
      ...input,
      clearance: { ...clearance, clearanceHash: `sha256:${"77".repeat(32)}` },
    }),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_conflict",
  );
});

test("per-request lock prevents creation and terminal-transition overwrite races", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-lock-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, ".tmp", "citepay-clearances");
  const filePath = join(directory, `${requestHash.slice(2)}.json`);
  const lockPath = `${filePath}.lock`;
  const input = {
    env: {},
    clearance,
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
  };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(lockPath, "held\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    persistCitePayClearanceCheckpoint(input),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_locked",
  );
  await assert.rejects(
    stat(filePath),
    (error) => error?.code === "ENOENT",
  );

  await rm(lockPath);
  const checkpoint = await persistCitePayClearanceCheckpoint(input);
  await writeFile(lockPath, "held\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    confirmCitePayClearanceCheckpoint({
      checkpoint,
      txHash: `0x${"55".repeat(32)}`,
      receiptHash: `0x${"66".repeat(32)}`,
      paidSpendCommitment: `0x${"77".repeat(32)}`,
      cwd,
    }),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_locked",
  );
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).status, "cleared_not_submitted");

  await rm(lockPath);
  const confirmed = await confirmCitePayClearanceCheckpoint({
    checkpoint,
    txHash: `0x${"55".repeat(32)}`,
    receiptHash: `0x${"66".repeat(32)}`,
    paidSpendCommitment: `0x${"77".repeat(32)}`,
    cwd,
  });
  assert.equal(confirmed.status, "confirmed");
});

test("refuses an unverified, mismatched, or already-settled clearance", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-invalid-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const base = {
    env: {},
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
  };
  for (const candidate of [
    { ...clearance, externalRef: `0x${"99".repeat(32)}` },
    { ...clearance, persisted: { ...clearance.persisted, quoteVerified: false } },
    { ...clearance, persisted: { ...clearance.persisted, amountDueMicro: 2_000 } },
    { ...clearance, persisted: { ...clearance.persisted, settlement: { txHash: "0x1" } } },
    { ...clearance, persisted: { ...clearance.persisted, settlement: undefined } },
  ]) {
    await assert.rejects(
      persistCitePayClearanceCheckpoint({ ...base, clearance: candidate }),
      (error) => error instanceof CitePayCheckpointError && error.code === "clearance_binding_invalid",
    );
  }
});

test("detects local checkpoint tampering before reuse", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "shadow-citepay-tamper-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const input = {
    env: {},
    clearance,
    requestHash,
    float: "0x4444444444444444444444444444444444444444",
    chainId: 5_042_002,
    intent,
    cwd,
  };
  const checkpoint = await persistCitePayClearanceCheckpoint(input);
  const record = JSON.parse(await readFile(checkpoint.filePath, "utf8"));
  record.binding.amountUSDC = "999999";
  await writeFile(checkpoint.filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    persistCitePayClearanceCheckpoint(input),
    (error) => error instanceof CitePayCheckpointError && error.code === "checkpoint_invalid",
  );
});

test("disabled gate creates no checkpoint", async () => {
  const result = await persistCitePayClearanceCheckpoint({ clearance: { enabled: false } });
  assert.deepEqual(result, {
    filePath: null,
    summary: { enabled: false, status: "disabled" },
  });
});
