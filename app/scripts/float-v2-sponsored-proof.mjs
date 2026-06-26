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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Shadow Float V2 proof runner.
//
// This proves the stronger path:
// 1. a sponsor funds a line without owner approval;
// 2. the sponsor sets the allowed provider policy for that line;
// 3. the contract computes the starting line from onchain behavior stats;
// 4. the agent signs an EIP-712 FloatSpendIntent locally;
// 5. the contract verifies signer/nonce/expiry/executor onchain;
// 6. the contract pays the provider directly and opens debt;
// 7. an overspend is blocked with no provider transfer;
// 8. repayment restores capacity and raises the line from behavior.
//
// Required env:
//   FLOAT_SPONSOR_PRIVATE_KEY=0x...
//   FLOAT_AGENT_PRIVATE_KEY=0x...
//
// Optional env:
//   SHADOW_FLOAT=0x...
//   FLOAT_PROVIDER=0x...
//   FLOAT_PROVIDER_PRIVATE_KEY=0x... # records provider-signed delivery receipt
//   FLOAT_ENDPOINT_HASH=0x...
//   FLOAT_V2_LINE_ATOMIC=50000   # sponsor reserve, not operator-set credit
//   FLOAT_V2_SPEND_ATOMIC=10000
//   FLOAT_V2_CLOSE_AFTER=1

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const LEGACY_FLOAT = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const FLOAT_RAW = clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT);
if (!FLOAT_RAW) throw new Error("set SHADOW_FLOAT to the deployed V2 ShadowFloat address before running the V2 proof");
const FLOAT = getAddress(FLOAT_RAW);
if (FLOAT === LEGACY_FLOAT && clean(env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to run V2 proof against the known V1 ShadowFloat address; set SHADOW_FLOAT to V2 or ALLOW_LEGACY_FLOAT=1");
}
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const PROVIDER = getAddress(clean(env.FLOAT_PROVIDER || env.VITE_FLOAT_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937");
const ENDPOINT_HASH =
  clean(env.FLOAT_ENDPOINT_HASH || env.VITE_FLOAT_ENDPOINT_HASH) ||
  "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160";
const LINE_AMOUNT = BigInt(clean(env.FLOAT_V2_LINE_ATOMIC) || "50000");
const SPEND_AMOUNT = BigInt(clean(env.FLOAT_V2_SPEND_ATOMIC) || "10000");
const OVERRUN_AMOUNT = BigInt(clean(env.FLOAT_V2_OVERRUN_ATOMIC) || (LINE_AMOUNT * 2n).toString());
const TTL_SECONDS = BigInt(clean(env.FLOAT_INTENT_TTL) || `${24 * 3600}`);
const CLOSE_AFTER = clean(env.FLOAT_V2_CLOSE_AFTER) === "1";
const SPONSOR_KEY = normalizeKey(clean(env.FLOAT_SPONSOR_PRIVATE_KEY || env.FLOAT_FUNDER_PRIVATE_KEY));
const AGENT_KEY = normalizeKey(clean(env.FLOAT_AGENT_PRIVATE_KEY || env.BUILDER_PRIVATE_KEY));
const PROVIDER_KEY = normalizeKey(clean(env.FLOAT_PROVIDER_PRIVATE_KEY || env.PROVIDER_PRIVATE_KEY));

if (!SPONSOR_KEY) throw new Error("set FLOAT_SPONSOR_PRIVATE_KEY to the line sponsor key");
if (!AGENT_KEY) throw new Error("set FLOAT_AGENT_PRIVATE_KEY to the agent signer key");
if (!/^0x[0-9a-fA-F]{64}$/.test(ENDPOINT_HASH)) throw new Error("FLOAT_ENDPOINT_HASH must be bytes32");
if (LINE_AMOUNT <= 0n || SPEND_AMOUNT <= 0n) throw new Error("line and spend amounts must be positive");

const sponsor = privateKeyToAccount(SPONSOR_KEY);
const agent = privateKeyToAccount(AGENT_KEY);
const providerSigner = PROVIDER_KEY ? privateKeyToAccount(PROVIDER_KEY) : null;
if (providerSigner && getAddress(providerSigner.address) !== PROVIDER) {
  throw new Error(`FLOAT_PROVIDER_PRIVATE_KEY signs ${providerSigner.address}, expected FLOAT_PROVIDER ${PROVIDER}`);
}
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "Arc", symbol: "ARC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const sponsorWallet = createWalletClient({
  account: sponsor,
  chain,
  transport: http(RPC, { timeout: 60_000, retryCount: 3 }),
});

const floatAbi = parseAbi([
  "function openSponsoredLine(address agent,uint256 reserveUSDC,bytes32 mandateId,uint64 lineExpiry,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 providerExpiry) returns (bytes32)",
  "function setSponsoredProviderMandate(address agent,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function requestSignedSpend((address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,uint256 maxDebtUSDC,uint256 nonce,uint256 expiry,address executor,string reason) intent, bytes signature) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function recordProviderDelivery((bytes32 requestHash,address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 responseHash,uint256 deliveredAt) delivery, bytes signature) returns (bytes32)",
  "function previewSpend(address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 requestHash) view returns (bool allowed, uint8 reason)",
  "function repay(address agent,uint256 amountUSDC,bytes32 requestHash) returns (bytes32)",
  "function closeSponsoredLine(address agent,address recipient,bytes32 requestHash) returns (bytes32)",
  "function autonomousLineScore(address agent) view returns (uint16 score,uint256 recommendedLimitUSDC,uint256 cappedLimitUSDC)",
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function providerDeliveryByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function intentNonceUsed(address agent,uint256 nonce) view returns (bool)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const intentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);

const domain = { name: "ShadowFloat", version: "1", chainId: CHAIN_ID, verifyingContract: FLOAT };
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
const providerDeliveryTypes = {
  ProviderDeliveryReceipt: [
    { name: "requestHash", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "responseHash", type: "bytes32" },
    { name: "deliveredAt", type: "uint256" },
  ],
};

const proof = {
  version: 2,
  source: "sponsored-direct-v2",
  network: "arc-testnet",
  float: FLOAT,
  usdc: USDC,
  sponsor: sponsor.address,
  agent: agent.address,
  provider: PROVIDER,
  endpointHash: ENDPOINT_HASH,
  reserveAmountUSDC: LINE_AMOUNT.toString(),
  spendAmountUSDC: SPEND_AMOUNT.toString(),
  txs: {},
  checks: {},
};

console.log("Shadow Float V2 sponsored proof");
console.log(`float    ${FLOAT}`);
console.log(`sponsor  ${sponsor.address}`);
console.log(`agent    ${agent.address}`);
console.log(`provider ${PROVIDER}`);
console.log(`reserve  ${formatUnits(LINE_AMOUNT, 6)} USDC`);
console.log(`spend    ${formatUnits(SPEND_AMOUNT, 6)} USDC`);

await ensureSponsorReady();
await maybeOpenSponsoredLine();

const direct = await signedSpend({
  amount: SPEND_AMOUNT,
  nonce: BigInt(Date.now()),
  reason: "Sponsored Float V2 proof: agent buys an approved paid resource with contract-enforced authorization.",
});
proof.directSpend = direct.public;

const overrun = await signedSpend({
  amount: OVERRUN_AMOUNT,
  maxDebt: OVERRUN_AMOUNT + OVERRUN_AMOUNT / 10n + LINE_AMOUNT,
  nonce: BigInt(Date.now()) + 1n,
  reason: "Sponsored Float V2 proof: over-limit attempt should be blocked before provider payment.",
  expectAllowed: false,
});
proof.blockedSpend = overrun.public;

const debt = (await readLine(agent.address)).activeDebtUSDC;
if (debt > 0n) {
  await ensureAllowance(sponsor.address, FLOAT, debt);
  const repayTx = await writeFloat("repay", [agent.address, debt, randomHash("sponsored-v2-repay")]);
  proof.txs.repay = repayTx;
  const afterRepay = await readLine(agent.address);
  proof.checks.debtCleared = afterRepay.activeDebtUSDC === 0n;
  proof.checks.capacityRestored = afterRepay.availableCreditUSDC === afterRepay.creditLimitUSDC;
  proof.checks.capacityGrewFromBehavior = afterRepay.creditLimitUSDC >= SPEND_AMOUNT * 5n;
  if (!proof.checks.debtCleared || !proof.checks.capacityRestored || !proof.checks.capacityGrewFromBehavior) {
    throw new Error("repay did not clear debt, restore capacity, and grow the line from behavior");
  }
}

if (CLOSE_AFTER) {
  const closeTx = await writeFloat("closeSponsoredLine", [agent.address, sponsor.address, randomHash("sponsored-v2-close")]);
  proof.txs.close = closeTx;
}

proof.ok = Object.values(proof.checks).every(Boolean);
console.log(JSON.stringify(proof, null, 2));
if (!proof.ok) process.exit(1);

async function ensureSponsorReady() {
  const [balance, allowance, gas] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [sponsor.address] }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [sponsor.address, FLOAT] }),
    publicClient.getBalance({ address: sponsor.address }),
  ]);
  if (balance < LINE_AMOUNT + SPEND_AMOUNT) {
    throw new Error(
      `sponsor needs at least ${formatUnits(LINE_AMOUNT + SPEND_AMOUNT, 6)} USDC, has ${formatUnits(balance, 6)}`,
    );
  }
  if (gas === 0n) throw new Error("sponsor has no native Arc gas");
  if (allowance < LINE_AMOUNT + SPEND_AMOUNT) {
    const txHash = await sponsorWallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [FLOAT, LINE_AMOUNT + SPEND_AMOUNT * 2n],
      account: sponsor,
      chain,
    });
    await waitSuccess(txHash, "approve sponsor USDC");
    proof.txs.approve = txHash;
  }
}

