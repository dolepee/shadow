import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  parseAbi,
  parseAbiItem,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  confirmCitePayClearanceCheckpoint,
  persistCitePayClearanceCheckpoint,
  recordBlockedCitePayClearanceCheckpoint,
} from "./citepay-clear-checkpoint.mjs";
import { runCitePayClearGate } from "./citepay-clear-gate.mjs";

// Binds an external builder's V2 FloatSpendIntent JSON.
//
// Input JSON shape:
//   { "intent": { ... }, "signature": "0x...", "digest": "0x...", "citepayClear": { ... } }
//
// citepayClear is required only when CITEPAY_CLEAR_ENABLED=1. It contains
// { claim, quote, source } using CitePay Clear's source schema.
//
// Usage:
//   FLOAT_EXECUTOR_PRIVATE_KEY=0x... \
//   node app/scripts/float-v2-bind-intent.mjs signed-intent.json

const env = {
  ...readEnv(".env"),
  ...readEnv(".vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const LEGACY_FLOAT = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const KEY = normalizeKey(
  clean(env.FLOAT_EXECUTOR_PRIVATE_KEY || env.FLOAT_SPONSOR_PRIVATE_KEY || env.FLOAT_FUNDER_PRIVATE_KEY || env.PRIVATE_KEY || env.FLOAT_ADMIN_PRIVATE_KEY),
);
if (!KEY) {
  throw new Error("set FLOAT_EXECUTOR_PRIVATE_KEY to the wallet that is allowed to submit this signed intent");
}

const payload = readPayload();
const signature = clean(payload.signature);
if (!signature) throw new Error("signed intent JSON is missing signature");

const float = getAddress(clean(payload.intent?.float || env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT));
if (!float) throw new Error("set SHADOW_FLOAT or include intent.float");
if (float === LEGACY_FLOAT && clean(env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to bind against the known V1 ShadowFloat address; use V2 or set ALLOW_LEGACY_FLOAT=1");
}

const account = privateKeyToAccount(KEY);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });

const floatAbi = parseAbi([
  "function requestSignedSpend((address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,uint256 maxDebtUSDC,uint256 nonce,uint256 expiry,address executor,string reason) intent, bytes signature) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function previewSpend(address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 requestHash) view returns (bool allowed,uint8 reason)",
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
  "function lineProviderMandates(address agent,address provider) view returns (bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function lineSponsorEpoch(address agent) view returns (uint256)",
  "function lineProviderMandateEpoch(address agent,address provider) view returns (uint256)",
  "function setSponsoredProviderMandate(address agent,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function intentNonceUsed(address agent,uint256 nonce) view returns (bool)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function paidSpendCommitments(bytes32 requestHash) view returns (bytes32)",
  "function providerDeliveryByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const intentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);

const domain = { name: "ShadowFloat", version: "1", chainId: CHAIN_ID, verifyingContract: float };
const types = {
  FloatSpendIntent: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "maxDebtUSDC", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "reason", type: "string" },
  ],
};

const intent = normalizeIntent(payload.intent);
const requestHash = hashTypedData({ domain, types, primaryType: "FloatSpendIntent", message: intent });
if (clean(payload.digest) && clean(payload.digest).toLowerCase() !== requestHash.toLowerCase()) {
  throw new Error(`digest mismatch: payload ${clean(payload.digest)}, recomputed ${requestHash}`);
}

if (intent.executor !== zeroAddress() && getAddress(account.address) !== intent.executor) {
  throw new Error(`executor mismatch: key signs ${account.address}, intent executor is ${intent.executor}`);
}

const recovered = await recoverTypedDataAddress({
  domain,
  types,
  primaryType: "FloatSpendIntent",
  message: intent,
  signature,
});
if (getAddress(recovered) !== intent.agent) {
  throw new Error(`signature recovers ${recovered}, expected agent ${intent.agent}`);
}

const existingReceipt = await publicClient.readContract({
  address: float,
  abi: floatAbi,
  functionName: "receiptByRequestHash",
  args: [requestHash],
});
if (!isZeroHash(existingReceipt)) {
  const paidSpendCommitment = await publicClient.readContract({
    address: float,
    abi: floatAbi,
    functionName: "paidSpendCommitments",
    args: [requestHash],
  });
  const providerPaid = !isZeroHash(paidSpendCommitment);
  console.log(
    JSON.stringify(
      {
        ok: providerPaid,
        alreadyBound: true,
        providerPaid,
        float,
        requestHash,
        receiptHash: existingReceipt,
        paidSpendCommitment,
        verifyUrl: `https://shadow-arc.vercel.app/api/float-tools?action=verify&hash=${requestHash}`,
      },
      null,
      2,
    ),
  );
  process.exit(providerPaid ? 0 : 1);
}

