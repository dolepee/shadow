import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL);
const FLOAT = clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT);
const USDC = clean(env.ARC_USDC || env.VITE_ARC_USDC || "0x3600000000000000000000000000000000000000");
const OWNER_KEY = normalizeKey(clean(env.PRIVATE_KEY || env.FLOAT_OWNER_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY));

if (!RPC) throw new Error("missing ARC_RPC_URL or VITE_ARC_RPC_URL");
if (!FLOAT) throw new Error("missing SHADOW_FLOAT or VITE_SHADOW_FLOAT");
if (!OWNER_KEY) throw new Error("missing PRIVATE_KEY or FLOAT_OWNER_PRIVATE_KEY");

const owner = privateKeyToAccount(OWNER_KEY);
const alpha = getAddress(clean(env.FLOAT_ALPHA_ADDRESS) || "0xa100000000000000000000000000000000000001");
const beta = getAddress(clean(env.FLOAT_BETA_ADDRESS) || "0xbE7A000000000000000000000000000000000002");
const provider = getAddress(clean(env.FLOAT_PROVIDER_ADDRESS) || "0xf100000000000000000000000000000000000003");
const endpointLabel = clean(env.FLOAT_ENDPOINT_LABEL) || "paid-resource://shadow-float/market-signal-v1";
const endpointHash = keccak256(stringToBytes(endpointLabel));
const lineAmount = parseUnits(clean(env.FLOAT_LINE_USDC) || "1", 6);
const spendAmount = parseUnits(clean(env.FLOAT_SPEND_USDC) || "0.01", 6);
const overspendAmount = parseUnits(clean(env.FLOAT_OVERSPEND_USDC) || "5", 6);
const treasuryFund = parseUnits(clean(env.FLOAT_TREASURY_FUND_USDC) || "1.25", 6);
const maxPerRequest = parseUnits(clean(env.FLOAT_MAX_PER_REQUEST_USDC) || "1", 6);
const dailyLimit = parseUnits(clean(env.FLOAT_DAILY_LIMIT_USDC) || "2", 6);
const now = Math.floor(Date.now() / 1000);
const salt = `${now}-${Math.random().toString(16).slice(2)}`;

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: owner, chain, transport: http(RPC) });

const floatAbi = parseAbi([
  "function fund(uint256 amountUSDC)",
  "function setProviderMandate(address provider, bytes32 endpointHash, uint256 maxPerRequestUSDC, uint256 dailyLimitUSDC, uint64 expiry, bool active)",
  "function grantFloat(address agent, address wallet, uint256 creditLimitUSDC, uint16 score, bytes32 mandateId) returns (bytes32)",
  "function denyAgent(address agent, address wallet, uint16 score, bytes32 mandateId, bytes32 requestHash) returns (bytes32)",
  "function requestSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function repay(address agent, uint256 amountUSDC, bytes32 requestHash) returns (bytes32)",
  "function receiptCount() view returns (uint256)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalProviderPaidUSDC() view returns (uint256)",
  "function totalDebtOpenedUSDC() view returns (uint256)",
  "function totalBlockedUSDC() view returns (uint256)",
  "function totalDeniedUSDC() view returns (uint256)",
  "function totalRepaidUSDC() view returns (uint256)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
]);

console.log("Shadow Float proof runner");
console.log(`owner    ${owner.address}`);
console.log(`float    ${FLOAT}`);
console.log(`usdc     ${USDC}`);
console.log(`alpha    ${alpha}`);
console.log(`beta     ${beta}`);
console.log(`provider ${provider}`);
console.log(`endpoint ${endpointLabel} ${endpointHash}`);

const ownerUsdc = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [owner.address],
});
console.log(`owner USDC ${formatUnits(ownerUsdc, 6)}`);
if (ownerUsdc < treasuryFund + spendAmount) {
  throw new Error(`owner needs at least ${formatUnits(treasuryFund + spendAmount, 6)} USDC for fund+repay`);
}