async function maybeOpenSponsoredLine() {
  const existing = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "lineSponsors",
    args: [agent.address],
  });
  const existingSponsor = getAddress(existing[0]);
  if (existingSponsor !== zeroAddress()) {
    if (existingSponsor !== sponsor.address) {
      throw new Error(`agent already has a sponsored line from ${existingSponsor}`);
    }
    console.log("sponsored line already exists; refreshing provider mandate");
    proof.checks.sponsorLineExists = true;
    const txHash = await writeFloat("setSponsoredProviderMandate", [
      agent.address,
      PROVIDER,
      ENDPOINT_HASH,
      SPEND_AMOUNT,
      LINE_AMOUNT,
      BigInt(Math.floor(Date.now() / 1000)) + TTL_SECONDS,
      true,
    ]);
    proof.txs.setProviderMandate = txHash;
    return;
  }

  const txHash = await writeFloat("openSponsoredLine", [
    agent.address,
    LINE_AMOUNT,
    randomHash("sponsored-v2-line"),
    BigInt(Math.floor(Date.now() / 1000)) + TTL_SECONDS,
    PROVIDER,
    ENDPOINT_HASH,
    SPEND_AMOUNT,
    LINE_AMOUNT,
    BigInt(Math.floor(Date.now() / 1000)) + TTL_SECONDS,
  ]);
  proof.txs.openSponsoredLine = txHash;
  const lineSponsor = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "lineSponsors",
    args: [agent.address],
  });
  proof.checks.sponsorLineExists = getAddress(lineSponsor[0]) === sponsor.address && lineSponsor[1] === LINE_AMOUNT;
  if (!proof.checks.sponsorLineExists) throw new Error("sponsored line did not open as expected");
  const [score, recommendedLimit, cappedLimit] = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "autonomousLineScore",
    args: [agent.address],
  });
  const openedLine = await readLine(agent.address);
  proof.openedLine = {
    score: Number(score),
    recommendedLimitUSDC: recommendedLimit.toString(),
    cappedLimitUSDC: cappedLimit.toString(),
    creditLimitUSDC: openedLine.creditLimitUSDC.toString(),
    availableCreditUSDC: openedLine.availableCreditUSDC.toString(),
  };
  proof.checks.autonomousBaselineApplied =
    openedLine.score === Number(score) &&
    openedLine.creditLimitUSDC === cappedLimit &&
    openedLine.availableCreditUSDC === cappedLimit;
  if (!proof.checks.autonomousBaselineApplied) throw new Error("autonomous baseline line was not applied");
}

