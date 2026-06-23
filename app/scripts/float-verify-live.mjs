import { readFileSync } from "node:fs";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";

const CHAIN_ID = 5_042_002;
const DEFAULT_API = "https://shadow-arc.vercel.app/api/float";
const DEFAULT_RPC = "https://rpc.testnet.arc.network";
const apiUrl = clean(process.env.FLOAT_API_URL) || DEFAULT_API;
const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || DEFAULT_RPC;

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }) });

const floatAbi = parseAbi([
  "function receiptCount() view returns (uint256)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);

const state = await fetchJson(apiUrl);
if (!state?.configured) {
  failAndExit([{ check: "api configured", ok: false, detail: state?.missing?.join(", ") || "not configured" }]);
}

const float = getAddress(state.float);
const usdc = getAddress(state.usdc);
const receipts = Array.isArray(state.receipts) ? state.receipts : [];
const pointers = state.proofPointers || {};
const x402Receipt = pointers.x402BoundReceipt || receipts.find((receipt) => receipt.x402);
const debtReceipt = x402Receipt
  ? pointers.debtReceipt || receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED" && sameHash(receipt.requestHash, x402Receipt.requestHash))
  : pointers.debtReceipt || receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED");
const repayReceipt = pointers.repaymentReceipt || receipts.find(
  (receipt) => receipt.receiptType === "REPAID" && toBig(receipt.debtAfterUSDC) < toBig(receipt.debtBeforeUSDC),
);
const overspendReceipt = pointers.overspendReceipt || receipts.find((receipt) => receipt.receiptType === "SPEND_BLOCKED" && receipt.reason === "AMOUNT_TOO_HIGH");
const denialReceipt = pointers.denialReceipt || receipts.find((receipt) => receipt.receiptType === "CREDIT_DENIED");

const readmeContract = readReadmeContract();
const [chainReceiptCount, treasury, totalAvailable] = await Promise.all([
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "receiptCount" }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "treasuryBalanceUSDC" }),
  publicClient.readContract({ address: float, abi: floatAbi, functionName: "totalAvailableCreditUSDC" }),
]);

const checks = [];
check("live contract matches README", readmeContract ? getAddress(readmeContract) === float : false, readmeContract || "missing README contract");
check("api receipt count matches chain", toBig(state.receiptCount) === chainReceiptCount, `${state.receiptCount} api / ${chainReceiptCount} chain`);
check("logFetch.complete", Boolean(state.logFetch?.complete), JSON.stringify(state.logFetch || {}));
check("treasury backs available capacity", treasury >= totalAvailable, `${fmt(treasury)} treasury / ${fmt(totalAvailable)} available`);
check("api proofChecks has x402 bound spend", Boolean(state.proofChecks?.hasX402BoundSpend), "proofChecks.hasX402BoundSpend");

if (x402Receipt?.x402) {
  const settlementOk = await verifySettlementTransfer({
    usdc,
    txHash: x402Receipt.x402.x402Hash,
    from: x402Receipt.x402.facilitator,
    to: x402Receipt.x402.provider,
    amount: toBig(x402Receipt.x402.amountUSDC),
  });
  check("x402 settlement transferred Arc USDC facilitator -> provider", settlementOk.ok, settlementOk.detail);

  const bindOk = await verifyBindEvent({
    float,
    txHash: x402Receipt.x402.bindingTxHash,
    requestHash: x402Receipt.requestHash,
    x402Hash: x402Receipt.x402.x402Hash,
    provider: x402Receipt.x402.provider,
    amount: toBig(x402Receipt.x402.amountUSDC),
  });
  check("bind tx emitted matching X402PaymentBound", bindOk.ok, bindOk.detail);

  const receiptHash = await publicClient.readContract({
    address: float,
    abi: floatAbi,
    functionName: "receiptByRequestHash",
    args: [x402Receipt.requestHash],
  });
  check("receiptByRequestHash is anchored", receiptHash !== zeroHash(), receiptHash);
} else {
  check("x402 settlement transferred Arc USDC facilitator -> provider", false, "no x402 receipt in API");
  check("bind tx emitted matching X402PaymentBound", false, "no x402 receipt in API");
  check("receiptByRequestHash is anchored", false, "no x402 receipt in API");
}

if (debtReceipt) {
  const providerAmount = toBig(debtReceipt.providerAmountUSDC || debtReceipt.amountUSDC);
  const debtOpened = toBig(debtReceipt.debtOpenedUSDC || debtReceipt.debtDeltaUSDC);
  const expectedFee = (providerAmount * BigInt(Number(state.feeBps || 0))) / 10_000n;
  check(
    "debt opened = provider amount + fee",
    debtOpened === providerAmount + expectedFee,
    `${fmt(providerAmount)} provider + ${fmt(expectedFee)} fee = ${fmt(debtOpened)} debt`,
  );
} else {
  check("debt opened = provider amount + fee", false, "no DEBT_OPENED receipt");
}

check(
  "repayment reduced debt",
  Boolean(repayReceipt),
  repayReceipt ? `${fmt(toBig(repayReceipt.debtBeforeUSDC))} -> ${fmt(toBig(repayReceipt.debtAfterUSDC))}` : "no REPAID receipt",
);

