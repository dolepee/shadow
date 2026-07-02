import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FLOAT_V2_CONTRACT, FLOAT_V2_TRACKED_EXTERNAL_AGENTS } from "../floatV2Config.js";

const env = {
  ...readEnv(".env"),
  ...readEnv(".vercel/.env.production.local"),
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const LEGACY_FLOAT = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || FLOAT_V2_CONTRACT);
if (FLOAT === LEGACY_FLOAT && clean(env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to run Float Desk against the known V1 ShadowFloat address");
}
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const LAB_AGENT = getAddress(clean(env.DESK_AGENT_ADDRESS || env.FLOAT_DESK_AGENT || env.FLOAT_AGENT_ADDRESS) || "0x5773dd87b1A2b57697f773F0dcdFa65f405662a0");
const DESK_AGENT_KEY = normalizeKey(clean(env.DESK_AGENT_PRIVATE_KEY || env.FLOAT_AGENT_PRIVATE_KEY || env.BUILDER_PRIVATE_KEY));
const EXECUTOR_KEY = normalizeKey(clean(env.FLOAT_EXECUTOR_PRIVATE_KEY || env.FLOAT_SPONSOR_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY || env.PRIVATE_KEY));
if (!DESK_AGENT_KEY) throw new Error("set DESK_AGENT_PRIVATE_KEY or FLOAT_AGENT_PRIVATE_KEY to the lab line signer key");
if (!EXECUTOR_KEY) throw new Error("set FLOAT_EXECUTOR_PRIVATE_KEY to the desk executor key");

const deskAgent = privateKeyToAccount(DESK_AGENT_KEY);
const executor = privateKeyToAccount(EXECUTOR_KEY);
if (getAddress(deskAgent.address) !== LAB_AGENT) {
  throw new Error(`desk agent key resolves to ${deskAgent.address}, expected lab agent ${LAB_AGENT}`);
}

const LIVE = clean(env.FLOAT_DESK_LIVE) === "1";
const SETUP_MANDATE = process.argv.includes("--setup-mandate") || clean(env.FLOAT_DESK_SETUP_MANDATE) === "1";
const JOURNAL_LIMIT = Number(clean(env.FLOAT_DESK_HISTORY_LIMIT) || "120");
const MAX_SPEND_ATOMIC = BigInt(clean(env.DESK_MAX_SPEND_ATOMIC) || "10000");
const MAX_SPENDS_PER_DAY = Number(clean(env.DESK_MAX_SPENDS_PER_DAY) || "6");
const MIN_TREASURY_ATOMIC = BigInt(clean(env.DESK_MIN_TREASURY_ATOMIC) || "100000");
const MIN_GAS_WEI = parseUnits18(clean(env.DESK_MIN_GAS_USDC) || "0.005");
const INTENT_TTL_SECONDS = BigInt(clean(env.FLOAT_INTENT_TTL) || "1800");
const CITEPAY_QUERY =
  clean(env.DESK_CITEPAY_QUERY) ||
  "How does Shadow Float V2 let autonomous agents use sponsor-backed USDC spending lines on Arc?";
const FLOAT_API_URL = clean(env.DESK_FLOAT_API_URL) || "https://shadow-arc.vercel.app/api/float?mode=v2";
const CITEPAY_API_URL = clean(env.DESK_CITEPAY_API_URL) || "https://citepay-markets.vercel.app/api/ask";
const DESK_CYCLE = clean(env.FLOAT_DESK_CYCLE) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const NOW = Math.floor(Date.now() / 1000);

const PROVIDERS = {
  citepay: {
    key: "citepay",
    label: "CitePay",
    kind: "external",
    provider: getAddress(clean(env.DESK_CITEPAY_PROVIDER) || "0x5389688243328c26a92b301faEEAb5fbf9AFf105"),
    endpointHash:
      clean(env.DESK_CITEPAY_ENDPOINT_HASH) ||
      "0x15bdadc12e87bc31da20f85d10b491a061578fb50a8500bc00a0854b49830a2b",
    defaultAmountAtomic: BigInt(clean(env.DESK_CITEPAY_AMOUNT_ATOMIC) || "1000"),
  },
  shadow: {
    key: "shadow",
    label: "Shadow provider",
    kind: "internal",
    provider: getAddress(clean(env.DESK_SHADOW_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937"),
    endpointHash:
      clean(env.DESK_SHADOW_ENDPOINT_HASH) ||
      "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160",
    defaultAmountAtomic: BigInt(clean(env.DESK_SHADOW_AMOUNT_ATOMIC) || "10000"),
  },
};

for (const provider of Object.values(PROVIDERS)) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(provider.endpointHash)) {
    throw new Error(`${provider.key} endpoint hash must be bytes32`);
  }
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "Arc", symbol: "ARC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const executorWallet = createWalletClient({ account: executor, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const deskAgentWallet = createWalletClient({ account: deskAgent, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });

const floatAbi = parseAbi([
  "function requestSignedSpend((address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,uint256 maxDebtUSDC,uint256 nonce,uint256 expiry,address executor,string reason) intent, bytes signature) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function previewSpend(address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 requestHash) view returns (bool allowed,uint8 reason)",
  "function repay(address agent,uint256 amountUSDC,bytes32 requestHash) returns (bytes32)",
  "function refreshSponsoredLineFromBehavior(address agent,bytes32 requestHash) returns (bytes32 receiptHash)",
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
  "function lineProviderMandates(address agent,address provider) view returns (bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function setSponsoredProviderMandate(address agent,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function autonomousLineScore(address agent) view returns (uint16 score,uint256 recommendedLimitUSDC,uint256 cappedLimitUSDC)",
  "function behaviorStats(address agent) view returns (uint16 paidBound,uint16 signedExternalPaid,uint16 repaid,uint16 blocked,uint16 denied,uint16 errorCount)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function intentNonceUsed(address agent,uint256 nonce) view returns (bool)",
  "function treasuryBalanceUSDC() view returns (uint256)",
]);
const ercAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const intentConsumedEvent = parseAbiItem("event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)");
const scoreEvent = parseAbiItem(
  "event DeterministicFloatScored(address indexed agent,uint8 label,uint16 score,uint256 recommendedLimitUSDC,uint16 paidBound,uint16 signedExternalPaid,uint16 repaid,uint16 blocked,uint16 denied,uint16 errorCount)",
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

if (SETUP_MANDATE) {
  const result = await setupCitePayMandate();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const result = await runDeskCycle();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

async function runDeskCycle() {
  const kv = kvConfigFromEnv();
  const history = await loadDeskHistory(kv);
  const state = await readDeskState(history);
  const proposed = await decideDeskAction(state);
  const clamped = clampDecision(proposed, state, history);
  const entry = baseEntry({
    state,
    decision: {
      proposed: serializeProposal(proposed),
      clamped: clamped.clamped ? serializeClamped(clamped) : undefined,
      wasClamped: Boolean(clamped.clamped),
      clampReasons: clamped.clampReasons,
      action: clamped.action,
      provider: clamped.provider?.key,
      amountAtomic: clamped.amountAtomic?.toString(),
      rationale: clamped.rationale,
    },
    bookNote: clamped.bookNote || proposed.bookNote || "Desk cycle completed.",
  });

  try {
    if (clamped.action === "PAY") {
      entry.txs.spend = await executePay(clamped, entry);
      if (clamped.provider?.key === "citepay" && entry.txs.spend?.txHash) {
        entry.txs.ask = await callCitePay(entry.txs.spend.txHash, clamped.rationale);
      }
    } else if (clamped.action === "REPAY") {
      entry.txs.repay = await executeRepay(state, clamped.rationale);
    }
    entry.reviews = await reviewTrackedLines();
    entry.counts = summarizeHistory(history.concat(entry));
    entry.ok = true;
  } catch (error) {
    entry.ok = false;
    entry.error = sanitizeError(error);
    if (!isPolicySkip(entry)) throw error;
  } finally {
    if (LIVE) await persistDeskEntry(kv, history, entry);
  }

  return entry;
}

async function readDeskState(history) {
  const [floatApi, labLineRaw, sponsorRaw, citepayMandateRaw, shadowMandateRaw, treasury, floatUsdc, executorGas, agentUsdc, agentGas, agentAllowance] =
    await Promise.all([
      fetchFloatApi(),
      readFloat("lines", [LAB_AGENT]),
      readFloat("lineSponsors", [LAB_AGENT]),
      readFloat("lineProviderMandates", [LAB_AGENT, PROVIDERS.citepay.provider]),
      readFloat("lineProviderMandates", [LAB_AGENT, PROVIDERS.shadow.provider]),
      readFloat("treasuryBalanceUSDC", []),
      publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "balanceOf", args: [FLOAT] }),
      publicClient.getBalance({ address: executor.address }),
      publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "balanceOf", args: [LAB_AGENT] }),
      publicClient.getBalance({ address: LAB_AGENT }),
      publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "allowance", args: [LAB_AGENT, FLOAT] }),
    ]);
  const line = lineView(labLineRaw);
  const mandates = {
    citepay: mandateView(citepayMandateRaw),
    shadow: mandateView(shadowMandateRaw),
  };
  return {
    ts: new Date().toISOString(),
    cycle: DESK_CYCLE,
    live: LIVE,
    float: FLOAT,
    usdc: USDC,
    labAgent: LAB_AGENT,
    executor: executor.address,
    line,
    sponsor: { sponsor: sponsorRaw[0], reserveUSDC: sponsorRaw[1].toString() },
    mandates,
    floors: {
      treasuryUSDC: treasury.toString(),
      floatUSDC: floatUsdc.toString(),
      executorGasWei: executorGas.toString(),
      agentGasWei: agentGas.toString(),
      agentUSDC: agentUsdc.toString(),
      agentAllowanceUSDC: agentAllowance.toString(),
      minTreasuryUSDC: MIN_TREASURY_ATOMIC.toString(),
      minGasWei: MIN_GAS_WEI.toString(),
    },
    floatApi: summarizeFloatApi(floatApi),
    recent: history.slice(-5).map((entry) => ({
      ts: entry.ts,
      action: entry.decision?.action,
      provider: entry.decision?.provider,
      outcome: entry.ok === false ? "ERROR" : entry.outcome || "OK",
      rationale: entry.decision?.rationale,
    })),
  };
}

