import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_CHECKPOINT_DIR = ".tmp/citepay-clearances";

export class CitePayCheckpointError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CitePayCheckpointError";
    this.code = code;
  }
}

export async function persistCitePayClearanceCheckpoint({
  env,
  clearance,
  requestHash,
  float,
  chainId,
  intent,
  cwd = process.cwd(),
  now = () => new Date(),
}) {
  if (!clearance?.enabled) {
    return {
      filePath: null,
      summary: { enabled: false, status: "disabled" },
    };
  }

  const normalizedRequestHash = bytes32(requestHash, "requestHash");
  const binding = {
    requestHash: normalizedRequestHash,
    chainId: safeInteger(chainId, "chainId"),
    float: address(float, "float"),
    agent: address(intent?.agent, "intent.agent"),
    provider: address(intent?.provider, "intent.provider"),
    endpointHash: bytes32(intent?.endpointHash, "intent.endpointHash"),
    amountUSDC: unsignedInteger(intent?.amountUSDC, "intent.amountUSDC"),
    nonce: unsignedInteger(intent?.nonce, "intent.nonce"),
    expiry: unsignedInteger(intent?.expiry, "intent.expiry"),
    reason: requiredString(intent?.reason, "intent.reason"),
  };
  const citepay = {
    decision: exact(clearance.decision, "CLEARED", "clearance.decision"),
    clearanceId: prefixed(clearance.clearanceId, "clr_", "clearance.clearanceId"),
    clearanceHash: sha256(clearance.clearanceHash, "clearance.clearanceHash"),
    externalRef: bytes32(clearance.externalRef, "clearance.externalRef"),
    inputCommitment: sha256(clearance.inputCommitment, "clearance.inputCommitment"),
    persistedVerified: clearance.persisted?.verified === true,
    quoteVerified: clearance.persisted?.quoteVerified === true,
    amountDueMicro: unsignedInteger(clearance.persisted?.amountDueMicro, "clearance.persisted.amountDueMicro"),
    settlement: clearance.persisted?.settlement,
  };
  if (
    citepay.externalRef !== normalizedRequestHash
    || !citepay.persistedVerified
    || !citepay.quoteVerified
    || citepay.amountDueMicro !== binding.amountUSDC
    || citepay.settlement !== null
    || binding.reason !== `citepay-clear:${citepay.inputCommitment}`
  ) {
    throw new CitePayCheckpointError(
      "clearance_binding_invalid",
      "refusing to checkpoint a CitePay clearance that is not exactly bound and publicly verified",
    );
  }

  const bindingHash = hashJson({ binding, citepay });
  const checkpointId = `shcp_${bindingHash.slice(7, 31)}`;
  const directory = checkpointDirectory(env?.CITEPAY_CLEAR_CHECKPOINT_DIR, cwd);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const filePath = join(directory, `${normalizedRequestHash.slice(2)}.json`);

  const existing = await readExisting(filePath);
  if (existing) {
    if (existing.bindingHash !== bindingHash || existing.requestHash !== normalizedRequestHash) {
      throw new CitePayCheckpointError(
        "checkpoint_conflict",
        "an existing CitePay checkpoint has different bindings for this Float requestHash",
      );
    }
    if (existing.status === "confirmed") {
      throw new CitePayCheckpointError(
        "checkpoint_already_confirmed",
        "this CitePay clearance is already bound to a confirmed Float transaction",
      );
    }
    if (existing.status !== "cleared_not_submitted") {
      throw new CitePayCheckpointError("checkpoint_state_invalid", "the CitePay checkpoint has an unknown state");
    }
    await chmod(filePath, 0o600);
    return {
      filePath,
      summary: publicSummary(existing, cwd, filePath, true),
    };
  }

  const record = {
    version: 1,
    checkpointId,
    integration: "citepay-clear",
    status: "cleared_not_submitted",
    recordedAt: now().toISOString(),
    requestHash: normalizedRequestHash,
    bindingHash,
    binding,
    citepay,
    transaction: null,
  };
  await atomicWriteJson(filePath, record);
  return {
    filePath,
    summary: publicSummary(record, cwd, filePath, false),
  };
}

