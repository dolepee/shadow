import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  stringToBytes,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL);
const FLOAT = clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT);
const USDC = clean(env.ARC_USDC || env.VITE_ARC_USDC || "0x3600000000000000000000000000000000000000");
const FACILITATOR_KEY = normalizeKey(
  clean(env.FLOAT_FACILITATOR_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY || env.PRIVATE_KEY),
);
const PROVIDER_URL = clean(env.FLOAT_X402_PROVIDER_URL) || "https://shadow-arc.vercel.app/api/reasoning-x402";

if (!RPC) throw new Error("missing ARC_RPC_URL or VITE_ARC_RPC_URL");
if (!FLOAT) throw new Error("missing SHADOW_FLOAT or VITE_SHADOW_FLOAT");
if (!FACILITATOR_KEY) throw new Error("missing FLOAT_FACILITATOR_PRIVATE_KEY or CAT_AGENT_PRIVATE_KEY");

const facilitator = privateKeyToAccount(FACILITATOR_KEY);
const alpha = getAddress(clean(env.FLOAT_ALPHA_ADDRESS) || "0xa100000000000000000000000000000000000001");
const beta = getAddress(clean(env.FLOAT_BETA_ADDRESS) || "0xbe7a000000000000000000000000000000000002");
const endpointLabel = clean(env.FLOAT_X402_ENDPOINT_LABEL) || PROVIDER_URL;
const endpointHash = keccak256(stringToBytes(endpointLabel));
const lineAmount = parseUnits(clean(env.FLOAT_LINE_USDC) || "1", 6);
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
const wallet = createWalletClient({ account: facilitator, chain, transport: http(RPC) });

const usdcEip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

const floatAbi = parseAbi([
  "function fund(uint256 amountUSDC)",
  "function setProviderMandate(address provider, bytes32 endpointHash, uint256 maxPerRequestUSDC, uint256 dailyLimitUSDC, uint64 expiry, bool active)",
  "function grantFloat(address agent, address wallet, uint256 creditLimitUSDC, uint16 score, bytes32 mandateId) returns (bytes32)",
  "function denyAgent(address agent, address wallet, uint16 score, bytes32 mandateId, bytes32 requestHash) returns (bytes32)",
  "function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) view returns (bool allowed, uint8 reason)",
  "function recordX402Spend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash, bytes32 x402Hash, address facilitator) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
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

console.log("Shadow Float x402 proof runner");
console.log(`facilitator ${facilitator.address}`);
console.log(`float       ${FLOAT}`);
console.log(`usdc        ${USDC}`);
console.log(`providerUrl ${PROVIDER_URL}`);
console.log(`endpoint    ${endpointLabel} ${endpointHash}`);

const requirement = await fetchX402Requirement(PROVIDER_URL);
const provider = getAddress(requirement.payTo);
const spendAmount = BigInt(clean(env.FLOAT_X402_SPEND_ATOMIC) || requirement.maxAmountRequired);
if (spendAmount <= 0n) throw new Error("x402 spend amount must be positive");
if (requirement.asset && getAddress(requirement.asset) !== getAddress(USDC)) {
  throw new Error(`x402 provider asset mismatch: expected ${USDC}, got ${requirement.asset}`);
}
console.log(`provider    ${provider}`);
console.log(`x402 amount ${formatUnits(spendAmount, 6)} USDC`);

const facilitatorUsdc = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [facilitator.address],
});
console.log(`facilitator USDC ${formatUnits(facilitatorUsdc, 6)}`);
if (facilitatorUsdc < treasuryFund + spendAmount) {
  throw new Error(`facilitator needs ${formatUnits(treasuryFund + spendAmount, 6)} USDC for treasury fund + x402 payment`);
}

