import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseEther,
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
const BANKR_URL = clean(env.BANKR_LLM_URL) || "https://llm.bankr.bot/v1/chat/completions";
const BANKR_MODEL = clean(env.BANKR_LLM_MODEL) || "deepseek-v3.2";
const DRY_RUN = clean(env.FLOAT_LOOP_DRY_RUN) === "1";

if (!RPC) throw new Error("missing ARC_RPC_URL or VITE_ARC_RPC_URL");
if (!FLOAT) throw new Error("missing SHADOW_FLOAT or VITE_SHADOW_FLOAT");
if (!FACILITATOR_KEY) throw new Error("missing FLOAT_FACILITATOR_PRIVATE_KEY or CAT_AGENT_PRIVATE_KEY");

const facilitator = privateKeyToAccount(FACILITATOR_KEY);
const alpha = getAddress(clean(env.FLOAT_ALPHA_ADDRESS) || "0xa100000000000000000000000000000000000001");
const beta = getAddress(clean(env.FLOAT_BETA_ADDRESS) || "0xbe7a000000000000000000000000000000000002");
const endpointLabel = clean(env.FLOAT_X402_ENDPOINT_LABEL) || PROVIDER_URL;
const endpointHash = keccak256(stringToBytes(endpointLabel));
const overspendAmount = parseUnits(clean(env.FLOAT_OVERSPEND_USDC) || "5", 6);
const minUsdcFloor = parseUnits(clean(env.FLOAT_LOOP_MIN_USDC) || "0.1", 6);
const minNativeFloor = parseEther(clean(env.FLOAT_LOOP_MIN_NATIVE_USDC) || "0.02");
const repayThresholdMultiplier = BigInt(clean(env.FLOAT_LOOP_REPAY_PRICE_MULTIPLIER) || "3");
const denyEvery = Number(clean(env.FLOAT_LOOP_DENY_EVERY) || "6");
const maxRuns = Number(clean(env.FLOAT_LOOP_HISTORY_LIMIT) || "160");
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
  "function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) view returns (bool allowed, uint8 reason)",
  "function recordX402Spend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash, bytes32 x402Hash, address facilitator) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function repay(address agent, uint256 amountUSDC, bytes32 requestHash) returns (bytes32)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalProviderPaidUSDC() view returns (uint256)",
  "function totalBlockedUSDC() view returns (uint256)",
  "function totalDeniedUSDC() view returns (uint256)",
  "function totalRepaidUSDC() view returns (uint256)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
]);