// This is deliberately before every write, including a sponsored-provider
// mandate refresh. Any CitePay error or non-CLEARED decision fails closed.
const citepayClearance = await runCitePayClearGate({
  env,
  payload,
  requestHash,
  signedReason: intent.reason,
  provider: intent.provider,
  endpointHash: intent.endpointHash,
  amountUSDC: intent.amountUSDC,
});
const citepayCheckpoint = await persistCitePayClearanceCheckpoint({
  env,
  clearance: citepayClearance,
  requestHash,
  float,
  chainId: CHAIN_ID,
  intent,
});
const providerMandateTx = await maybeRefreshSponsoredProviderMandate();

const [previewAllowed, previewReason] = await publicClient.readContract({
  address: float,
  abi: floatAbi,
  functionName: "previewSpend",
  args: [intent.agent, intent.provider, intent.endpointHash, intent.amountUSDC, requestHash],
});
if (!previewAllowed) {
  throw new Error(`preview blocked this spend before submit, reason=${previewReason}`);
}

const [providerBefore, lineBefore, sponsorBefore] = await Promise.all([
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [intent.provider] }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "lines", args: [intent.agent] }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "lineSponsors", args: [intent.agent] }),
]);

const txHash = await wallet.writeContract({
  address: float,
  abi: floatAbi,
  functionName: "requestSignedSpend",
  args: [intent, signature],
  account,
  chain,
});
console.error(`requestSignedSpend: ${txHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
if (receipt.status !== "success") throw new Error(`requestSignedSpend reverted: ${txHash}`);

const [providerAfter, lineAfter, consumed, receiptHash, deliveryHash] = await Promise.all([
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [intent.provider] }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "lines", args: [intent.agent] }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "intentNonceUsed", args: [intent.agent, intent.nonce] }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "receiptByRequestHash", args: [requestHash] }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "providerDeliveryByRequestHash", args: [requestHash] }),
]);

const intentConsumed = receipt.logs.some((log) => {
  if (getAddress(log.address) !== float) return false;
  const decoded = decodeLog(intentConsumedEvent, log);
  return Boolean(decoded && decoded.args.requestHash?.toLowerCase() === requestHash.toLowerCase());
});
const providerTransfer = receipt.logs.find((log) => {
  if (getAddress(log.address) !== USDC) return false;
  const decoded = decodeLog(transferEvent, log);
  return Boolean(
    decoded &&
      getAddress(decoded.args.from) === float &&
      getAddress(decoded.args.to) === intent.provider &&
      decoded.args.value === intent.amountUSDC,
  );
});
const providerDelta = providerAfter - providerBefore;

const checks = {
  digestMatches: true,
  signerMatchesAgent: getAddress(recovered) === intent.agent,
  previewAllowed: Boolean(previewAllowed),
  txSucceeded: receipt.status === "success",
  intentConsumed: Boolean(intentConsumed),
  nonceMarkedUsed: Boolean(consumed),
  receiptRecorded: !isZeroHash(receiptHash),
  providerPaidExactAmount: Boolean(providerTransfer) && providerDelta === intent.amountUSDC,
};
let citepayCheckpointSummary = citepayCheckpoint.summary;
if (checks.txSucceeded && checks.receiptRecorded) {
  const finalizeCheckpoint = checks.providerPaidExactAmount
    ? confirmCitePayClearanceCheckpoint
    : recordBlockedCitePayClearanceCheckpoint;
  citepayCheckpointSummary = await finalizeCheckpoint({
    checkpoint: citepayCheckpoint,
    txHash,
    receiptHash,
  });
}
const ok = Object.values(checks).every(Boolean);
const result = {
  ok,
  float,
  usdc: USDC,
  executor: account.address,
  txHash,
  arcscan: `https://testnet.arcscan.app/tx/${txHash}`,
  requestHash,
  digest: requestHash,
  agent: intent.agent,
  provider: intent.provider,
  endpointHash: intent.endpointHash,
  amountUSDC: intent.amountUSDC.toString(),
  maxDebtUSDC: intent.maxDebtUSDC.toString(),
  nonce: intent.nonce.toString(),
  providerPaidUSDC: providerDelta.toString(),
  lineSponsor: {
    sponsor: sponsorBefore[0],
    reserveUSDC: sponsorBefore[1].toString(),
  },
  providerMandateTx,
  lineBefore: lineView(lineBefore),
  lineAfter: lineView(lineAfter),
  receiptHash,
  providerDeliveryHash: deliveryHash,
  citepayClearance,
  citepayCheckpoint: citepayCheckpointSummary,
  checks,
  citepayDirectTransfer: {
    endpoint: "https://citepay-markets.vercel.app/api/ask",
    header: { "X-Arc-Tx-Hash": txHash },
    suggestedBody: { query: "How does Shadow Float V2 work as a sponsor-backed credit line for Arc agents?", policy: "balanced" },
  },
  verifyUrl: `https://shadow-arc.vercel.app/api/float-tools?action=verify&hash=${requestHash}`,
};
console.log(JSON.stringify(result, null, 2));
if (!ok) process.exit(1);

