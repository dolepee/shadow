import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";

const env = {
  ...readEnv(new URL("../../.env", import.meta.url)),
  ...readEnv(new URL("../../.vercel/.env.production.local", import.meta.url)),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const DEFAULT_RPC = "https://rpc.testnet.arc.network";
const DEFAULT_API = "https://shadow-arc.vercel.app/api/float";
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const DEFAULT_FLOAT = "0xF305647bA0ff7f1E2d4bE5f37F2EF9f930531057";
const DEFAULT_ATTESTOR = "0x9b5afc6c442364d4397763917ebbc659d85ee86d";
const DEFAULT_ENFORCER = "0x1825f447c0aa8e64dd2d290cdce85d82993d0e1e";
const DEFAULT_MORPHO_ADAPTER = "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5";
const DEFAULT_MORPHO_SINK = "0x110f79c5617797b199d3d6e2abb855c34fbc5e58";
const DEFAULT_OPERATOR = "0x26bA923FbbB4404395E61f94Ca4b39823A1763c5";
const DEFAULT_PROVIDER = "0x8ddf06fE8985988d3e0883F945E891BD57084937";

const DEFAULT_PROOF = {
  createMandateTx: "0x5f511e1bf49fadf998b7a94f5e34598510e9479fab15f5a5fb713636c158a411",
  allowedAllocationTx: "0x9836e74ee95907847fac464f3a65554cf314adab9efe7141f4644022b3e09c17",
  blockedAllocationTx: "0x7d3dddd89dc50ea5b410564c7f1134ce1350fd3687e8cefec74192d9e9b4bd23",
  x402SettlementTx: "0x516d95ed55d61663c491f2cccb45d1d16d83967bdcc6fc66899d05426fea80ab",
  floatBindTx: "0x7fe14e70081f682017d5804250f9db6b0dc7416fe1eb100f7135c6e34007d103",
  allowedActionHash: "0x7b0f276c844b63db15c82995ba154ffb136dab19aa7481a853ce95eedff16205",
  blockedActionHash: "0xe93a7933e6ce39a04dcb0bf8561c838930f8333b6d4eeb4f60db4d2a366b7523",
  floatRequestHash: "0xbcb5bbbcdd270198a5c4258d34ac1c0625c8b807f8fe8dde8912ac12feda910b",
  allowedAmountUSDC: 100_000n,
  blockedAmountUSDC: 300_000n,
  x402AmountUSDC: 1_000n,
  feeUSDC: 10n,
};

const rpcUrl = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || DEFAULT_RPC;
const apiUrl = clean(env.TREASURY_VERIFY_FLOAT_API_URL || env.FLOAT_API_URL) || DEFAULT_API;
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || DEFAULT_USDC);
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || DEFAULT_FLOAT);
const ATTESTOR = getAddress(clean(env.LEPTON_ATTESTOR || env.VITE_SHADOW_MANDATE_ATTESTOR) || DEFAULT_ATTESTOR);
const ENFORCER = getAddress(clean(env.LEPTON_ENFORCER || env.VITE_SHADOW_BONDED_ENFORCER) || DEFAULT_ENFORCER);
const MORPHO_ADAPTER = getAddress(clean(env.LEPTON_MORPHO_ADAPTER || env.VITE_SHADOW_MORPHO_STYLE_ADAPTER) || DEFAULT_MORPHO_ADAPTER);
const MORPHO_SINK = getAddress(clean(env.LEPTON_MORPHO_VAULT_SINK || env.VITE_SHADOW_MORPHO_VAULT_SINK) || DEFAULT_MORPHO_SINK);
const OPERATOR = getAddress(clean(env.TREASURY_OPERATOR_ADDRESS) || DEFAULT_OPERATOR);
const PROVIDER = getAddress(clean(env.TREASURY_OPERATOR_PROVIDER) || DEFAULT_PROVIDER);