async function decideDeskAction(state) {
  const messages = [
    {
      role: "system",
      content:
        "You are Shadow Float Desk, an autonomous credit desk operator. You propose economic actions, but smart contract policy and hard code clamps decide what can execute. Reply with one strict JSON object only.",
    },
    {
      role: "user",
      content: [
        "Choose one action: PAY, SKIP, REPAY, or HOLD.",
        "PAY buys one tiny provider resource when the book would benefit from a fresh external answer.",
        "REPAY clears open lab debt when debt discipline matters.",
        "SKIP or HOLD is correct when policy, budget, usefulness, or freshness does not justify a spend.",
        'JSON shape: {"action":"PAY|SKIP|REPAY|HOLD","provider":"citepay|shadow","amountAtomic":"1000","rationale":"one sentence","bookNote":"one short line about the live Float book"}',
        `Context: ${JSON.stringify(state)}`,
      ].join("\n"),
    },
  ];

  const failures = [];
  const preferred = {
    url: clean(env.DESK_LLM_URL || env.BANKR_LLM_URL) || "https://llm.bankr.bot/v1/chat/completions",
    key: clean(env.DESK_LLM_KEY || env.BANKR_LLM_KEY),
    model: clean(env.DESK_LLM_MODEL || env.BANKR_LLM_MODEL) || "deepseek-v3.2",
    label: clean(env.DESK_LLM_LABEL) || "bankr",
  };
  if (preferred.key) {
    const completion = await callDecisionModel({ ...preferred, messages });
    if (completion.ok) return completion.decision;
    failures.push(completion.reason);
  } else {
    failures.push(`${preferred.label} key missing`);
  }

  return fallbackDecision(state, failures.join("; "));
}

