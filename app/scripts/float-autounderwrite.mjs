#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Shadow Float autonomous underwriting runner.
//
// Dry run:
//   npm run float:autounderwrite
//
// Apply owner-controlled line updates from receipt-derived evidence:
//   FLOAT_AUTOUNDERWRITE_APPLY=1 npm run float:autounderwrite

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const CHAIN_ID = 5_042_002;
const DEFAULT_BASE_URL = "https://shadow-arc.vercel.app";
const BASE_URL = (clean(env.SHADOW_APP_URL || env.FLOAT_APP_URL || env.VITE_APP_URL) || DEFAULT_BASE_URL).replace(/\/$/, "");
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || "0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const APPLY = clean(env.FLOAT_AUTOUNDERWRITE_APPLY) === "1";
const ALLOW_ACTIVE_DEBT_RAISE = clean(env.FLOAT_AUTOUNDERWRITE_ALLOW_ACTIVE_DEBT_RAISE) === "1";
const APPLY_SCORE_REFRESH = clean(env.FLOAT_AUTOUNDERWRITE_APPLY_SCORE_REFRESH) === "1";
const OWNER_KEY = normalizeKey(clean(env.FLOAT_ADMIN_PRIVATE_KEY || env.PRIVATE_KEY || env.FLOAT_OWNER_PRIVATE_KEY));
const REQUEST_SALT = clean(env.FLOAT_AUTOUNDERWRITE_SALT) || Date.now().toString();
const explicitAgents = parseAgents(process.argv.slice(2).join(" ") || clean(env.FLOAT_AUTOUNDERWRITE_AGENTS));

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });

const abi = parseAbi([
  "function owner() view returns (address)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function grantFloatFromScore(address agent, address wallet, uint8 label, uint16 paidBound, uint16 signedExternalPaid, uint16 repaid, uint16 blocked, uint16 denied, uint16 errorCount, bytes32 mandateId, uint64 expiry) returns (bytes32)",
  "function reduceLimit(address agent, uint256 newLimitUSDC, bytes32 requestHash) returns (bytes32)",
  "function revoke(address agent, bytes32 requestHash) returns (bytes32)",
]);

const state = await fetchJson("/api/float");
if (!state?.configured) throw new Error("Float API is not configured");
if (getAddress(state.float) !== FLOAT) throw new Error(`API float ${state.float} does not match env float ${FLOAT}`);

const standingAgents = Array.isArray(state.standingBoard?.agents) ? state.standingBoard.agents.map((row) => row.agent) : [];
const agents = explicitAgents.length ? explicitAgents : standingAgents.filter((agent) => isAddress(agent)).map((agent) => getAddress(agent));
if (!agents.length) throw new Error("no agents to underwrite; pass addresses or ensure /api/float standingBoard is populated");

let wallet = null;
let account = null;
if (APPLY) {
  if (!OWNER_KEY) throw new Error("FLOAT_AUTOUNDERWRITE_APPLY=1 requires FLOAT_ADMIN_PRIVATE_KEY or PRIVATE_KEY");
  account = privateKeyToAccount(OWNER_KEY);
  wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
  const owner = getAddress(await publicClient.readContract({ address: FLOAT, abi, functionName: "owner" }));
  if (owner !== getAddress(account.address)) throw new Error(`owner key mismatch: contract owner ${owner}, signer ${account.address}`);
}

const rows = [];
for (const agent of unique(agents)) {
  const score = await fetchJson(`/api/float-tools?action=score&address=${agent}`);
  const line = await readLine(agent);
  const row = await planAgent(agent, score, line);
  rows.push(row);
  if (APPLY && row.action !== "none" && row.action !== "defer") {
    await applyAction(row);
  }
}