const proof = {
  createMandateTx: hashEnv("TREASURY_VERIFY_CREATE_MANDATE_TX", DEFAULT_PROOF.createMandateTx),
  allowedAllocationTx: hashEnv("TREASURY_VERIFY_ALLOWED_TX", DEFAULT_PROOF.allowedAllocationTx),
  blockedAllocationTx: hashEnv("TREASURY_VERIFY_BLOCKED_TX", DEFAULT_PROOF.blockedAllocationTx),
  x402SettlementTx: hashEnv("TREASURY_VERIFY_X402_SETTLEMENT_TX", DEFAULT_PROOF.x402SettlementTx),
  floatBindTx: hashEnv("TREASURY_VERIFY_FLOAT_BIND_TX", DEFAULT_PROOF.floatBindTx),
  allowedActionHash: hashEnv("TREASURY_VERIFY_ALLOWED_ACTION_HASH", DEFAULT_PROOF.allowedActionHash),
  blockedActionHash: hashEnv("TREASURY_VERIFY_BLOCKED_ACTION_HASH", DEFAULT_PROOF.blockedActionHash),
  floatRequestHash: hashEnv("TREASURY_VERIFY_FLOAT_REQUEST_HASH", DEFAULT_PROOF.floatRequestHash),
  allowedAmountUSDC: bigintEnv("TREASURY_VERIFY_ALLOWED_AMOUNT_ATOMIC", DEFAULT_PROOF.allowedAmountUSDC),
  blockedAmountUSDC: bigintEnv("TREASURY_VERIFY_BLOCKED_AMOUNT_ATOMIC", DEFAULT_PROOF.blockedAmountUSDC),
  x402AmountUSDC: bigintEnv("TREASURY_VERIFY_X402_AMOUNT_ATOMIC", DEFAULT_PROOF.x402AmountUSDC),
  feeUSDC: bigintEnv("TREASURY_VERIFY_FEE_ATOMIC", DEFAULT_PROOF.feeUSDC),
};

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }) });

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);

const attestorAbi = parseAbi([
  "function receiptByActionHash(bytes32 actionHash) view returns (bytes32)",
  "function getReceiptDecision(bytes32 receiptHash) view returns (uint256 mandateId,uint256 amountUSDC,uint8 decision,uint8 reason,bytes32 executionRef)",
  "function getReceiptParties(bytes32 receiptHash) view returns (address actor,address circleAccount,address enforcer,address settlementAsset,address target)",
]);
const enforcerAbi = parseAbi(["function bondUSDC(address enforcer) view returns (uint256)"]);
const morphoAbi = parseAbi(["function adapterBondUSDC() view returns (uint256)"]);
const floatAbi = parseAbi([
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
]);

const checks = [];

const [floatState, createTx, allowedTx, blockedTx, x402Tx, bindTx] = await Promise.all([
  fetchJson(apiUrl),
  txReceipt(proof.createMandateTx),
  txReceipt(proof.allowedAllocationTx),
  txReceipt(proof.blockedAllocationTx),
  txReceipt(proof.x402SettlementTx),
  txReceipt(proof.floatBindTx),
]);

check("create mandate tx succeeded", createTx.ok, createTx.detail);
check("allowed allocation tx succeeded", allowedTx.ok, allowedTx.detail);
check("blocked allocation tx succeeded", blockedTx.ok, blockedTx.detail);
check("x402 settlement tx succeeded", x402Tx.ok, x402Tx.detail);
check("Float bind tx succeeded", bindTx.ok, bindTx.detail);

const [adapterBond, enforcerBond, treasuryBalance, totalAvailable, allowedReceipt, blockedReceipt, floatReceiptHash] =
  await Promise.all([
    publicClient.readContract({ address: MORPHO_ADAPTER, abi: morphoAbi, functionName: "adapterBondUSDC" }),
    publicClient.readContract({ address: ENFORCER, abi: enforcerAbi, functionName: "bondUSDC", args: [MORPHO_ADAPTER] }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "treasuryBalanceUSDC" }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "totalAvailableCreditUSDC" }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "receiptByActionHash", args: [proof.allowedActionHash] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "receiptByActionHash", args: [proof.blockedActionHash] }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "receiptByRequestHash", args: [proof.floatRequestHash] }),
  ]);

check("Morpho-style adapter has bond", adapterBond > 0n, `${fmt(adapterBond)} USDC`);
check("bonded enforcer records adapter bond", enforcerBond > 0n, `${fmt(enforcerBond)} USDC`);
check("Float treasury backs available capacity", treasuryBalance >= totalAvailable, `${fmt(treasuryBalance)} treasury / ${fmt(totalAvailable)} available`);
check("allowed action hash anchored", allowedReceipt !== zeroHash(), allowedReceipt);
check("blocked action hash anchored", blockedReceipt !== zeroHash(), blockedReceipt);
check("Float request hash anchored", floatReceiptHash !== zeroHash(), floatReceiptHash);

