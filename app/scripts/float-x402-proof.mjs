import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
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
const ADMIN_KEY = normalizeKey(clean(env.FLOAT_ADMIN_PRIVATE_KEY || env.PRIVATE_KEY));
const FACILITATOR_KEY = normalizeKey(
  clean(env.FLOAT_FACILITATOR_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY || env.PRIVATE_KEY),
);
const PROVIDER_URL = clean(env.FLOAT_X402_PROVIDER_URL) || "https://shadow-arc.vercel.app/api/reasoning-x402";

if (!RPC) throw new Error("missing ARC_RPC_URL or VITE_ARC_RPC_URL");
if (!FLOAT) throw new Error("missing SHADOW_FLOAT or VITE_SHADOW_FLOAT");
if (clean(env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("float-x402-proof.mjs is a V1 legacy proof runner that calls recordX402Spend. Set ALLOW_LEGACY_FLOAT=1 only for V1 proof reproduction.");
}
if (!ADMIN_KEY) throw new Error("missing FLOAT_ADMIN_PRIVATE_KEY or PRIVATE_KEY");
if (!FACILITATOR_KEY) throw new Error("missing FLOAT_FACILITATOR_PRIVATE_KEY or CAT_AGENT_PRIVATE_KEY");

const admin = privateKeyToAccount(ADMIN_KEY);
const facilitator = privateKeyToAccount(FACILITATOR_KEY);
const alpha = getAddress(clean(env.FLOAT_ALPHA_ADDRESS) || "0xa100000000000000000000000000000000000001");
const beta = getAddress(clean(env.FLOAT_BETA_ADDRESS) || "0xbe7a000000000000000000000000000000000002");
const endpointLabel = clean(env.FLOAT_X402_ENDPOINT_LABEL) || PROVIDER_URL;
const endpointHash = keccak256(stringToBytes(endpointLabel));
const overspendAmount = parseUnits(clean(env.FLOAT_OVERSPEND_USDC) || "5", 6);
const treasuryFund = parseUnits(clean(env.FLOAT_TREASURY_FUND_USDC) || "1.25", 6);
const maxPerRequest = parseUnits(clean(env.FLOAT_MAX_PER_REQUEST_USDC) || "1", 6);
const dailyLimit = parseUnits(clean(env.FLOAT_DAILY_LIMIT_USDC) || "2", 6);
const proofFeeBps = Number(clean(env.FLOAT_FEE_BPS) || "100");
if (!Number.isInteger(proofFeeBps) || proofFeeBps < 0 || proofFeeBps > 1000) {
  throw new Error("FLOAT_FEE_BPS must be an integer between 0 and 1000");
}
const now = Math.floor(Date.now() / 1000);
const salt = `${now}-${Math.random().toString(16).slice(2)}`;

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const adminWallet = createWalletClient({ account: admin, chain, transport: http(RPC) });
const facilitatorWallet = createWalletClient({ account: facilitator, chain, transport: http(RPC) });

const usdcEip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);

const floatAbi = parseAbi([
  "function fund(uint256 amountUSDC)",
  "function setOperator(address operator, bool allowed)",
  "function setFeeBps(uint16 newFeeBps)",
  "function setProviderMandate(address provider, bytes32 endpointHash, uint256 maxPerRequestUSDC, uint256 dailyLimitUSDC, uint64 expiry, bool active)",
  "function grantFloat(address agent, address wallet, uint256 creditLimitUSDC, uint16 score, bytes32 mandateId) returns (bytes32)",
  "function grantFloatFromScore(address agent, address wallet, uint8 label, uint16 paidBound, uint16 signedExternalPaid, uint16 repaid, uint16 blocked, uint16 denied, uint16 errorCount, bytes32 mandateId, uint64 expiry) returns (bytes32)",
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
  "function totalFeesAccruedUSDC() view returns (uint256)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);

console.log("Shadow Float x402 proof runner");
console.log(`admin       ${admin.address}`);
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
const feeAmount = (spendAmount * BigInt(proofFeeBps)) / 10_000n;
const repayAmount = spendAmount + feeAmount;
console.log(`fee bps     ${proofFeeBps}`);
console.log(`debt amount ${formatUnits(repayAmount, 6)} USDC`);

const adminUsdc = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [admin.address],
});
const facilitatorUsdc = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [facilitator.address],
});
console.log(`admin USDC       ${formatUnits(adminUsdc, 6)}`);
console.log(`facilitator USDC ${formatUnits(facilitatorUsdc, 6)}`);
if (adminUsdc < treasuryFund + repayAmount) {
  throw new Error(`admin needs ${formatUnits(treasuryFund + repayAmount, 6)} USDC for treasury fund + repay`);
}
if (facilitatorUsdc < spendAmount) {
  throw new Error(`facilitator needs ${formatUnits(spendAmount, 6)} USDC for x402 payment`);
}