async function callDecisionModel({ url, key, model, label, messages }) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, max_tokens: 320, temperature: 0.28 }),
    });
    if (!response.ok) return { ok: false, reason: `${label} http ${response.status}` };
    const json = await response.json();
    const raw = json.choices?.[0]?.message?.content || "";
    const parsed = safeParse(raw);
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: `${label} returned non-json` };
    const action = String(parsed.action || "").toUpperCase();
    if (!["PAY", "SKIP", "REPAY", "HOLD"].includes(action)) return { ok: false, reason: `${label} invalid action ${action || "empty"}` };
    return {
      ok: true,
      decision: {
        source: label,
        model,
        action,
        provider: String(parsed.provider || "citepay").toLowerCase(),
        amountAtomic: String(parsed.amountAtomic || ""),
        rationale: sanitizeSentence(parsed.rationale || `${action} selected from the live Float book.`),
        bookNote: sanitizeSentence(parsed.bookNote || "Desk reviewed the live Float book."),
      },
    };
  } catch (error) {
    return { ok: false, reason: `${label} ${sanitizeError(error)}` };
  }
}

function fallbackDecision(state, reason) {
  const debt = BigInt(state.line.activeDebtUSDC);
  const recentPay = state.recent.findLast?.((entry) => entry.action === "PAY");
  if (debt > 0n) {
    return {
      source: "deterministic-fallback",
      model: "fallback",
      action: "REPAY",
      provider: "citepay",
      amountAtomic: debt.toString(),
      rationale: `Repay selected because the lab line has ${formatUnits(debt, 6)} USDC of active debt.`,
      bookNote: `Fallback used after model issue: ${reason}`.slice(0, 220),
    };
  }
  if (!recentPay) {
    return {
      source: "deterministic-fallback",
      model: "fallback",
      action: "PAY",
      provider: "citepay",
      amountAtomic: PROVIDERS.citepay.defaultAmountAtomic.toString(),
      rationale: "Buy one CitePay answer to refresh the live provider proof while the lab line has no debt.",
      bookNote: `Fallback used after model issue: ${reason}`.slice(0, 220),
    };
  }
  return {
    source: "deterministic-fallback",
    model: "fallback",
    action: "SKIP",
    provider: "citepay",
    amountAtomic: "0",
    rationale: "Skip because the last desk buy is recent and the lab line has no debt.",
    bookNote: `Fallback used after model issue: ${reason}`.slice(0, 220),
  };
}