if (allowedReceipt !== zeroHash() && blockedReceipt !== zeroHash()) {
  const [allowedDecision, blockedDecision, allowedParties, blockedParties] = await Promise.all([
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptDecision", args: [allowedReceipt] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptDecision", args: [blockedReceipt] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptParties", args: [allowedReceipt] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptParties", args: [blockedReceipt] }),
  ]);
  check(
    "allowed receipt is ALLOW/NONE",
    Number(allowedDecision[2]) === 0 && Number(allowedDecision[3]) === 0 && allowedDecision[1] === proof.allowedAmountUSDC,
    `decision=${allowedDecision[2]} reason=${allowedDecision[3]} amount=${fmt(allowedDecision[1])}`,
  );
  check(
    "blocked receipt is BLOCK/AMOUNT_TOO_HIGH",
    Number(blockedDecision[2]) === 1 && Number(blockedDecision[3]) === 3 && blockedDecision[1] === proof.blockedAmountUSDC,
    `decision=${blockedDecision[2]} reason=${blockedDecision[3]} amount=${fmt(blockedDecision[1])}`,
  );
  check("allowed receipt actor is operator", sameAddress(allowedParties[0], OPERATOR), allowedParties[0]);
  check("blocked receipt actor is operator", sameAddress(blockedParties[0], OPERATOR), blockedParties[0]);
  check("allowed receipt targets Morpho-style adapter", sameAddress(allowedParties[4], MORPHO_ADAPTER), allowedParties[4]);
  check("blocked receipt targets Morpho-style adapter", sameAddress(blockedParties[4], MORPHO_ADAPTER), blockedParties[4]);
}

const allowedTransfer = await verifyTransfer(proof.allowedAllocationTx, {
  from: OPERATOR,
  to: MORPHO_SINK,
  amount: proof.allowedAmountUSDC,
});
check("allowed allocation moved Arc USDC into vault sink", allowedTransfer.ok, allowedTransfer.detail);

const blockedTransfer = await verifyNoTransfer(proof.blockedAllocationTx, { from: OPERATOR, to: MORPHO_SINK });
check("blocked allocation moved no vault USDC", blockedTransfer.ok, blockedTransfer.detail);

const settlementTransfer = await verifyTransfer(proof.x402SettlementTx, {
  from: OPERATOR,
  to: PROVIDER,
  amount: proof.x402AmountUSDC,
});
check("x402 settlement transferred Arc USDC operator -> provider", settlementTransfer.ok, settlementTransfer.detail);

const bindEvent = await verifyX402Bound();
check("Float bind emitted matching X402PaymentBound", bindEvent.ok, bindEvent.detail);

const apiReceipts = Array.isArray(floatState?.receipts) ? floatState.receipts : [];
const requestReceipts = apiReceipts.filter((receipt) => sameHash(receipt.requestHash, proof.floatRequestHash));
const apiTypes = new Set(requestReceipts.map((receipt) => receipt.receiptType));
check("Float API indexes this Treasury request", requestReceipts.length >= 4, `${requestReceipts.length} receipts`);
check("Float API shows spend/provider/fee/debt lifecycle", ["SPEND_ALLOWED", "PROVIDER_PAID", "FEE_ACCRUED", "DEBT_OPENED"].every((type) => apiTypes.has(type)), [...apiTypes].join(", "));

const debtReceipt = requestReceipts.find((receipt) => receipt.receiptType === "DEBT_OPENED");
if (debtReceipt) {
  const providerAmount = toBig(debtReceipt.providerAmountUSDC || debtReceipt.amountUSDC);
  const fee = toBig(debtReceipt.feeUSDC) || proof.feeUSDC;
  const debtOpened = toBig(debtReceipt.debtOpenedUSDC || debtReceipt.debtDeltaUSDC);
  check("Float debt equals x402 amount plus fee", debtOpened === providerAmount + fee, `${fmt(providerAmount)} + ${fmt(fee)} = ${fmt(debtOpened)}`);
} else {
  check("Float debt equals x402 amount plus fee", false, "missing DEBT_OPENED receipt");
}

check("Float API proof checks remain green", Boolean(floatState?.proofChecks?.hasX402BoundSpend && floatState?.proofChecks?.feeMechanicsVisible), JSON.stringify(floatState?.proofChecks || {}));