async function signedSpend({ amount, maxDebt = amount + amount / 10n, nonce, reason, expectAllowed = true }) {
  const intent = {
    agent: agent.address,
    provider: PROVIDER,
    endpointHash: ENDPOINT_HASH,
    amountUSDC: amount,
    maxDebtUSDC: maxDebt,
    nonce,
    expiry: BigInt(Math.floor(Date.now() / 1000)) + TTL_SECONDS,
    executor: sponsor.address,
    reason,
  };
  const signature = await agent.signTypedData({ domain, types, primaryType: "FloatSpendIntent", message: intent });
  const requestHash = hashTypedData({ domain, types, primaryType: "FloatSpendIntent", message: intent });
  const [previewAllowed, previewReason] = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "previewSpend",
    args: [agent.address, PROVIDER, ENDPOINT_HASH, amount, requestHash],
  });
  if (Boolean(previewAllowed) !== expectAllowed) {
    throw new Error(`preview expected allowed=${expectAllowed}, got allowed=${previewAllowed} reason=${previewReason}`);
  }

  const providerBefore = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [PROVIDER],
  });
  const txHash = await sponsorWallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "requestSignedSpend",
    args: [intent, signature],
    account: sponsor,
    chain,
  });
  const receipt = await waitSuccess(txHash, expectAllowed ? "requestSignedSpend" : "blocked requestSignedSpend");
  const providerAfter = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [PROVIDER],
  });
  const consumed = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "intentNonceUsed",
    args: [agent.address, nonce],
  });
  const receiptHash = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "receiptByRequestHash",
    args: [requestHash],
  });
  const intentConsumed = receipt.logs.some((log) => {
    if (getAddress(log.address) !== FLOAT) return false;
    const decoded = decodeLog(intentConsumedEvent, log);
    return Boolean(decoded && decoded.args.requestHash?.toLowerCase() === requestHash.toLowerCase());
  });
  const providerTransfer = receipt.logs.some((log) => {
    if (getAddress(log.address) !== USDC) return false;
    const decoded = decodeLog(transferEvent, log);
    return Boolean(
      decoded &&
        getAddress(decoded.args.from) === FLOAT &&
        getAddress(decoded.args.to) === PROVIDER &&
        decoded.args.value === amount,
    );
  });
  const providerDelta = providerAfter - providerBefore;

  if (!consumed || !intentConsumed) throw new Error("contract did not consume the signed intent");
  if (expectAllowed && (!providerTransfer || providerDelta !== amount)) throw new Error("allowed spend did not pay provider");
  if (!expectAllowed && providerDelta !== 0n) throw new Error("blocked spend moved provider funds");

  const key = expectAllowed ? "directProviderPayment" : "blockedOverspendMovedNoFunds";
  proof.checks[key] = expectAllowed ? providerTransfer && providerDelta === amount : providerDelta === 0n;
  let providerDelivery = null;
  if (expectAllowed) {
    providerDelivery = await maybeRecordProviderDelivery({ requestHash, amount });
  }
  return {
    txHash,
    requestHash,
    digest: requestHash,
    signature,
    intent,
    public: {
      txHash,
      requestHash,
      signer: agent.address,
      amountUSDC: amount.toString(),
      allowed: expectAllowed,
      providerDeltaUSDC: providerDelta.toString(),
      receiptHash,
      providerDelivery,
    },
  };
}