function clampDecision(proposed, state, history) {
  const originalAction = String(proposed.action || "SKIP").toUpperCase();
  const provider = PROVIDERS[String(proposed.provider || "citepay").toLowerCase()] || PROVIDERS.citepay;
  const mandate = state.mandates[provider.key];
  const debt = BigInt(state.line.activeDebtUSDC);
  const recentActions = history.slice(-2).map((entry) => entry.decision?.action);
  let action = ["PAY", "SKIP", "REPAY", "HOLD"].includes(originalAction) ? originalAction : "SKIP";
  let amountAtomic = safeBigInt(proposed.amountAtomic) || provider.defaultAmountAtomic;
  let rationale = sanitizeSentence(proposed.rationale || `${action} proposed from live book.`);
  const clampReasons = [];

  if (debt > 0n && action === "PAY" && recentActions.every((item) => item === "PAY")) {
    action = "REPAY";
    amountAtomic = debt;
    clampReasons.push("REPAY_FORCED_AFTER_TWO_PAY_CYCLES_WITH_OPEN_DEBT");
  }

  if (action === "REPAY") {
    if (debt === 0n) {
      action = "SKIP";
      amountAtomic = 0n;
      clampReasons.push("NO_DEBT_TO_REPAY");
    } else if (BigInt(state.floors.agentUSDC) < debt) {
      action = "HOLD";
      amountAtomic = 0n;
      clampReasons.push("AGENT_USDC_BELOW_DEBT");
    } else {
      amountAtomic = debt;
    }
  }

  if (action === "PAY") {
    const paidToday = Number(state.recent.filter((entry) => entry.action === "PAY").length);
    const dailyRemaining = BigInt(mandate.dailyLimitUSDC) > BigInt(state.line.spentTodayUSDC)
      ? BigInt(mandate.dailyLimitUSDC) - BigInt(state.line.spentTodayUSDC)
      : 0n;
    if (amountAtomic <= 0n) clampReasons.push("ZERO_AMOUNT");
    if (amountAtomic > MAX_SPEND_ATOMIC) clampReasons.push("ABOVE_DESK_MAX_SPEND");
    if (amountAtomic > BigInt(mandate.maxPerRequestUSDC)) clampReasons.push("ABOVE_PROVIDER_MANDATE");
    if (amountAtomic > dailyRemaining) clampReasons.push("ABOVE_DAILY_REMAINING");
    if (amountAtomic > BigInt(state.line.availableCreditUSDC)) clampReasons.push("ABOVE_AVAILABLE_CREDIT");
    if (!mandate.active || BigInt(mandate.expiry) <= BigInt(NOW)) clampReasons.push("PROVIDER_MANDATE_INACTIVE");
    if (paidToday >= MAX_SPENDS_PER_DAY) clampReasons.push("DESK_SPEND_COUNT_CAP");
    if (BigInt(state.floors.treasuryUSDC) < MIN_TREASURY_ATOMIC) clampReasons.push("TREASURY_FLOOR");
    if (BigInt(state.floors.executorGasWei) < MIN_GAS_WEI) clampReasons.push("EXECUTOR_GAS_FLOOR");
    if (clampReasons.length > 0) {
      action = "SKIP";
      amountAtomic = 0n;
    }
  }

  if (action === "HOLD") amountAtomic = 0n;
  if (clampReasons.length > 0) {
    rationale = `${rationale} Policy clamp: ${clampReasons.join(", ")}.`;
  }

  return {
    ...proposed,
    action,
    provider,
    amountAtomic,
    rationale,
    bookNote: sanitizeSentence(proposed.bookNote || "Desk reviewed the live Float book."),
    clamped: clampReasons.length > 0 || action !== originalAction,
    clampReasons,
  };
}

