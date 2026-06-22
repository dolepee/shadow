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
const endpointLabel = clean(env.FLOAT_X402_ENDPOINT_LABEL) || PROVIDER_URL;
const endpointHash = keccak256(stringToBytes(endpointLabel));
const maxRuns = Number(clean(env.FLOAT_LOOP_MAX_RUNS) || "120");

if (!RPC) throw new Error("missing ARC_RPC_URL or VITE_ARC_RPC_URL");
if (!FLOAT || !isAddress(FLOAT)) throw new Error("missing SHADOW_FLOAT or VITE_SHADOW_FLOAT");
if (!FACILITATOR_KEY) throw new Error("missing FLOAT_FACILITATOR_PRIVATE_KEY or CAT_AGENT_PRIVATE_KEY");

const agents = process.argv
  .slice(2)
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    if (!isAddress(value)) throw new Error(`invalid agent address: ${value}`);
    return getAddress(value);
  });

if (!agents.length) {
  throw new Error("usage: node app/scripts/float-external-spend.mjs 0xAgent [0xAgent...]");
}

const facilitator = privateKeyToAccount(FACILITATOR_KEY);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const wallet = createWalletClient({ account: facilitator, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });

const floatAbi = parseAbi([
  "function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) view returns (bool allowed, uint8 reason)",
  "function recordX402Spend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash, bytes32 x402Hash, address facilitator) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);

console.log("Shadow Float external x402 spend");
console.log(`float       ${getAddress(FLOAT)}`);
console.log(`facilitator ${facilitator.address}`);
console.log(`providerUrl ${PROVIDER_URL}`);
console.log(`agents      ${agents.join(", ")}`);

const requirement = await fetchX402Requirement(PROVIDER_URL);
const provider = getAddress(requirement.payTo);
const amount = BigInt(clean(env.FLOAT_EXTERNAL_SPEND_ATOMIC) || requirement.maxAmountRequired);
if (amount <= 0n) throw new Error("x402 spend amount must be positive");
if (requirement.asset && getAddress(requirement.asset) !== getAddress(USDC)) {
  throw new Error(`x402 provider asset mismatch: expected ${USDC}, got ${requirement.asset}`);
}

const facilitatorUsdc = await publicClient.readContract({
  address: getAddress(USDC),
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [facilitator.address],
});
if (facilitatorUsdc < amount * BigInt(agents.length)) {
  throw new Error(
    `facilitator needs ${formatUnits(amount * BigInt(agents.length), 6)} USDC, has ${formatUnits(facilitatorUsdc, 6)}`,
  );
}

const kv = kvConfigFromEnv();
const history = await loadRunHistory(kv);
const runs = [];

for (const agent of agents) {
  const before = await readFloat("lines", [agent]);
  const lineBefore = lineSummary(before);
  const rationale =
    "External Lepton builder wallet uses a behavior-backed Shadow Float line to buy the approved x402 provider without prefunding its own wallet.";
  const { requestHash, preimage } = buildRequestCommitment({
    agent,
    action: "EXTERNAL_PAY",
    provider,
    amountAtomic: amount,
    rationale,
    model: "external-builder-onboarding",
    fellBack: false,
  });

  console.log(`\nexternal agent ${agent}`);
  console.log(`line before available=${lineBefore.availableUSDC} debt=${lineBefore.debtUSDC} status=${lineBefore.status}`);
  const [allowed, reason] = await readFloat("previewSpend", [agent, provider, endpointHash, amount, requestHash]);
  if (!allowed) {
    console.log(`blocked at preview reason=${reasonName(reason)}`);
    const txHash = await recordX402Spend(`${agent} external blocked receipt`, agent, provider, amount, requestHash, zeroHash());
    runs.push(
      baseRun(agent, "EXTERNAL_PAY", "GATE_BLOCKED", {
        amountUSDC: amount.toString(),
        reason: reasonName(reason),
        txHash,
        requestHash,
        rationale,
        rationalePreimage: preimage,
        model: "external-builder-onboarding",
        fellBack: false,
        lineBefore,
      }),
    );
    continue;
  }

  const x402 = await payProviderX402(PROVIDER_URL, provider, amount);
  const bindTxHash = await recordX402Spend(`${agent} external bind x402`, agent, provider, amount, requestHash, x402.txHash);
  const after = await readFloat("lines", [agent]);
  const lineAfter = lineSummary(after);
  console.log(`bound ${bindTxHash}`);
  console.log(`line after available=${lineAfter.availableUSDC} debt=${lineAfter.debtUSDC} status=${lineAfter.status}`);
  runs.push(
    baseRun(agent, "EXTERNAL_PAY", "PAID_BOUND", {
      amountUSDC: amount.toString(),
      x402Hash: x402.txHash,
      bindTxHash,
      requestHash,
      rationale,
      rationalePreimage: preimage,
      model: "external-builder-onboarding",
      fellBack: false,
      providerResponse: x402.providerResponse,
      lineBefore,
      lineAfter,
    }),
  );
}

await persistRuns(kv, history, runs);
console.log("\nexternal runs");
console.log(JSON.stringify(runs, null, 2));

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

async function payProviderX402(url, payTo, value) {
  console.log(`paying x402 provider ${formatUnits(value, 6)} USDC`);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = {
    from: facilitator.address,
    to: payTo,
    value,
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
      value: value.toString(),
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
  console.log(`x402 tx ${settled.txHash}`);
  return { txHash: settled.txHash, providerResponse: summarizeProviderResponse(safeParse(text)) };
}

async function recordX402Spend(label, agent, provider, value, requestHash, x402Hash) {
  console.log(label);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const existing = await readFloat("receiptByRequestHash", [requestHash]);
    if (existing && existing !== zeroHash()) {
      console.log(`already bound ${existing}`);
      return null;
    }
    try {
      const txHash = await wallet.writeContract({
        address: getAddress(FLOAT),
        abi: floatAbi,
        functionName: "recordX402Spend",
        args: [agent, provider, endpointHash, value, requestHash, x402Hash, facilitator.address],
        account: facilitator,
        chain,
      });
      console.log(`tx ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`${label} reverted: ${txHash}`);
      return txHash;
    } catch (error) {
      lastError = error;
      console.warn(`bind attempt ${attempt} failed: ${sanitizeError(error)}`);
      await sleep(2_000 * attempt);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

function readFloat(functionName, args) {
  return publicClient.readContract({ address: getAddress(FLOAT), abi: floatAbi, functionName, args });
}

async function loadRunHistory(kv) {
  if (!kv) return [];
  try {
    const current = await kvGet(kv, "float:loop:runs");
    return Array.isArray(current) ? current : [];
  } catch (error) {
    console.warn(`kv history read skipped: ${sanitizeError(error)}`);
    return [];
  }
}

async function persistRuns(kv, history, runs) {
  if (!kv) {
    console.log("kv not configured; external runs printed only");
    return;
  }
  const next = history.concat(runs).slice(-maxRuns);
  await kvSet(kv, "float:loop:latest", runs[runs.length - 1]);
  await kvSet(kv, "float:loop:runs", next);
}

async function kvGet(kv, key) {
  const response = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!response.ok) throw new Error(`kv get failed ${response.status}`);
  const json = await response.json();
  if (json.result === null || json.result === undefined) return null;
  try {
    return JSON.parse(json.result);
  } catch {
    return json.result;
  }
}

async function kvSet(kv, key, value) {
  const response = await fetch(`${kv.url}/set/${encodeURIComponent(key)}?EX=2592000`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`kv set failed ${response.status} ${await response.text()}`);
}

function kvConfigFromEnv() {
  const url = clean(env.KV_REST_API_URL);
  const token = clean(env.KV_REST_API_TOKEN);
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function buildRequestCommitment({ agent, action, provider, amountAtomic, rationale, model, fellBack }) {
  const preimage = JSON.stringify({
    v: 1,
    domain: "shadow-float:external-request",
    agent,
    action,
    provider,
    amountUSDC: amountAtomic.toString(),
    rationale,
    model,
    fellBack,
    salt: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  return { requestHash: keccak256(stringToBytes(preimage)), preimage };
}

function baseRun(agent, action, outcome, fields = {}) {
  return {
    version: 1,
    id: `float-external-${Date.now()}-${agent.slice(2, 8)}`,
    source: "external",
    action,
    outcome,
    at: new Date().toISOString(),
    network: "arc-testnet",
    float: getAddress(FLOAT),
    facilitator: facilitator.address,
    agent,
    endpointHash,
    ...fields,
  };
}

function lineSummary(line) {
  return {
    wallet: line[0],
    score: Number(line[1]),
    limitUSDC: formatUnits(line[2], 6),
    availableUSDC: formatUnits(line[3], 6),
    debtUSDC: formatUnits(line[4], 6),
    creditLimitUSDCAtomic: line[2].toString(),
    availableCreditUSDCAtomic: line[3].toString(),
    activeDebtUSDCAtomic: line[4].toString(),
    status: Number(line[5]),
    mandateId: line[7],
    spentTodayUSDC: formatUnits(line[9], 6),
  };
}

function summarizeProviderResponse(body) {
  if (!body || typeof body !== "object") return { hasReasoning: false };
  return {
    hasReasoning: Boolean(body.intentHash || body.decision || body.rationale || body.reasoning),
    decision: typeof body.decision === "string" ? body.decision.slice(0, 40) : undefined,
    intentHash: typeof body.intentHash === "string" ? body.intentHash : undefined,
  };
}

function reasonName(value) {
  const reasons = [
    "NONE",
    "NOT_AUTHORIZED",
    "NOT_ELIGIBLE",
    "CREDIT_DENIED",
    "REVOKED",
    "PROVIDER_NOT_ALLOWED",
    "ENDPOINT_NOT_ALLOWED",
    "AMOUNT_TOO_HIGH",
    "DAILY_LIMIT_EXCEEDED",
    "EXPIRED",
    "INSUFFICIENT_TREASURY",
    "DUPLICATE_REQUEST",
    "ZERO_AMOUNT",
    "NO_DEBT",
    "REPAY_TOO_HIGH",
  ];
  return reasons[Number(value)] || `REASON_${value}`;
}

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
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

function clean(value) {
  return value?.replace(/\\n/g, "").trim();
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}

function sanitizeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