const REASONS = [
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

console.log("Shadow Float autonomous loop");
console.log(`mode        ${DRY_RUN ? "dry-run" : "live"}`);
console.log(`facilitator ${facilitator.address}`);
console.log(`float       ${FLOAT}`);
console.log(`providerUrl ${PROVIDER_URL}`);
console.log(`endpoint    ${endpointLabel} ${endpointHash}`);

await runCycle();

async function runCycle() {
  const kv = kvConfigFromEnv();
  const history = await loadLoopHistory(kv);
  const requirement = await fetchX402Requirement(PROVIDER_URL);
  const provider = getAddress(requirement.payTo);
  const spendAmount = BigInt(clean(env.FLOAT_X402_SPEND_ATOMIC) || requirement.maxAmountRequired);
  if (spendAmount <= 0n) throw new Error("x402 spend amount must be positive");
  if (requirement.asset && getAddress(requirement.asset) !== getAddress(USDC)) {
    throw new Error(`x402 provider asset mismatch: expected ${USDC}, got ${requirement.asset}`);
  }

  const [facilitatorUsdc, nativeBalance, treasuryBalance, alphaLineRaw] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [facilitator.address] }),
    publicClient.getBalance({ address: facilitator.address }),
    readFloat("treasuryBalanceUSDC", []),
    readFloat("lines", [alpha]),
  ]);
  const alphaLine = lineSummary(alphaLineRaw);

  console.log(`provider        ${provider}`);
  console.log(`x402 amount     ${formatUnits(spendAmount, 6)} USDC`);
  console.log(`facilitator     ${formatUnits(facilitatorUsdc, 6)} ERC20 USDC, ${formatEther(nativeBalance)} native`);
  console.log(`float treasury  ${formatUnits(treasuryBalance, 6)} USDC`);
  console.log(`alpha line      available=${alphaLine.availableUSDC} debt=${alphaLine.debtUSDC} status=${alphaLine.status}`);

  if (facilitatorUsdc < minUsdcFloor || nativeBalance < minNativeFloor) {
    const run = baseRun("SKIPPED_LOW_FUNDS", "SKIPPED_LOW_FUNDS", {
      provider,
      amountUSDC: spendAmount.toString(),
      rationale: `Loop idled: facilitator balance below floor (${formatUnits(facilitatorUsdc, 6)} ERC20 USDC, ${formatEther(nativeBalance)} native).`,
      model: "preflight",
      fellBack: false,
      balances: balances(facilitatorUsdc, nativeBalance, treasuryBalance),
    });
    await persistRun(kv, history, run);
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  const context = buildDecisionContext({ history, alphaLine, spendAmount, provider, treasuryBalance });
  const decision = await decideFloatAction(context);
  const forced = clean(env.FLOAT_LOOP_FORCE_ACTION);
  if (forced && ["PAY", "SKIP", "PREMIUM", "REPAY"].includes(forced)) {
    decision.action = forced;
    decision.rationale = `Forced ${forced} by FLOAT_LOOP_FORCE_ACTION for operator verification. ${decision.rationale}`;
    decision.model = `${decision.model}+forced`;
  }
  console.log(`decision ${decision.action} model=${decision.model} fallback=${decision.fellBack}`);
  console.log(`rationale ${decision.rationale}`);

  const runsToPersist = [];
  let run;
  try {
    if (decision.action === "SKIP") {
      run = baseRun("SKIP", "SKIPPED_BY_AGENT", {
        provider,
        amountUSDC: "0",
        rationale: decision.rationale,
        model: decision.model,
        fellBack: decision.fellBack,
        decisionContext: context,
        balances: balances(facilitatorUsdc, nativeBalance, treasuryBalance),
      });
    } else if (decision.action === "REPAY") {
      run = await handleRepay({ decision, spendAmount, history, provider, alphaLine });
    } else if (decision.action === "PREMIUM") {
      run = await handleBlockedSpend({
        action: "PREMIUM",
        outcome: "PREMIUM_BLOCKED",
        agent: alpha,
        provider,
        amount: overspendAmount,
        rationale: decision.rationale,
        model: decision.model,
        fellBack: decision.fellBack,
        requestLabel: "alpha-loop-premium",
      });
    } else {
      run = await handlePay({ decision, provider, amount: spendAmount });
    }
    runsToPersist.push(run);

    if (shouldRunDenyCheck(history)) {
      const denyRun = await handleBlockedSpend({
        action: "DENY_CHECK",
        outcome: "DENIED",
        agent: beta,
        provider,
        amount: spendAmount,
        rationale: "Periodic denied-agent check keeps the risky-agent path fresh without paying x402.",
        model: "deterministic-deny-check",
        fellBack: false,
        requestLabel: "beta-loop-denied",
      });
      runsToPersist.push(denyRun);
      console.log(JSON.stringify(denyRun, null, 2));
    }
  } catch (error) {
    run = baseRun(decision.action, "ERROR", {
      provider,
      amountUSDC: "0",
      rationale: decision.rationale,
      model: decision.model,
      fellBack: decision.fellBack,
      error: sanitizeError(error),
    });
    runsToPersist.push(run);
  }

  await persistRuns(kv, history, runsToPersist);
  for (const item of runsToPersist) {
    console.log(JSON.stringify(item, null, 2));
  }
}

async function handlePay({ decision, provider, amount }) {
  const requestHash = hash(`agent-loop:alpha:pay:${salt}`);
  const [allowed, reasonRaw] = await readFloat("previewSpend", [alpha, provider, endpointHash, amount, requestHash]);
  const reason = reasonName(reasonRaw);
  if (!allowed) {
    const txHash = DRY_RUN
      ? null
      : await recordX402Spend("Alpha loop PAY blocked receipt", alpha, provider, amount, requestHash, zeroHash());
    return baseRun("PAY", "GATE_BLOCKED", {
      provider,
      amountUSDC: amount.toString(),
      requestHash,
      txHash,
      reason,
      rationale: decision.rationale,
      model: decision.model,
      fellBack: decision.fellBack,
    });
  }

  if (DRY_RUN) {
    return baseRun("PAY", "DRY_RUN_ALLOWED", {
      provider,
      amountUSDC: amount.toString(),
      requestHash,
      reason,
      rationale: decision.rationale,
      model: decision.model,
      fellBack: decision.fellBack,
    });
  }

  const x402 = await payProviderX402(PROVIDER_URL, provider, amount);
  const bindTxHash = await recordX402Spend("Alpha loop PAY bind x402", alpha, provider, amount, requestHash, x402.txHash);
  return baseRun("PAY", "PAID_BOUND", {
    provider,
    amountUSDC: amount.toString(),
    requestHash,
    x402Hash: x402.txHash,
    bindTxHash,
    providerResponse: summarizeProviderResponse(x402.body),
    rationale: decision.rationale,
    model: decision.model,
    fellBack: decision.fellBack,
  });
}