async function executePay(decision, entry) {
  if (!LIVE) return { dryRun: true, provider: decision.provider.key, amountUSDC: decision.amountAtomic.toString() };

  const intent = {
    agent: LAB_AGENT,
    provider: decision.provider.provider,
    endpointHash: decision.provider.endpointHash,
    amountUSDC: decision.amountAtomic,
    maxDebtUSDC: BigInt(entry.state.line.activeDebtUSDC) + (decision.amountAtomic * 110n) / 100n,
    nonce: BigInt(Date.now()),
    expiry: BigInt(Math.floor(Date.now() / 1000)) + INTENT_TTL_SECONDS,
    executor: executor.address,
    reason: decision.rationale.slice(0, 420),
  };
  const signature = await deskAgent.signTypedData({ domain, types, primaryType: "FloatSpendIntent", message: intent });
  const digest = hashTypedData({ domain, types, primaryType: "FloatSpendIntent", message: intent });
  const existingReceipt = await readFloat("receiptByRequestHash", [digest]);
  if (!isZeroHash(existingReceipt)) return { alreadyBound: true, requestHash: digest, receiptHash: existingReceipt };

  const [allowed, reason] = await readFloat("previewSpend", [intent.agent, intent.provider, intent.endpointHash, intent.amountUSDC, digest]);
  if (!allowed) return { blockedByPreview: true, requestHash: digest, reason: Number(reason) };

  const providerBefore = await publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "balanceOf", args: [intent.provider] });
  const txHash = await executorWallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "requestSignedSpend",
    args: [intent, signature],
    account: executor,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`requestSignedSpend reverted: ${txHash}`);
  const providerAfter = await publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "balanceOf", args: [intent.provider] });
  const intentConsumed = receipt.logs.some((log) => {
    if (getAddress(log.address) !== FLOAT) return false;
    const decoded = decodeLog(intentConsumedEvent, log);
    return decoded?.args?.requestHash?.toLowerCase() === digest.toLowerCase();
  });
  const providerPaid = receipt.logs.some((log) => {
    if (getAddress(log.address) !== USDC) return false;
    const decoded = decodeLog(transferEvent, log);
    return decoded && getAddress(decoded.args.from) === FLOAT && getAddress(decoded.args.to) === intent.provider && decoded.args.value === intent.amountUSDC;
  });
  return {
    txHash,
    arcscan: txUrl(txHash),
    requestHash: digest,
    rationaleDigest: digest,
    intentConsumed,
    providerPaid,
    providerDeltaUSDC: (providerAfter - providerBefore).toString(),
    provider: decision.provider.key,
    amountUSDC: intent.amountUSDC.toString(),
    maxDebtUSDC: intent.maxDebtUSDC.toString(),
    nonce: intent.nonce.toString(),
    expiry: intent.expiry.toString(),
  };
}