const result = {
  ok: rows.every((row) => row.safe),
  mode: APPLY ? "apply" : "dry-run",
  baseUrl: BASE_URL,
  float: FLOAT,
  agents: rows.length,
  actions: rows.reduce((acc, row) => {
    acc[row.action] = (acc[row.action] || 0) + 1;
    return acc;
  }, {}),
  rows,
  generatedAt: new Date().toISOString(),
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

async function planAgent(agent, score, line) {
  const currentLimit = BigInt(score.currentLine?.creditLimitUSDC || line.creditLimitUSDC || 0n);
  const currentScore = Number(score.currentLine?.score || line.score || 0);
  const currentStatus = String(score.currentLine?.status || statusName(line.status));
  const activeDebt = BigInt(score.currentLine?.activeDebtUSDC || line.activeDebtUSDC || 0n);
  const recommendedLimit = BigInt(score.computed?.recommendedLimitUSDC || 0);
  const computedScore = Number(score.computed?.score || 0);
  const evidence = score.evidence || {};
  const safe =
    score.evidenceMode === "receipt-derived" &&
    score.evidenceCompleteness?.logFetchComplete === true &&
    score.evidenceCompleteness?.indexedReceiptCountMatchesChain === true;

  const base = {
    agent,
    safe,
    label: score.label,
    labelId: labelId(score.label),
    status: currentStatus,
    currentScore,
    computedScore,
    currentLimitUSDC: currentLimit.toString(),
    recommendedLimitUSDC: recommendedLimit.toString(),
    currentLimitFormatted: formatUnits(currentLimit, 6),
    recommendedLimitFormatted: formatUnits(recommendedLimit, 6),
    activeDebtUSDC: activeDebt.toString(),
    activeDebtFormatted: formatUnits(activeDebt, 6),
    evidence: {
      paidBound: Number(evidence.paidBound || 0),
      signedExternalPaidBound: Number(evidence.signedExternalPaidBound || 0),
      repaid: Number(evidence.repaid || 0),
      blocked: Number(evidence.blocked || 0),
      denied: Number(evidence.denied || 0),
      error: Number(evidence.error || 0),
    },
    evidenceMode: score.evidenceMode,
    evidenceCompleteness: score.evidenceCompleteness,
  };

  if (!safe) return { ...base, action: "none", reason: "unsafe_or_incomplete_score_evidence" };
  if (currentStatus === "DEFAULTED") return { ...base, action: "none", reason: "defaulted_lines_are_terminal_until_full_repay" };
  if (recommendedLimit > currentLimit) {
    if (activeDebt > 0n && !ALLOW_ACTIVE_DEBT_RAISE) {
      return { ...base, action: "defer", reason: "line_raise_waits_for_repayment_to_keep_status_clean" };
    }
    return { ...base, action: "grant_from_score", reason: "receipt_derived_score_supports_higher_limit" };
  }
  if (recommendedLimit < currentLimit) {
    if (recommendedLimit === 0n && activeDebt === 0n) return { ...base, action: "revoke", reason: "receipt_derived_score_supports_zero_limit" };
    return { ...base, action: "reduce_limit", reason: "receipt_derived_score_supports_lower_limit" };
  }
  if (computedScore !== currentScore && activeDebt === 0n && recommendedLimit > 0n && APPLY_SCORE_REFRESH) {
    return { ...base, action: "grant_from_score", reason: "refresh_onchain_score_from_receipt_derived_evidence" };
  }
  if (computedScore !== currentScore) {
    return { ...base, action: "none", reason: "score_changed_but_limit_band_is_unchanged" };
  }
  return { ...base, action: "none", reason: "current_line_matches_receipt_derived_score_band" };
}

async function applyAction(row) {
  const requestHash = keccak256(stringToBytes(`shadow-float-autounderwrite-${row.agent.toLowerCase()}-${row.action}-${REQUEST_SALT}`));
  let tx;
  if (row.action === "grant_from_score") {
    const line = await readLine(row.agent);
    const mandateId = line.mandateId && line.mandateId !== ZERO_HASH ? line.mandateId : keccak256(stringToBytes(`shadow-float-auto-${row.agent.toLowerCase()}`));
    const args = [
      row.agent,
      line.wallet !== ZERO ? line.wallet : row.agent,
      row.labelId,
      row.evidence.paidBound,
      row.evidence.signedExternalPaidBound,
      row.evidence.repaid,
      row.evidence.blocked,
      row.evidence.denied,
      row.evidence.error,
      mandateId,
      0n,
    ];
    await publicClient.simulateContract({ address: FLOAT, abi, functionName: "grantFloatFromScore", args, account });
    tx = await wallet.writeContract({ address: FLOAT, abi, functionName: "grantFloatFromScore", args, account, chain });
  } else if (row.action === "reduce_limit") {
    const args = [row.agent, BigInt(row.recommendedLimitUSDC), requestHash];
    await publicClient.simulateContract({ address: FLOAT, abi, functionName: "reduceLimit", args, account });
    tx = await wallet.writeContract({ address: FLOAT, abi, functionName: "reduceLimit", args, account, chain });
  } else if (row.action === "revoke") {
    const args = [row.agent, requestHash];
    await publicClient.simulateContract({ address: FLOAT, abi, functionName: "revoke", args, account });
    tx = await wallet.writeContract({ address: FLOAT, abi, functionName: "revoke", args, account, chain });
  } else {
    return;
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`${row.action} reverted for ${row.agent}: ${tx}`);
  row.txHash = tx;
}

async function readLine(agent) {
  const line = await publicClient.readContract({ address: FLOAT, abi, functionName: "lines", args: [agent] });
  return {
    wallet: getAddress(line[0]),
    score: Number(line[1]),
    creditLimitUSDC: line[2],
    availableCreditUSDC: line[3],
    activeDebtUSDC: line[4],
    status: Number(line[5]),
    lastReview: Number(line[6]),
    mandateId: line[7],
  };
}

async function fetchJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" } });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  return json;
}

function labelId(label) {
  if (label === "lab") return 3;
  if (label === "invited") return 2;
  if (label === "self-test") return 1;
  return 0;
}

function statusName(status) {
  return ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"][Number(status)] || `STATUS_${status}`;
}

function parseAgents(value) {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!isAddress(item)) throw new Error(`invalid agent address: ${item}`);
      return getAddress(item);
    });
}

function unique(values) {
  return [...new Map(values.map((value) => [value.toLowerCase(), getAddress(value)])).values()];
}

function readEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "").trim()];
      }),
  );
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