async function handleRepay({ decision, spendAmount, provider, alphaLine }) {
  const debt = BigInt(alphaLine.activeDebtUSDCAtomic);
  if (debt === 0n) {
    return baseRun("REPAY", "SKIPPED_NO_DEBT", {
      provider,
      amountUSDC: "0",
      rationale: `${decision.rationale} No active debt was present at execution.`,
      model: decision.model,
      fellBack: decision.fellBack,
    });
  }
  const amount = debt < spendAmount ? debt : spendAmount;
  const requestHash = hash(`agent-loop:alpha:repay:${salt}`);
  if (!DRY_RUN) {
    await send("Approve Float repayment", USDC, erc20Abi, "approve", [FLOAT, amount]);
  }
  const repayTxHash = DRY_RUN ? null : await send("Alpha loop REPAY", FLOAT, floatAbi, "repay", [alpha, amount, requestHash]);
  return baseRun("REPAY", DRY_RUN ? "DRY_RUN_REPAY" : "REPAID", {
    provider,
    amountUSDC: amount.toString(),
    requestHash,
    repayTxHash,
    rationale: decision.rationale,
    model: decision.model,
    fellBack: decision.fellBack,
  });
}

async function handleBlockedSpend({ action, outcome, agent, provider, amount, rationale, model, fellBack, requestLabel }) {
  const requestHash = hash(`agent-loop:${requestLabel}:${salt}`);
  const [allowed, reasonRaw] = await readFloat("previewSpend", [agent, provider, endpointHash, amount, requestHash]);
  const reason = reasonName(reasonRaw);
  if (allowed) {
    return baseRun(action, "UNEXPECTED_ALLOWED", {
      provider,
      amountUSDC: amount.toString(),
      requestHash,
      reason,
      rationale: `${rationale} The gate unexpectedly allowed this request, so the loop did not pay or bind x402.`,
      model,
      fellBack,
    });
  }
  const txHash = DRY_RUN
    ? null
    : await recordX402Spend(`${action} loop block receipt`, agent, provider, amount, requestHash, zeroHash());
  return baseRun(action, DRY_RUN ? "DRY_RUN_BLOCKED" : outcome, {
    provider,
    amountUSDC: amount.toString(),
    requestHash,
    txHash,
    reason,
    rationale,
    model,
    fellBack,
  });
}

function buildDecisionContext({ history, alphaLine, spendAmount, provider, treasuryBalance }) {
  const recent = history.filter((run) => run.source === "agent-loop").slice(-24);
  const lastBuyIndex = recent.map((run) => run.outcome).lastIndexOf("PAID_BOUND");
  const lastRepayIndex = recent.map((run) => run.outcome).lastIndexOf("REPAID");
  const cyclesSinceLastBuy = lastBuyIndex >= 0 ? recent.length - 1 - lastBuyIndex : 99;
  const cyclesSinceLastRepay = lastRepayIndex >= 0 ? recent.length - 1 - lastRepayIndex : 99;
  const paid = recent.filter((run) => run.outcome === "PAID_BOUND").length;
  const skips = recent.filter((run) => run.outcome === "SKIPPED_BY_AGENT").length;
  const blocks = recent.filter((run) => run.outcome === "PREMIUM_BLOCKED" || run.outcome === "GATE_BLOCKED").length;
  const usefulResponses = recent.filter((run) => run.providerResponse?.hasReasoning).length;
  return {
    agent: "Alpha",
    provider,
    priceAtomic: spendAmount.toString(),
    priceUSDC: formatUnits(spendAmount, 6),
    availableCreditAtomic: alphaLine.availableCreditUSDCAtomic,
    availableCreditUSDC: alphaLine.availableUSDC,
    activeDebtAtomic: alphaLine.activeDebtUSDCAtomic,
    activeDebtUSDC: alphaLine.debtUSDC,
    creditLimitUSDC: alphaLine.limitUSDC,
    status: alphaLine.status,
    treasuryUSDC: formatUnits(treasuryBalance, 6),
    cyclesObserved: history.length,
    recentWindow: recent.length,
    cyclesSinceLastBuy,
    cyclesSinceLastRepay,
    recentPaid: paid,
    recentSkips: skips,
    recentBlocks: blocks,
    recentUsefulness: recent.length ? usefulResponses / recent.length : 0,
  };
}