await send("approve treasury + repay allowance", USDC, erc20Abi, "approve", [FLOAT, treasuryFund + spendAmount]);
await send("fund Float treasury", FLOAT, floatAbi, "fund", [treasuryFund]);
await send("set approved provider endpoint", FLOAT, floatAbi, "setProviderMandate", [
  provider,
  endpointHash,
  maxPerRequest,
  dailyLimit,
  BigInt(now + 7 * 24 * 60 * 60),
  true,
]);
await send("grant Alpha 1 USDC float", FLOAT, floatAbi, "grantFloat", [
  alpha,
  alpha,
  lineAmount,
  9300,
  keccak256(stringToBytes("shadow-float-alpha-good-history")),
]);
await send("deny Beta float", FLOAT, floatAbi, "denyAgent", [
  beta,
  beta,
  2100,
  keccak256(stringToBytes("shadow-float-beta-slash-history")),
  hash(`beta-denied-${salt}`),
]);
await send("Alpha approved provider spend", FLOAT, floatAbi, "requestSpend", [
  alpha,
  provider,
  endpointHash,
  spendAmount,
  hash(`alpha-allow-${salt}`),
]);
await send("Alpha oversized spend blocked", FLOAT, floatAbi, "requestSpend", [
  alpha,
  provider,
  endpointHash,
  overspendAmount,
  hash(`alpha-block-${salt}`),
]);
await send("Beta credit denied", FLOAT, floatAbi, "requestSpend", [
  beta,
  provider,
  endpointHash,
  spendAmount,
  hash(`beta-denied-spend-${salt}`),
]);
await send("Alpha repays debt", FLOAT, floatAbi, "repay", [alpha, spendAmount, hash(`alpha-repay-${salt}`)]);

const [
  receiptCount,
  treasuryBalance,
  providerPaid,
  debtOpened,
  blocked,
  denied,
  repaid,
  alphaLine,
  betaLine,
] = await Promise.all([
  readFloat("receiptCount", []),
  readFloat("treasuryBalanceUSDC", []),
  readFloat("totalProviderPaidUSDC", []),
  readFloat("totalDebtOpenedUSDC", []),
  readFloat("totalBlockedUSDC", []),
  readFloat("totalDeniedUSDC", []),
  readFloat("totalRepaidUSDC", []),
  readFloat("lines", [alpha]),
  readFloat("lines", [beta]),
]);

console.log("summary");
console.log(
  JSON.stringify(
    {
      receiptCount: receiptCount.toString(),
      treasuryUSDC: formatUnits(treasuryBalance, 6),
      providerPaidUSDC: formatUnits(providerPaid, 6),
      debtOpenedUSDC: formatUnits(debtOpened, 6),
      blockedUSDC: formatUnits(blocked, 6),
      deniedUSDC: formatUnits(denied, 6),
      repaidUSDC: formatUnits(repaid, 6),
      alpha: lineSummary(alphaLine),
      beta: lineSummary(betaLine),
    },
    null,
    2,
  ),
);

async function send(label, address, abi, functionName, args) {
  console.log(`\n${label}`);
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: owner, chain });
  console.log(`  tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  block ${receipt.blockNumber.toString()}`);
  return hash;
}

function readFloat(functionName, args) {
  return publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName, args });
}

function lineSummary(line) {
  return {
    wallet: line[0],
    score: Number(line[1]),
    limitUSDC: formatUnits(line[2], 6),
    availableUSDC: formatUnits(line[3], 6),
    debtUSDC: formatUnits(line[4], 6),
    status: Number(line[5]),
    mandateId: line[7],
    spentTodayUSDC: formatUnits(line[9], 6),
  };
}

function hash(value) {
  return keccak256(stringToBytes(value));
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
  return value?.replace(/\\n/g, "").trim();
}

function normalizeKey(value) {
  if (!value) return "";
  return value.startsWith("0x") ? value : `0x${value}`;
}