async function executeRepay(state, rationale) {
  const debt = BigInt(state.line.activeDebtUSDC);
  if (debt === 0n) return { skipped: true, reason: "NO_DEBT" };
  if (!LIVE) return { dryRun: true, amountUSDC: debt.toString() };

  const allowance = await publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "allowance", args: [LAB_AGENT, FLOAT] });
  const txs = {};
  if (allowance < debt) {
    const approveTx = await deskAgentWallet.writeContract({
      address: USDC,
      abi: ercAbi,
      functionName: "approve",
      args: [FLOAT, debt],
      account: deskAgent,
      chain,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
    if (approveReceipt.status !== "success") throw new Error(`repay approve reverted: ${approveTx}`);
    txs.approve = approveTx;
  }
  const requestHash = hashJson({ v: 1, domain: "shadow-float-desk:repay", agent: LAB_AGENT, amountUSDC: debt.toString(), rationale, cycle: DESK_CYCLE });
  const repayTx = await deskAgentWallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "repay",
    args: [LAB_AGENT, debt, requestHash],
    account: deskAgent,
    chain,
  });
  const repayReceipt = await publicClient.waitForTransactionReceipt({ hash: repayTx, timeout: 120_000 });
  if (repayReceipt.status !== "success") throw new Error(`repay reverted: ${repayTx}`);
  return { ...txs, txHash: repayTx, arcscan: txUrl(repayTx), requestHash, amountUSDC: debt.toString() };
}