async function decideFloatAction(context) {
  const apiKey = clean(env.BANKR_LLM_KEY);
  if (!apiKey) return fallbackDecision(context, "BANKR_LLM_KEY missing");
  const prompt = [
    "You control Agent Alpha's request, not Shadow's enforcement. Shadow will deterministically allow or block.",
    "Choose one action only: PAY, SKIP, PREMIUM, or REPAY.",
    "PAY buys the standard x402 resource if useful.",
    "SKIP means the resource is not worth paying for this cycle.",
    "PREMIUM means you want a larger pull because the signal may be valuable; Shadow is expected to block it if it exceeds mandate.",
    "REPAY refreshes the credit line when debt is building.",
    "Reply with one JSON object only: {\"action\":\"PAY|SKIP|PREMIUM|REPAY\",\"rationale\":\"one sentence\",\"regime\":\"short-label\"}.",
    "",
    `Context: ${JSON.stringify(context)}`,
  ].join("\n");
  try {
    const response = await fetch(BANKR_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: BANKR_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are an autonomous USDC spending agent. You decide whether buying a tiny paid x402 resource is worth it under a committed mandate. You never override policy enforcement.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 260,
        temperature: 0.35,
      }),
    });
    if (!response.ok) return fallbackDecision(context, `bankr http ${response.status}`);
    const json = await response.json();
    const raw = json.choices?.[0]?.message?.content;
    const parsed = safeParse(raw || "");
    if (!parsed) return fallbackDecision(context, "non-JSON completion");
    const action = String(parsed.action || "").toUpperCase();
    const allowed = ["PAY", "SKIP", "PREMIUM", "REPAY"];
    if (!allowed.includes(action)) return fallbackDecision(context, `invalid action ${action || "empty"}`);
    const rationale =
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 360)
        : `${action} selected from float context.`;
    const regime = typeof parsed.regime === "string" ? parsed.regime.trim().slice(0, 64) : "llm-float";
    return { action, rationale: `${rationale} Regime: ${regime}.`, model: BANKR_MODEL, fellBack: false };
  } catch (error) {
    return fallbackDecision(context, `bankr error ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
  }
}

function fallbackDecision(context, reason) {
  const debt = BigInt(context.activeDebtAtomic);
  const price = BigInt(context.priceAtomic);
  let action = "PAY";
  let why = "standard paid resource is cheap and credit remains available";
  if (debt >= price * repayThresholdMultiplier || (debt > 0n && context.cyclesSinceLastRepay >= 8)) {
    action = "REPAY";
    why = "active debt is high enough to refresh the line";
  } else if (context.cyclesSinceLastBuy < 1 && context.recentPaid > context.recentSkips) {
    action = "SKIP";
    why = "the last buy was recent and another paid call is not yet necessary";
  } else if (context.cyclesSinceLastBuy >= 6 && context.recentBlocks === 0) {
    action = "PREMIUM";
    why = "the agent wants a larger pull after several cycles without an overreach check";
  }
  return {
    action,
    rationale: `Deterministic fallback selected ${action}: ${why} (${reason}).`,
    model: "deterministic-fallback",
    fellBack: true,
  };
}

function shouldRunDenyCheck(history) {
  if (!Number.isFinite(denyEvery) || denyEvery <= 0) return false;
  const loopRuns = history.filter((run) => run.source === "agent-loop").length;
  return (loopRuns + 1) % denyEvery === 0;
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
  console.log("paying x402 provider");
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
  console.log(`x402 tx ${settled.txHash}`);
  return { txHash: settled.txHash, body: safeParse(text) || text.slice(0, 240) };
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
  console.log(label);
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: facilitator, chain });
  console.log(`tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`block ${receipt.blockNumber.toString()}`);
  return hash;
}

function readFloat(functionName, args) {
  return publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName, args });
}

async function loadLoopHistory(kv) {
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
  if (DRY_RUN) {
    console.log("dry-run; loop runs not persisted");
    return;
  }
  if (!kv) {
    console.log("kv not configured; loop runs printed only");
    return;
  }
  const next = history.concat(runs).slice(-maxRuns);
  try {
    await kvSet(kv, "float:loop:latest", runs[runs.length - 1]);
    await kvSet(kv, "float:loop:runs", next);
  } catch (error) {
    console.warn(`kv persist skipped: ${sanitizeError(error)}`);
  }
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

function baseRun(action, outcome, fields = {}) {
  return {
    version: 1,
    id: `float-loop-${now}-${salt}`,
    source: "agent-loop",
    action,
    outcome,
    at: new Date().toISOString(),
    network: "arc-testnet",
    float: FLOAT,
    facilitator: facilitator.address,
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

function balances(facilitatorUsdc, nativeBalance, treasuryBalance) {
  return {
    facilitatorUSDC: formatUnits(facilitatorUsdc, 6),
    nativeUSDC: formatEther(nativeBalance),
    treasuryUSDC: formatUnits(treasuryBalance, 6),
  };
}

function reasonName(value) {
  return REASONS[Number(value)] || `REASON_${value}`;
}

function hash(value) {
  return keccak256(stringToBytes(value));
}

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function safeParse(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"']+/gi, "[url]")
    .replace(/swrm_[a-z0-9]+/gi, "[redacted]")
    .split("\n")[0]
    .slice(0, 220);
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
