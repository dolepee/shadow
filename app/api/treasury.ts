import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";

export const config = { maxDuration: 20 };

const CHAIN_ID = 5_042_002;
const DEFAULT_RPC = "https://rpc.testnet.arc.network";
const DEFAULT_API = "https://shadow-arc.vercel.app/api/float";
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const DEFAULT_FLOAT = "0xF305647bA0ff7f1E2d4bE5f37F2EF9f930531057";
const DEFAULT_ATTESTOR = "0x440ef290d63174182c6115b4356727e0ac136d48";
const DEFAULT_ENFORCER = "0x05a11588155c6bde55bb7b3986f200ca556b23cc";
const DEFAULT_MORPHO_ADAPTER = "0x805db94a0b94c0d937063291ddaafb41690f5dee";
const DEFAULT_MORPHO_SINK = "0x0e157aeaffbebe59becb7b93007015a06c5dec90";
const DEFAULT_OPERATOR = "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8";
const DEFAULT_PROVIDER = "0x8ddf06fE8985988d3e0883F945E891BD57084937";

const DEFAULT_PROOF = {
  createMandateTx: "0x99c2c1efa8f81c1dbca63ea1c2bec18c8b223e03caa62e7d9f7eb1bd8d140cc2",
  allowedAllocationTx: "0x32c63c43b30f9567800275be2c39538fee5c0ec60d29456c8a66b4c0ae2e8b73",
  blockedAllocationTx: "0x92222fda0b93b12e3b834bafd737730ba907ec36fe85c5ddbd5a997364ba179f",
  x402SettlementTx: "0x53c88f43303136ba06534f76e99dc6479157d14ad701a600e5da91fd4d9aa5c5",
  floatBindTx: "0x79921c6f2bac709c42a7db5c654f2d0f55fe9aa83255158fe52877d38cafce6d",
  allowedActionHash: "0xb4b62260d18e902b7821049c4997a797e558f1a6d7884cfd230da2834f25813b",
  blockedActionHash: "0x20c95660fb24342944c59b114001484006dcb6a1adee5de609fa1f74b8db9d86",
  floatRequestHash: "0x7bd6fe10fcc7e230abf04cd3874684824fa783e89d97801abb3dad0cba2dce45",
  allowedAmountUSDC: 100_000n,
  blockedAmountUSDC: 300_000n,
  x402AmountUSDC: 1_000n,
  feeUSDC: 10n,
};

type VercelLikeRequest = {
  method?: string;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

type Check = {
  check: string;
  status: "PASS" | "FAIL";
  ok: boolean;
  detail: string;
};

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

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  try {
    const result = await runTreasuryChecks();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      checkedAt: new Date().toISOString(),
      mode: "shadow-treasury-live-verifier",
      error: sanitize(error),
    });
  }
}