async function maybeRefreshSponsoredProviderMandate() {
  const sponsorInfo = await publicClient.readContract({
    address: float,
    abi: floatAbi,
    functionName: "lineSponsors",
    args: [intent.agent],
  });
  const sponsorAddress = getAddress(sponsorInfo[0]);
  if (sponsorAddress === zeroAddress()) return null;

  const [mandate, currentEpoch, mandateEpoch] = await Promise.all([
    publicClient.readContract({
      address: float,
      abi: floatAbi,
      functionName: "lineProviderMandates",
      args: [intent.agent, intent.provider],
    }),
    publicClient.readContract({
      address: float,
      abi: floatAbi,
      functionName: "lineSponsorEpoch",
      args: [intent.agent],
    }),
    publicClient.readContract({
      address: float,
      abi: floatAbi,
      functionName: "lineProviderMandateEpoch",
      args: [intent.agent, intent.provider],
    }),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const needsRefresh =
    mandateEpoch !== currentEpoch ||
    String(mandate[0]).toLowerCase() !== intent.endpointHash.toLowerCase() ||
    mandate[1] < intent.amountUSDC ||
    mandate[2] < intent.amountUSDC ||
    BigInt(mandate[3]) <= now ||
    !mandate[4];

  if (!needsRefresh) return null;
  if (sponsorAddress !== getAddress(account.address)) {
    throw new Error(
      `provider mandate needs refresh, but executor ${account.address} is not line sponsor ${sponsorAddress}`,
    );
  }

  const dailyLimit = BigInt(clean(env.FLOAT_DAILY_LIMIT_ATOMIC) || sponsorInfo[1].toString());
  const providerExpiry = BigInt(clean(env.FLOAT_PROVIDER_EXPIRY) || intent.expiry.toString());
  if (dailyLimit < intent.amountUSDC) {
    throw new Error(`FLOAT_DAILY_LIMIT_ATOMIC ${dailyLimit} is below spend amount ${intent.amountUSDC}`);
  }
  const txHash = await wallet.writeContract({
    address: float,
    abi: floatAbi,
    functionName: "setSponsoredProviderMandate",
    args: [intent.agent, intent.provider, intent.endpointHash, intent.amountUSDC, dailyLimit, providerExpiry, true],
    account,
    chain,
  });
  console.error(`setSponsoredProviderMandate: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`setSponsoredProviderMandate reverted: ${txHash}`);
  return txHash;
}

function readPayload() {
  const path = clean(process.argv[2] || env.FLOAT_INTENT_PATH);
  if (!path) throw new Error("usage: node app/scripts/float-v2-bind-intent.mjs signed-intent.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeIntent(raw) {
  if (!raw) throw new Error("signed intent JSON is missing intent");
  const chainId = Number(raw.chainId || CHAIN_ID);
  if (chainId !== CHAIN_ID) throw new Error(`wrong chainId ${chainId}, expected ${CHAIN_ID}`);
  const endpointHash = clean(raw.endpointHash);
  if (!/^0x[0-9a-fA-F]{64}$/.test(endpointHash || "")) throw new Error("intent.endpointHash must be bytes32");
  return {
    agent: getAddress(raw.agent),
    provider: getAddress(raw.provider),
    endpointHash,
    amountUSDC: BigInt(raw.amountUSDC),
    maxDebtUSDC: BigInt(raw.maxDebtUSDC),
    nonce: BigInt(raw.nonce),
    expiry: BigInt(raw.expiry),
    executor: getAddress(raw.executor || zeroAddress()),
    reason: String(raw.reason || ""),
  };
}

function lineView(line) {
  return {
    wallet: line[0],
    score: Number(line[1]),
    creditLimitUSDC: line[2].toString(),
    creditLimitFormatted: formatUnits(line[2], 6),
    availableCreditUSDC: line[3].toString(),
    availableCreditFormatted: formatUnits(line[3], 6),
    activeDebtUSDC: line[4].toString(),
    activeDebtFormatted: formatUnits(line[4], 6),
    status: Number(line[5]),
  };
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
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

function isZeroHash(value) {
  return String(value || "").toLowerCase() === "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function zeroAddress() {
  return "0x0000000000000000000000000000000000000000";
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