const result = {
  ok: checks.every((entry) => entry.ok),
  checkedAt: new Date().toISOString(),
  mode: "shadow-treasury-live-verifier",
  chainId: CHAIN_ID,
  rpcUrl: rpcUrl === DEFAULT_RPC ? DEFAULT_RPC : "[custom rpc]",
  apiUrl,
  operator: OPERATOR,
  contracts: {
    float: FLOAT,
    mandateAttestor: ATTESTOR,
    bondedEnforcer: ENFORCER,
    morphoStyleVaultAdapter: MORPHO_ADAPTER,
    morphoStyleVaultSink: MORPHO_SINK,
  },
  txs: {
    createMandate: proof.createMandateTx,
    allowedAllocation: proof.allowedAllocationTx,
    blockedAllocation: proof.blockedAllocationTx,
    x402Settlement: proof.x402SettlementTx,
    floatBind: proof.floatBindTx,
  },
  requestHash: proof.floatRequestHash,
  actionHashes: {
    allowed: proof.allowedActionHash,
    blocked: proof.blockedActionHash,
  },
  amounts: {
    allowedAllocationUSDC: fmt(proof.allowedAmountUSDC),
    blockedAttemptUSDC: fmt(proof.blockedAmountUSDC),
    x402PaidUSDC: fmt(proof.x402AmountUSDC),
    floatFeeUSDC: fmt(proof.feeUSDC),
  },
  checks,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

function check(name, ok, detail = "") {
  checks.push({ check: name, status: ok ? "PASS" : "FAIL", ok, detail: String(detail) });
}

async function txReceipt(txHash) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    return receipt.status === "success"
      ? { ok: true, detail: `block ${receipt.blockNumber}` }
      : { ok: false, detail: `status ${receipt.status}` };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function verifyTransfer(txHash, expected) {
  try {
    const [tx, receipt] = await Promise.all([
      publicClient.getTransaction({ hash: txHash }),
      publicClient.getTransactionReceipt({ hash: txHash }),
    ]);
    if (receipt.status !== "success") return { ok: false, detail: "tx failed" };
    if (txHash === proof.x402SettlementTx && (!tx.to || !sameAddress(tx.to, USDC))) {
      return { ok: false, detail: `settlement tx.to ${tx.to || "null"} is not Arc USDC` };
    }
    const matched = receipt.logs.some((log) => {
      if (!sameAddress(log.address, USDC)) return false;
      const decoded = decodeLog(transferEvent, log);
      return Boolean(
        decoded &&
          sameAddress(decoded.args.from, expected.from) &&
          sameAddress(decoded.args.to, expected.to) &&
          decoded.args.value === expected.amount,
      );
    });
    return matched
      ? { ok: true, detail: `${fmt(expected.amount)} USDC ${short(expected.from)} -> ${short(expected.to)}` }
      : { ok: false, detail: "missing matching Arc USDC Transfer" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function verifyNoTransfer(txHash, expected) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, detail: "tx failed" };
    const leaked = receipt.logs.some((log) => {
      if (!sameAddress(log.address, USDC)) return false;
      const decoded = decodeLog(transferEvent, log);
      return Boolean(
        decoded &&
          sameAddress(decoded.args.from, expected.from) &&
          sameAddress(decoded.args.to, expected.to) &&
          decoded.args.value > 0n,
      );
    });
    return leaked ? { ok: false, detail: "found unexpected Arc USDC Transfer" } : { ok: true, detail: "no vault Transfer" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function verifyX402Bound() {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: proof.floatBindTx });
    if (receipt.status !== "success") return { ok: false, detail: "bind tx failed" };
    const matched = receipt.logs.some((log) => {
      if (!sameAddress(log.address, FLOAT)) return false;
      const decoded = decodeLog(x402PaymentBoundEvent, log);
      return Boolean(
        decoded &&
          sameHash(decoded.args.requestHash, proof.floatRequestHash) &&
          sameHash(decoded.args.x402Hash, proof.x402SettlementTx) &&
          sameAddress(decoded.args.provider, PROVIDER) &&
          decoded.args.amountUSDC === proof.x402AmountUSDC &&
          sameAddress(decoded.args.facilitator, OPERATOR),
      );
    });
    return matched ? { ok: true, detail: proof.floatBindTx } : { ok: false, detail: "missing matching X402PaymentBound" };
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

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

function hashEnv(name, fallback) {
  const value = clean(env[name]) || fallback;
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${name} must be a bytes32 tx/action hash`);
  return value;
}

function bigintEnv(name, fallback) {
  const value = clean(env[name]);
  return value ? BigInt(value) : fallback;
}

function toBig(value) {
  if (value === undefined || value === null || value === "") return 0n;
  return BigInt(value);
}

function sameAddress(a, b) {
  return getAddress(a) === getAddress(b);
}

function sameHash(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function fmt(value) {
  return formatUnits(value ?? 0n, 6);
}

function short(value) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

function sanitize(error) {
  return error?.shortMessage || error?.message || String(error);
}