if (overspendReceipt) {
  const noTransfer = await txHasNoFloatPayout(overspendReceipt.transactionHash, {
    usdc,
    float,
    provider: overspendReceipt.provider,
    facilitator: x402Receipt?.x402?.facilitator,
  });
  check("overspend moved no provider/treasury funds", noTransfer.ok, noTransfer.detail);
} else {
  check("overspend moved no provider/treasury funds", false, "no AMOUNT_TOO_HIGH SPEND_BLOCKED receipt");
}

if (denialReceipt) {
  const noTransfer = await txHasNoFloatPayout(denialReceipt.transactionHash, {
    usdc,
    float,
    provider: denialReceipt.provider,
    facilitator: x402Receipt?.x402?.facilitator,
  });
  check("denial moved no provider/treasury funds", noTransfer.ok, noTransfer.detail);
} else {
  check("denial moved no provider/treasury funds", false, "no CREDIT_DENIED receipt");
}

const activeDebt = (state.standingBoard?.agents || []).reduce((sum, agent) => sum + toBig(agent.activeDebtUSDC), 0n);
const expectedActiveDebt = clampSub(toBig(state.totalDebtOpenedUSDC), toBig(state.totalRepaidUSDC));
check("active debt equals debt opened - repaid", activeDebt === expectedActiveDebt, `${fmt(activeDebt)} active / ${fmt(expectedActiveDebt)} expected`);

const result = {
  ok: checks.every((entry) => entry.ok),
  checkedAt: new Date().toISOString(),
  apiUrl,
  rpcUrl: rpcUrl === DEFAULT_RPC ? DEFAULT_RPC : "[custom rpc]",
  float,
  receipts: {
    api: state.receiptCount,
    visible: receipts.length,
    chain: chainReceiptCount.toString(),
  },
  checks,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

function check(name, ok, detail = "") {
  checks.push({ check: name, status: ok ? "PASS" : "FAIL", ok, detail: String(detail) });
}

async function verifySettlementTransfer({ usdc, txHash, from, to, amount }) {
  try {
    const [tx, receipt] = await Promise.all([
      publicClient.getTransaction({ hash: txHash }),
      publicClient.getTransactionReceipt({ hash: txHash }),
    ]);
    if (receipt.status !== "success") return { ok: false, detail: "settlement tx failed" };
    if (!tx.to || getAddress(tx.to) !== usdc) return { ok: false, detail: `settlement tx.to ${tx.to || "null"} is not USDC` };
    const matched = receipt.logs.some((log) => {
      if (getAddress(log.address) !== usdc) return false;
      const decoded = decodeLog(transferEvent, log);
      return Boolean(
        decoded &&
          getAddress(decoded.args.from) === getAddress(from) &&
          getAddress(decoded.args.to) === getAddress(to) &&
          decoded.args.value === amount,
      );
    });
    return matched
      ? { ok: true, detail: `${fmt(amount)} USDC ${short(from)} -> ${short(to)}` }
      : { ok: false, detail: "missing matching USDC Transfer event" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function verifyBindEvent({ float, txHash, requestHash, x402Hash, provider, amount }) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, detail: "bind tx failed" };
    const matched = receipt.logs.some((log) => {
      if (getAddress(log.address) !== float) return false;
      const decoded = decodeLog(x402PaymentBoundEvent, log);
      return Boolean(
        decoded &&
          sameHash(decoded.args.requestHash, requestHash) &&
          sameHash(decoded.args.x402Hash, x402Hash) &&
          getAddress(decoded.args.provider) === getAddress(provider) &&
          decoded.args.amountUSDC === amount,
      );
    });
    return matched ? { ok: true, detail: txHash } : { ok: false, detail: "missing matching X402PaymentBound event" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function txHasNoFloatPayout(txHash, { usdc, float, provider, facilitator }) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, detail: "tx failed" };
    const senders = new Set([getAddress(float).toLowerCase()]);
    if (facilitator) senders.add(getAddress(facilitator).toLowerCase());
    const providerLc = getAddress(provider).toLowerCase();
    const leaked = receipt.logs.some((log) => {
      if (getAddress(log.address) !== usdc) return false;
      const decoded = decodeLog(transferEvent, log);
      return Boolean(
        decoded &&
          senders.has(getAddress(decoded.args.from).toLowerCase()) &&
          getAddress(decoded.args.to).toLowerCase() === providerLc &&
          decoded.args.value > 0n,
      );
    });
    return leaked ? { ok: false, detail: "found payout Transfer in blocked/denied tx" } : { ok: true, detail: "no payout Transfer" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function readReadmeContract() {
  try {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const match = readme.match(/Float contract\s*\|\s*`(0x[a-fA-F0-9]{40})`/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

function toBig(value) {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function clampSub(a, b) {
  return a > b ? a - b : 0n;
}

function fmt(value) {
  const raw = toBig(value);
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function sameHash(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function short(value) {
  const v = String(value || "");
  return v.length > 14 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v;
}

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function sanitize(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^\s"']+/gi, "[rpc]")
    .slice(0, 180);
}

function failAndExit(checks) {
  console.log(JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), checks }, null, 2));
  process.exit(1);
}