async function runTreasuryChecks() {
  const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || DEFAULT_RPC;
  const apiUrl = clean(process.env.TREASURY_VERIFY_FLOAT_API_URL || process.env.FLOAT_API_URL) || DEFAULT_API;
  const USDC = getAddress(clean(process.env.ARC_USDC || process.env.VITE_ARC_USDC) || DEFAULT_USDC);
  const FLOAT = getAddress(clean(process.env.SHADOW_FLOAT || process.env.VITE_SHADOW_FLOAT) || DEFAULT_FLOAT);
  const ATTESTOR = getAddress(clean(process.env.LEPTON_ATTESTOR || process.env.VITE_SHADOW_MANDATE_ATTESTOR) || DEFAULT_ATTESTOR);
  const ENFORCER = getAddress(clean(process.env.LEPTON_ENFORCER || process.env.VITE_SHADOW_BONDED_ENFORCER) || DEFAULT_ENFORCER);
  const MORPHO_ADAPTER = getAddress(clean(process.env.LEPTON_MORPHO_ADAPTER || process.env.VITE_SHADOW_MORPHO_STYLE_ADAPTER) || DEFAULT_MORPHO_ADAPTER);
  const MORPHO_SINK = getAddress(clean(process.env.LEPTON_MORPHO_VAULT_SINK || process.env.VITE_SHADOW_MORPHO_VAULT_SINK) || DEFAULT_MORPHO_SINK);
  const OPERATOR = getAddress(clean(process.env.TREASURY_OPERATOR_ADDRESS) || DEFAULT_OPERATOR);
  const PROVIDER = getAddress(clean(process.env.TREASURY_OPERATOR_PROVIDER) || DEFAULT_PROVIDER);
  const proof = {
    createMandateTx: hashValue("TREASURY_VERIFY_CREATE_MANDATE_TX", DEFAULT_PROOF.createMandateTx),
    allowedAllocationTx: hashValue("TREASURY_VERIFY_ALLOWED_TX", DEFAULT_PROOF.allowedAllocationTx),
    blockedAllocationTx: hashValue("TREASURY_VERIFY_BLOCKED_TX", DEFAULT_PROOF.blockedAllocationTx),
    x402SettlementTx: hashValue("TREASURY_VERIFY_X402_SETTLEMENT_TX", DEFAULT_PROOF.x402SettlementTx),
    floatBindTx: hashValue("TREASURY_VERIFY_FLOAT_BIND_TX", DEFAULT_PROOF.floatBindTx),
    allowedActionHash: hashValue("TREASURY_VERIFY_ALLOWED_ACTION_HASH", DEFAULT_PROOF.allowedActionHash),
    blockedActionHash: hashValue("TREASURY_VERIFY_BLOCKED_ACTION_HASH", DEFAULT_PROOF.blockedActionHash),
    floatRequestHash: hashValue("TREASURY_VERIFY_FLOAT_REQUEST_HASH", DEFAULT_PROOF.floatRequestHash),
    allowedAmountUSDC: bigintValue("TREASURY_VERIFY_ALLOWED_AMOUNT_ATOMIC", DEFAULT_PROOF.allowedAmountUSDC),
    blockedAmountUSDC: bigintValue("TREASURY_VERIFY_BLOCKED_AMOUNT_ATOMIC", DEFAULT_PROOF.blockedAmountUSDC),
    x402AmountUSDC: bigintValue("TREASURY_VERIFY_X402_AMOUNT_ATOMIC", DEFAULT_PROOF.x402AmountUSDC),
    feeUSDC: bigintValue("TREASURY_VERIFY_FEE_ATOMIC", DEFAULT_PROOF.feeUSDC),
  };
  const checks: Check[] = [];
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }) });

  const check = (name: string, ok: boolean, detail = "") => {
    checks.push({ check: name, status: ok ? "PASS" : "FAIL", ok, detail: String(detail) });
  };

  const [floatState, createTx, allowedTx, blockedTx, x402Tx, bindTx] = await Promise.all([
    fetchJson(apiUrl),
    txReceipt(publicClient, proof.createMandateTx),
    txReceipt(publicClient, proof.allowedAllocationTx),
    txReceipt(publicClient, proof.blockedAllocationTx),
    txReceipt(publicClient, proof.x402SettlementTx),
    txReceipt(publicClient, proof.floatBindTx),
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
  check("allowed action hash anchored", allowedReceipt !== zeroHash(), String(allowedReceipt));
  check("blocked action hash anchored", blockedReceipt !== zeroHash(), String(blockedReceipt));
  check("Float request hash anchored", floatReceiptHash !== zeroHash(), String(floatReceiptHash));

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

  const allowedTransfer = await verifyTransfer(publicClient, proof.allowedAllocationTx, {
    expected: { from: OPERATOR, to: MORPHO_SINK, amount: proof.allowedAmountUSDC },
    usdc: USDC,
  });
  check("allowed allocation moved Arc USDC into vault sink", allowedTransfer.ok, allowedTransfer.detail);

  const blockedTransfer = await verifyNoTransfer(publicClient, proof.blockedAllocationTx, {
    from: OPERATOR,
    to: MORPHO_SINK,
    usdc: USDC,
  });
  check("blocked allocation moved no vault USDC", blockedTransfer.ok, blockedTransfer.detail);

  const settlementTransfer = await verifyTransfer(publicClient, proof.x402SettlementTx, {
    expected: { from: OPERATOR, to: PROVIDER, amount: proof.x402AmountUSDC },
    usdc: USDC,
    txTo: USDC,
  });
  check("x402 settlement transferred Arc USDC operator -> provider", settlementTransfer.ok, settlementTransfer.detail);

  const bindEvent = await verifyX402Bound(publicClient, proof, {
    float: FLOAT,
    provider: PROVIDER,
    facilitator: OPERATOR,
  });
  check("Float bind emitted matching X402PaymentBound", bindEvent.ok, bindEvent.detail);

  const apiReceipts = Array.isArray(floatState?.receipts) ? floatState.receipts : [];
  const requestReceipts = apiReceipts.filter((receipt: any) => sameHash(receipt.requestHash, proof.floatRequestHash));
  const apiTypes = new Set(requestReceipts.map((receipt: any) => receipt.receiptType));
  check("Float API indexes this Treasury request", requestReceipts.length >= 4, `${requestReceipts.length} receipts`);
  check(
    "Float API shows spend/provider/fee/debt lifecycle",
    ["SPEND_ALLOWED", "PROVIDER_PAID", "FEE_ACCRUED", "DEBT_OPENED"].every((type) => apiTypes.has(type)),
    [...apiTypes].join(", "),
  );

  const debtReceipt = requestReceipts.find((receipt: any) => receipt.receiptType === "DEBT_OPENED");
  if (debtReceipt) {
    const providerAmount = toBig(debtReceipt.providerAmountUSDC || debtReceipt.amountUSDC);
    const fee = toBig(debtReceipt.feeUSDC) || proof.feeUSDC;
    const debtOpened = toBig(debtReceipt.debtOpenedUSDC || debtReceipt.debtDeltaUSDC);
    check("Float debt equals x402 amount plus fee", debtOpened === providerAmount + fee, `${fmt(providerAmount)} + ${fmt(fee)} = ${fmt(debtOpened)}`);
  } else {
    check("Float debt equals x402 amount plus fee", false, "missing DEBT_OPENED receipt");
  }

  check(
    "Float API proof checks remain green",
    Boolean(floatState?.proofChecks?.hasX402BoundSpend && floatState?.proofChecks?.feeMechanicsVisible),
    JSON.stringify(floatState?.proofChecks || {}),
  );

  return {
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
}

async function txReceipt(publicClient: any, txHash: `0x${string}`) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    return receipt.status === "success"
      ? { ok: true, detail: `block ${receipt.blockNumber}` }
      : { ok: false, detail: `status ${receipt.status}` };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function verifyTransfer(
  publicClient: any,
  txHash: `0x${string}`,
  {
    expected,
    usdc,
    txTo,
  }: {
    expected: { from: Address; to: Address; amount: bigint };
    usdc: Address;
    txTo?: Address;
  },
) {
  try {
    const [tx, receipt] = await Promise.all([
      publicClient.getTransaction({ hash: txHash }),
      publicClient.getTransactionReceipt({ hash: txHash }),
    ]);
    if (receipt.status !== "success") return { ok: false, detail: "tx failed" };
    if (txTo && (!tx.to || !sameAddress(tx.to, txTo))) {
      return { ok: false, detail: `settlement tx.to ${tx.to || "null"} is not Arc USDC` };
    }
    const matched = receipt.logs.some((log: any) => {
      if (!sameAddress(log.address, usdc)) return false;
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

async function verifyNoTransfer(
  publicClient: any,
  txHash: `0x${string}`,
  expected: { from: Address; to: Address; usdc: Address },
) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, detail: "tx failed" };
    const leaked = receipt.logs.some((log: any) => {
      if (!sameAddress(log.address, expected.usdc)) return false;
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

async function verifyX402Bound(
  publicClient: any,
  proof: {
    floatBindTx: `0x${string}`;
    floatRequestHash: `0x${string}`;
    x402SettlementTx: `0x${string}`;
    x402AmountUSDC: bigint;
  },
  refs: { float: Address; provider: Address; facilitator: Address },
) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: proof.floatBindTx });
    if (receipt.status !== "success") return { ok: false, detail: "bind tx failed" };
    const matched = receipt.logs.some((log: any) => {
      if (!sameAddress(log.address, refs.float)) return false;
      const decoded = decodeLog(x402PaymentBoundEvent, log);
      return Boolean(
        decoded &&
          sameHash(decoded.args.requestHash, proof.floatRequestHash) &&
          sameHash(decoded.args.x402Hash, proof.x402SettlementTx) &&
          sameAddress(decoded.args.provider, refs.provider) &&
          decoded.args.amountUSDC === proof.x402AmountUSDC &&
          sameAddress(decoded.args.facilitator, refs.facilitator),
      );
    });
    return matched ? { ok: true, detail: proof.floatBindTx } : { ok: false, detail: "missing matching X402PaymentBound" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function decodeLog(event: any, log: any) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics }) as any;
  } catch {
    return null;
  }
}

function hashValue(name: string, fallback: string) {
  const value = clean(process.env[name]) || fallback;
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${name} must be a bytes32 tx/action hash`);
  return value as `0x${string}`;
}

function bigintValue(name: string, fallback: bigint) {
  const value = clean(process.env[name]);
  return value ? BigInt(value) : fallback;
}

function toBig(value: unknown) {
  if (value === undefined || value === null || value === "") return 0n;
  return BigInt(String(value));
}

function sameAddress(a: string, b: string) {
  return getAddress(a) === getAddress(b);
}

function sameHash(a: unknown, b: unknown) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function fmt(value: bigint) {
  return formatUnits(value ?? 0n, 6);
}

function short(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function clean(value: string | undefined) {
  return value?.replace(/\\n/g, "").trim();
}

function sanitize(error: any) {
  return error?.shortMessage || error?.message || String(error);
}