export async function confirmCitePayClearanceCheckpoint({
  checkpoint,
  txHash,
  receiptHash,
  cwd = process.cwd(),
  now = () => new Date(),
}) {
  if (!checkpoint?.filePath) return checkpoint?.summary ?? { enabled: false, status: "disabled" };

  const normalizedTxHash = bytes32(txHash, "txHash");
  const normalizedReceiptHash = bytes32(receiptHash, "receiptHash");
  const record = await readExisting(checkpoint.filePath);
  if (!record) {
    throw new CitePayCheckpointError(
      "checkpoint_missing",
      "the pre-spend CitePay checkpoint is missing after the Float transaction",
    );
  }

  if (record.status === "confirmed") {
    if (
      record.transaction?.txHash !== normalizedTxHash
      || record.transaction?.receiptHash !== normalizedReceiptHash
    ) {
      throw new CitePayCheckpointError(
        "checkpoint_conflict",
        "the CitePay checkpoint is already bound to a different Float transaction",
      );
    }
    return publicSummary(record, cwd, checkpoint.filePath, true);
  }
  if (record.status !== "cleared_not_submitted") {
    throw new CitePayCheckpointError("checkpoint_state_invalid", "the CitePay checkpoint has an unknown state");
  }

  const confirmed = {
    ...record,
    status: "confirmed",
    confirmedAt: now().toISOString(),
    transaction: {
      txHash: normalizedTxHash,
      receiptHash: normalizedReceiptHash,
    },
  };
  await atomicWriteJson(checkpoint.filePath, confirmed);
  return publicSummary(confirmed, cwd, checkpoint.filePath, false);
}

function checkpointDirectory(configured, cwd) {
  const value = typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_CHECKPOINT_DIR;
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

async function readExisting(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CitePayCheckpointError("checkpoint_unsafe", "CitePay checkpoint path is not a regular file");
  }
  let record;
  try {
    record = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new CitePayCheckpointError("checkpoint_invalid", "CitePay checkpoint is unreadable or malformed");
  }
  if (!validRecord(record)) {
    throw new CitePayCheckpointError("checkpoint_invalid", "CitePay checkpoint bindings or integrity hash are invalid");
  }
  return record;
}

async function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
    const directoryHandle = await open(dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

function publicSummary(record, cwd, filePath, reused) {
  return {
    enabled: true,
    checkpointId: record.checkpointId,
    status: record.status,
    requestHash: record.requestHash,
    clearanceId: record.citepay.clearanceId,
    clearanceHash: record.citepay.clearanceHash,
    externalRef: record.citepay.externalRef,
    path: relative(cwd, filePath),
    reused,
  };
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function validRecord(record) {
  if (
    !record
    || typeof record !== "object"
    || record.version !== 1
    || record.integration !== "citepay-clear"
    || !["cleared_not_submitted", "confirmed"].includes(record.status)
    || !/^shcp_[0-9a-f]{24}$/.test(record.checkpointId || "")
    || !/^sha256:[0-9a-f]{64}$/.test(record.bindingHash || "")
    || !record.binding
    || !record.citepay
    || record.requestHash !== record.binding.requestHash
    || record.requestHash !== record.citepay.externalRef
    || hashJson({ binding: record.binding, citepay: record.citepay }) !== record.bindingHash
    || record.checkpointId !== `shcp_${record.bindingHash.slice(7, 31)}`
  ) return false;

  if (record.status === "cleared_not_submitted") return record.transaction === null;
  return /^0x[0-9a-f]{64}$/.test(record.transaction?.txHash || "")
    && /^0x[0-9a-f]{64}$/.test(record.transaction?.receiptHash || "");
}

function address(value, field) {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw invalid(field);
  return normalized;
}

function bytes32(value, field) {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw invalid(field);
  return normalized;
}

function sha256(value, field) {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw invalid(field);
  return normalized;
}

function prefixed(value, prefix, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized.startsWith(prefix) || normalized.length <= prefix.length) throw invalid(field);
  return normalized;
}

function exact(value, expected, field) {
  if (value !== expected) throw invalid(field);
  return expected;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw invalid(field);
  return value.trim();
}

function unsignedInteger(value, field) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw invalid(field);
  }
  if (parsed < 0n) throw invalid(field);
  return parsed.toString();
}

function safeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(field);
  return value;
}

function invalid(field) {
  return new CitePayCheckpointError("checkpoint_input_invalid", `${field} is invalid`);
}