async function maybeRecordProviderDelivery({ requestHash, amount }) {
  if (!providerSigner) {
    return { skipped: true, reason: "set FLOAT_PROVIDER_PRIVATE_KEY to record provider-signed delivery" };
  }
  const delivery = {
    requestHash,
    agent: agent.address,
    provider: PROVIDER,
    endpointHash: ENDPOINT_HASH,
    amountUSDC: amount,
    responseHash: randomHash("provider-delivery-response"),
    deliveredAt: BigInt(Math.floor(Date.now() / 1000)),
  };
  const signature = await providerSigner.signTypedData({
    domain,
    types: providerDeliveryTypes,
    primaryType: "ProviderDeliveryReceipt",
    message: delivery,
  });
  const deliveryHash = hashTypedData({
    domain,
    types: providerDeliveryTypes,
    primaryType: "ProviderDeliveryReceipt",
    message: delivery,
  });
  const txHash = await sponsorWallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "recordProviderDelivery",
    args: [delivery, signature],
    account: sponsor,
    chain,
  });
  await waitSuccess(txHash, "recordProviderDelivery");
  const recorded = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "providerDeliveryByRequestHash",
    args: [requestHash],
  });
  proof.checks.providerDeliveryConfirmed = recorded?.toLowerCase() === deliveryHash.toLowerCase();
  if (!proof.checks.providerDeliveryConfirmed) throw new Error("provider delivery receipt did not record");
  proof.txs.providerDelivery = txHash;
  return {
    skipped: false,
    txHash,
    deliveryHash,
    responseHash: delivery.responseHash,
    deliveredAt: delivery.deliveredAt.toString(),
  };
}

async function readLine(agentAddress) {
  const line = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "lines",
    args: [agentAddress],
  });
  return {
    wallet: line[0],
    score: Number(line[1]),
    creditLimitUSDC: line[2],
    availableCreditUSDC: line[3],
    activeDebtUSDC: line[4],
    status: Number(line[5]),
  };
}

async function ensureAllowance(owner, spender, amount) {
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  if (allowance >= amount) return;
  const txHash = await sponsorWallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
    account: sponsor,
    chain,
  });
  await waitSuccess(txHash, "approve repay");
  proof.txs.approveRepay = txHash;
}

async function writeFloat(functionName, args) {
  const txHash = await sponsorWallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName,
    args,
    account: sponsor,
    chain,
  });
  await waitSuccess(txHash, functionName);
  return txHash;
}

async function waitSuccess(hash, label) {
  console.log(`${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return receipt;
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

function randomHash(label) {
  return hashTypedData({
    domain,
    types: {
      ProofHash: [
        { name: "label", type: "string" },
        { name: "time", type: "uint256" },
        { name: "agent", type: "address" },
      ],
    },
    primaryType: "ProofHash",
    message: { label, time: BigInt(Date.now()), agent: agent.address },
  });
}

function zeroAddress() {
  return "0x0000000000000000000000000000000000000000";
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