await send("approve treasury + repay allowance", USDC, erc20Abi, "approve", [FLOAT, treasuryFund + repayAmount]);
const currentTreasury = await readFloat("treasuryBalanceUSDC", []);
if (currentTreasury < treasuryFund) {
  await send("fund Float treasury", FLOAT, floatAbi, "fund", [treasuryFund - currentTreasury]);
} else {
  console.log(`fund Float treasury\n  skipped, treasury already has ${formatUnits(currentTreasury, 6)} USDC`);
}
await send("authorize facilitator as Float operator", FLOAT, floatAbi, "setOperator", [facilitator.address, true]);
await send("set Float fee bps", FLOAT, floatAbi, "setFeeBps", [proofFeeBps]);
await send("set approved x402 provider", FLOAT, floatAbi, "setProviderMandate", [
  provider,
  endpointHash,
  maxPerRequest,
  dailyLimit,
  BigInt(now + 7 * 24 * 60 * 60),
  true,
]);
await send("grant Alpha deterministic Float line", FLOAT, floatAbi, "grantFloatFromScore", [
  alpha,
  alpha,
  2,
  1,
  1,
  0,
  0,
  0,
  0,
  keccak256(stringToBytes("shadow-float-alpha-good-history")),
  BigInt(now + 7 * 24 * 60 * 60),
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
  repayAmount,
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
  feesAccrued,
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
  readFloat("totalFeesAccruedUSDC", []),
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
      feesAccruedUSDC: formatUnits(feesAccrued, 6),
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
  if (x402Hash !== zeroHash()) {
    const already = await readFloat("receiptByRequestHash", [requestHash]);
    if (already && already !== zeroHash()) throw new Error(`${label}: request already consumed before bind (${already})`);
  }
  const txHash = await send(
    label,
    FLOAT,
    floatAbi,
    "recordX402Spend",
    [agent, provider, endpointHash, amount, requestHash, x402Hash, facilitator.address],
    facilitatorWallet,
    facilitator,
  );
  if (x402Hash !== zeroHash()) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    assertX402BoundReceipt(receipt, { requestHash, x402Hash, provider, amount });
  }
  return txHash;
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
  await assertX402SettlementTx(settled.txHash, { from: facilitator.address, to: payTo, amount });
  console.log(`  x402 tx ${settled.txHash}`);
  return settled.txHash;
}

async function assertX402SettlementTx(txHash, expected) {
  const [tx, receipt] = await Promise.all([
    publicClient.getTransaction({ hash: txHash }),
    publicClient.getTransactionReceipt({ hash: txHash }),
  ]);
  if (receipt.status !== "success") throw new Error(`x402 settlement tx failed: ${txHash}`);
  if (!tx.to || getAddress(tx.to) !== getAddress(USDC)) throw new Error(`x402 settlement tx did not call USDC: ${txHash}`);
  const matched = receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(USDC)) return false;
    const decoded = decodeLog(transferEvent, log);
    return Boolean(
      decoded &&
        getAddress(decoded.args.from) === facilitator.address &&
        getAddress(decoded.args.to) === getAddress(expected.to) &&
        decoded.args.value === expected.amount,
    );
  });
  if (!matched) {
    throw new Error(`x402 settlement tx did not transfer ${expected.amount} USDC from ${expected.from} to ${expected.to}: ${txHash}`);
  }
}

function assertX402BoundReceipt(receipt, expected) {
  const matched = receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(FLOAT)) return false;
    const decoded = decodeLog(x402PaymentBoundEvent, log);
    return Boolean(
      decoded &&
        decoded.args.requestHash?.toLowerCase() === expected.requestHash.toLowerCase() &&
        decoded.args.x402Hash?.toLowerCase() === expected.x402Hash.toLowerCase() &&
        getAddress(decoded.args.provider) === getAddress(expected.provider) &&
        decoded.args.amountUSDC === expected.amount &&
        getAddress(decoded.args.facilitator) === facilitator.address,
    );
  });
  if (!matched) throw new Error(`bind tx did not emit expected X402PaymentBound event: ${receipt.transactionHash}`);
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
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

async function send(label, address, abi, functionName, args, walletClient = adminWallet, account = admin) {
  console.log(`\n${label}`);
  const hash = await walletClient.writeContract({ address, abi, functionName, args, account, chain });
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