await send("approve treasury + repay allowance", USDC, erc20Abi, "approve", [FLOAT, treasuryFund + spendAmount]);
await send("fund Float treasury", FLOAT, floatAbi, "fund", [treasuryFund]);
await send("set approved x402 provider", FLOAT, floatAbi, "setProviderMandate", [
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

const allowRequest = hash(`alpha-x402-allow-${salt}`);
await gateThenPayAndBind({
  label: "Alpha pays x402 provider from float",
  agent: alpha,
  provider,
  amount: spendAmount,
  requestHash: allowRequest,
});

await gateThenBlock({
  label: "Alpha oversized spend blocked before x402",
  agent: alpha,
  provider,
  amount: overspendAmount,
  requestHash: hash(`alpha-x402-block-${salt}`),
});

await gateThenBlock({
  label: "Beta credit denied before x402",
  agent: beta,
  provider,
  amount: spendAmount,
  requestHash: hash(`beta-x402-denied-${salt}`),
});

await send("Alpha repays x402 float debt", FLOAT, floatAbi, "repay", [
  alpha,
  spendAmount,
  hash(`alpha-x402-repay-${salt}`),
]);

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

async function gateThenPayAndBind({ label, agent, provider, amount, requestHash }) {
  console.log(`\n${label}`);
  const [allowed, reason] = await readFloat("previewSpend", [agent, provider, endpointHash, amount, requestHash]);
  if (!allowed) {
    console.log(`  blocked at preview reason=${reason}`);
    await recordX402Spend(`${label} block receipt`, agent, provider, amount, requestHash, zeroHash());
    return;
  }
  console.log("  preview allowed");
  const x402Hash = await payProviderX402(PROVIDER_URL, provider, amount);
  await recordX402Spend(`${label} bind x402`, agent, provider, amount, requestHash, x402Hash);
}

async function gateThenBlock({ label, agent, provider, amount, requestHash }) {
  console.log(`\n${label}`);
  const [allowed, reason] = await readFloat("previewSpend", [agent, provider, endpointHash, amount, requestHash]);
  if (allowed) throw new Error(`${label} unexpectedly allowed`);
  console.log(`  preview blocked reason=${reason}`);
  await recordX402Spend(`${label} receipt`, agent, provider, amount, requestHash, zeroHash());
}

async function recordX402Spend(label, agent, provider, amount, requestHash, x402Hash) {
  return send(label, FLOAT, floatAbi, "recordX402Spend", [
    agent,
    provider,
    endpointHash,
    amount,
    requestHash,
    x402Hash,
    facilitator.address,
  ]);
}

async function payProviderX402(url, payTo, amount) {
  console.log("  paying x402 provider");
  const timestamp = Math.floor(Date.now() / 1000);
  const message = {
    from: facilitator.address,
    to: payTo,
    value: amount,
    validAfter: BigInt(timestamp - 60),
    validBefore: BigInt(timestamp + 600),
    nonce: generatePrivateKey(),
  };
  const signature = await facilitator.signTypedData({
    domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: getAddress(USDC) },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "arc-testnet",
    payload: {
      from: facilitator.address,
      to: payTo,
      value: amount.toString(),
      validAfter: message.validAfter.toString(),
      validBefore: message.validBefore.toString(),
      nonce: message.nonce,
      signature,
    },
  };
  const response = await fetch(url, {
    headers: { "X-PAYMENT": Buffer.from(JSON.stringify(payload)).toString("base64url") },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`x402 provider returned HTTP ${response.status}: ${text.slice(0, 240)}`);

  const paymentResponse = response.headers.get("x-payment-response");
  if (!paymentResponse) throw new Error("x402 provider did not return X-PAYMENT-RESPONSE");
  const settled = JSON.parse(Buffer.from(paymentResponse, "base64url").toString("utf8"));
  if (!settled.txHash || !/^0x[a-fA-F0-9]{64}$/.test(settled.txHash)) {
    throw new Error(`invalid x402 settlement hash: ${settled.txHash}`);
  }
  console.log(`  x402 tx ${settled.txHash}`);
  return settled.txHash;
}

async function fetchX402Requirement(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (response.status !== 402) {
    throw new Error(`expected x402 HTTP 402 from provider, got ${response.status}`);
  }
  const requirement = body.accepts?.[0];
  if (!requirement?.payTo || !isAddress(requirement.payTo)) {
    throw new Error("x402 provider did not return a valid payTo");
  }
  if (!requirement.maxAmountRequired) throw new Error("x402 provider did not return maxAmountRequired");
  return requirement;
}

async function send(label, address, abi, functionName, args) {
  console.log(`\n${label}`);
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: facilitator, chain });
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

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
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
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