async function callCitePay(txHash, rationale) {
  try {
    const response = await fetch(CITEPAY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Arc-Tx-Hash": txHash },
      body: JSON.stringify({ query: CITEPAY_QUERY, policy: "balanced", rationale }),
    });
    const text = await response.text();
    const body = safeParse(text) || { raw: text.slice(0, 240) };
    return {
      ok: response.ok,
      status: response.status,
      queryId: body.queryId || body.id || body.receiptId || null,
      receipt: summarizeCitePayBody(body),
    };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

async function reviewTrackedLines() {
  if (!LIVE) return [];
  const uniqueAgents = [...new Set([...FLOAT_V2_TRACKED_EXTERNAL_AGENTS.map((entry) => getAddress(entry.agent)), LAB_AGENT])];
  const reviews = [];
  for (const agent of uniqueAgents) {
    try {
      const [beforeLine, sponsorBefore, scoreBefore, statsBefore] = await Promise.all([
        readFloat("lines", [agent]),
        readFloat("lineSponsors", [agent]),
        readFloat("autonomousLineScore", [agent]),
        readFloat("behaviorStats", [agent]),
      ]);
      if (getAddress(sponsorBefore[0]) === zeroAddress()) {
        reviews.push({ agent, skipped: "NO_SPONSOR" });
        continue;
      }
      const requestHash = hashJson({ v: 1, domain: "shadow-float-desk:review", agent, cycle: DESK_CYCLE });
      const txHash = await executorWallet.writeContract({
        address: FLOAT,
        abi: floatAbi,
        functionName: "refreshSponsoredLineFromBehavior",
        args: [agent, requestHash],
        account: executor,
        chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`refresh reverted: ${txHash}`);
      const [afterLine, scoreAfter, statsAfter] = await Promise.all([
        readFloat("lines", [agent]),
        readFloat("autonomousLineScore", [agent]),
        readFloat("behaviorStats", [agent]),
      ]);
      const scoreEventLog = receipt.logs.map((log) => decodeLog(scoreEvent, log)).find((decoded) => decoded?.args?.agent && getAddress(decoded.args.agent) === agent);
      reviews.push({
        agent,
        txHash,
        arcscan: txUrl(txHash),
        scoreBefore: Number(scoreBefore[0]),
        scoreAfter: Number(scoreAfter[0]),
        limitBeforeUSDC: beforeLine[2].toString(),
        limitAfterUSDC: afterLine[2].toString(),
        behaviorBefore: behaviorView(statsBefore),
        behaviorAfter: behaviorView(statsAfter),
        eventScore: scoreEventLog ? Number(scoreEventLog.args.score) : null,
      });
    } catch (error) {
      reviews.push({ agent, error: sanitizeError(error) });
    }
  }
  return reviews;
}

async function setupCitePayMandate() {
  const sponsor = await readFloat("lineSponsors", [LAB_AGENT]);
  const sponsorAddress = getAddress(sponsor[0]);
  if (sponsorAddress === zeroAddress()) return { ok: false, error: "lab agent has no sponsored line", labAgent: LAB_AGENT };
  if (sponsorAddress !== getAddress(executor.address)) {
    return { ok: false, error: `executor ${executor.address} is not lab sponsor ${sponsorAddress}`, labAgent: LAB_AGENT };
  }
  const expiry = BigInt(clean(env.DESK_PROVIDER_EXPIRY) || String(NOW + 7 * 24 * 3600));
  const dailyLimit = BigInt(clean(env.DESK_CITEPAY_DAILY_LIMIT_ATOMIC) || "30000");
  if (!LIVE) {
    return {
      ok: true,
      dryRun: true,
      labAgent: LAB_AGENT,
      sponsor: sponsorAddress,
      provider: PROVIDERS.citepay.provider,
      endpointHash: PROVIDERS.citepay.endpointHash,
      maxPerRequestUSDC: PROVIDERS.citepay.defaultAmountAtomic.toString(),
      dailyLimitUSDC: dailyLimit.toString(),
      expiry: expiry.toString(),
    };
  }
  const txHash = await executorWallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "setSponsoredProviderMandate",
    args: [LAB_AGENT, PROVIDERS.citepay.provider, PROVIDERS.citepay.endpointHash, PROVIDERS.citepay.defaultAmountAtomic, dailyLimit, expiry, true],
    account: executor,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return { ok: receipt.status === "success", txHash, arcscan: txUrl(txHash), labAgent: LAB_AGENT, provider: PROVIDERS.citepay.provider, expiry: expiry.toString() };
}

function baseEntry({ state, decision, bookNote }) {
  return {
    version: 1,
    source: "desk-lab",
    ok: null,
    live: LIVE,
    cycle: DESK_CYCLE,
    ts: new Date().toISOString(),
    network: "arc-testnet",
    float: FLOAT,
    labAgent: LAB_AGENT,
    executor: executor.address,
    state,
    decision,
    bookNote,
    txs: {},
    reviews: [],
  };
}

async function fetchFloatApi() {
  try {
    const url = FLOAT_API_URL.includes("?") ? `${FLOAT_API_URL}&deskTs=${Date.now()}` : `${FLOAT_API_URL}?deskTs=${Date.now()}`;
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && body?.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function summarizeFloatApi(api) {
  if (!api?.body) return api;
  return {
    ok: api.ok,
    checkedAt: api.body.checkedAt,
    summary: api.body.summary,
    latestBlock: api.body.latestBlock,
  };
}

async function readFloat(functionName, args) {
  return publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName, args });
}

async function loadDeskHistory(kv) {
  if (!kv) return [];
  try {
    const current = await kvGet(kv, "float:desk:runs");
    return Array.isArray(current) ? current : [];
  } catch (error) {
    console.warn(`desk kv read skipped: ${sanitizeError(error)}`);
    return [];
  }
}

async function persistDeskEntry(kv, history, entry) {
  if (!kv) {
    console.warn("KV not configured; desk entry printed only");
    return;
  }
  const next = history.concat([compactEntry(entry)]).slice(-JOURNAL_LIMIT);
  await kvSet(kv, "float:desk:latest", compactEntry(entry));
  await kvSet(kv, "float:desk:runs", next);
}

function compactEntry(entry) {
  return {
    ...entry,
    state: {
      ts: entry.state.ts,
      line: entry.state.line,
      sponsor: entry.state.sponsor,
      floors: entry.state.floors,
      floatApi: entry.state.floatApi,
    },
  };
}

async function kvGet(kv, key) {
  const response = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!response.ok) throw new Error(`kv get failed ${response.status}`);
  const json = await response.json();
  if (json.result === null || json.result === undefined) return null;
  return typeof json.result === "string" ? safeParse(json.result) ?? json.result : json.result;
}

async function kvSet(kv, key, value) {
  const response = await fetch(`${kv.url}/set/${encodeURIComponent(key)}?EX=2592000`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`kv set failed ${response.status}`);
}

function kvConfigFromEnv() {
  const url = clean(env.KV_REST_API_URL);
  const token = clean(env.KV_REST_API_TOKEN);
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function lineView(line) {
  return {
    wallet: line[0],
    score: Number(line[1]),
    creditLimitUSDC: line[2].toString(),
    availableCreditUSDC: line[3].toString(),
    activeDebtUSDC: line[4].toString(),
    status: Number(line[5]),
    lastReview: line[6].toString(),
    mandateId: line[7],
    day: line[8].toString(),
    spentTodayUSDC: line[9].toString(),
  };
}

function mandateView(mandate) {
  return {
    endpointHash: mandate[0],
    maxPerRequestUSDC: mandate[1].toString(),
    dailyLimitUSDC: mandate[2].toString(),
    expiry: String(mandate[3]),
    active: Boolean(mandate[4]),
  };
}

function behaviorView(stats) {
  return {
    paidBound: Number(stats[0]),
    signedExternalPaid: Number(stats[1]),
    repaid: Number(stats[2]),
    blocked: Number(stats[3]),
    denied: Number(stats[4]),
    errorCount: Number(stats[5]),
  };
}

function summarizeCitePayBody(body) {
  if (!body || typeof body !== "object") return null;
  return {
    queryId: body.queryId || body.id || null,
    receiptId: body.receiptId || body.receipt?.id || null,
    hasAnswer: Boolean(body.answer || body.result || body.response),
    citationCount: Array.isArray(body.citations) ? body.citations.length : undefined,
  };
}

function summarizeHistory(history) {
  return {
    cycles: history.length,
    pays: history.filter((entry) => entry.decision?.action === "PAY").length,
    skips: history.filter((entry) => entry.decision?.action === "SKIP").length,
    holds: history.filter((entry) => entry.decision?.action === "HOLD").length,
    repays: history.filter((entry) => entry.decision?.action === "REPAY").length,
    clamps: history.filter((entry) => entry.decision?.wasClamped).length,
  };
}

function serializeProposal(decision) {
  return {
    source: decision.source,
    model: decision.model,
    action: decision.action,
    provider: decision.provider,
    amountAtomic: decision.amountAtomic ? String(decision.amountAtomic) : undefined,
    rationale: decision.rationale,
    bookNote: decision.bookNote,
  };
}

function serializeClamped(decision) {
  return {
    action: decision.action,
    provider: decision.provider?.key,
    amountAtomic: decision.amountAtomic?.toString(),
    rationale: decision.rationale,
    bookNote: decision.bookNote,
    clampReasons: decision.clampReasons,
  };
}

function sanitizeSentence(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(sk-[A-Za-z0-9_-]{12,}|swrm_[A-Za-z0-9_-]+|croo_sk_[A-Za-z0-9_-]+|0x[a-fA-F0-9]{64})/g, "[redacted]")
    .trim()
    .slice(0, 420);
}

function sanitizeError(error) {
  return sanitizeSentence(error?.shortMessage || error?.message || String(error)).slice(0, 260);
}

function isPolicySkip(entry) {
  return entry.decision?.action === "SKIP" || entry.decision?.action === "HOLD";
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

function hashJson(value) {
  return keccak256(stringToBytes(JSON.stringify(value)));
}

function txUrl(hash) {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeBigInt(value) {
  try {
    if (value === undefined || value === null || value === "") return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

function isZeroHash(value) {
  return String(value || "").toLowerCase() === "0x0000000000000000000000000000000000000000000000000000000000000000";
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

function parseUnits18(value) {
  const [whole, frac = ""] = String(value).split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}
