import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToBytes,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = {
  ...readEnv(new URL("../../.env", import.meta.url)),
  ...readEnv(new URL("../../.vercel/.env.production.local", import.meta.url)),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const DEFAULT_RPC = "https://rpc.testnet.arc.network";
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const DEFAULT_FLOAT = "0xF305647bA0ff7f1E2d4bE5f37F2EF9f930531057";
const DEFAULT_REGISTRY = "0x394b6955162ce147e813e0eea6104cd1164e3d33";
const DEFAULT_ATTESTOR = "0x440ef290d63174182c6115b4356727e0ac136d48";
const DEFAULT_ENFORCER = "0x05a11588155c6bde55bb7b3986f200ca556b23cc";
const DEFAULT_MORPHO_ADAPTER = "0x805db94a0b94c0d937063291ddaafb41690f5dee";
const DEFAULT_MORPHO_SINK = "0x0e157aeaffbebe59becb7b93007015a06c5dec90";
const DEFAULT_PROVIDER_URL = "https://shadow-arc.vercel.app/api/reasoning-x402";

const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || DEFAULT_RPC;
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || DEFAULT_USDC);
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || DEFAULT_FLOAT);
const REGISTRY = getAddress(clean(env.LEPTON_REGISTRY || env.VITE_SHADOW_MANDATE_REGISTRY) || DEFAULT_REGISTRY);
const ATTESTOR = getAddress(clean(env.LEPTON_ATTESTOR || env.VITE_SHADOW_MANDATE_ATTESTOR) || DEFAULT_ATTESTOR);
const ENFORCER = getAddress(clean(env.LEPTON_ENFORCER || env.VITE_SHADOW_BONDED_ENFORCER) || DEFAULT_ENFORCER);
const MORPHO_ADAPTER = getAddress(clean(env.LEPTON_MORPHO_ADAPTER || env.VITE_SHADOW_MORPHO_STYLE_ADAPTER) || DEFAULT_MORPHO_ADAPTER);
const MORPHO_SINK = getAddress(clean(env.LEPTON_MORPHO_VAULT_SINK || env.VITE_SHADOW_MORPHO_VAULT_SINK) || DEFAULT_MORPHO_SINK);
const OPERATOR_KEY = normalizeKey(
  clean(env.TREASURY_OPERATOR_PRIVATE_KEY || env.FLOAT_FACILITATOR_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY || env.PRIVATE_KEY),
);
const PROVIDER_URL = clean(env.TREASURY_OPERATOR_X402_PROVIDER_URL || env.FLOAT_X402_PROVIDER_URL) || DEFAULT_PROVIDER_URL;
const endpointLabel = clean(env.FLOAT_X402_ENDPOINT_LABEL) || PROVIDER_URL;
const endpointHash = keccak256(stringToBytes(endpointLabel));

const EXECUTE = clean(env.TREASURY_OPERATOR_EXECUTE) === "1";
const RESUME_M1 = clean(env.TREASURY_OPERATOR_RESUME_M1) === "1";
const AUTO_BOND = clean(env.TREASURY_OPERATOR_AUTO_BOND) === "1";
const now = Math.floor(Date.now() / 1000);
const salt = `${now}-${Math.random().toString(16).slice(2)}`;
const minBond = BigInt(clean(env.TREASURY_OPERATOR_MIN_BOND_USDC) || "10000000");
const allowAmount = BigInt(clean(env.TREASURY_OPERATOR_ALLOW_USDC) || "100000");
const blockAmount = BigInt(clean(env.TREASURY_OPERATOR_BLOCK_USDC) || "300000");
const dailyCap = BigInt(clean(env.TREASURY_OPERATOR_DAILY_CAP_USDC) || "1000000");
const maxRisk = Number(clean(env.TREASURY_OPERATOR_MAX_RISK) || "3");
const minBpsOut = Number(clean(env.TREASURY_OPERATOR_MIN_BPS_OUT) || "9900");
const FLOAT_ALPHA = getAddress(clean(env.FLOAT_ALPHA_ADDRESS) || "0xa100000000000000000000000000000000000001");

if (!OPERATOR_KEY) throw new Error("missing TREASURY_OPERATOR_PRIVATE_KEY, FLOAT_FACILITATOR_PRIVATE_KEY, CAT_AGENT_PRIVATE_KEY, or PRIVATE_KEY");

const operator = privateKeyToAccount(OPERATOR_KEY);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const wallet = createWalletClient({ account: operator, chain, transport: http(RPC, { timeout: 60_000, retryCount: 1 }) });

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const mandateCheckedEvent = parseAbiItem(
  "event MandateChecked(bytes32 indexed receiptHash, uint256 indexed mandateId, address indexed enforcer, bytes32 actionHash, bool allowed, uint8 reason)",
);
const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);

const registryAbi = parseAbi([
  "function nextMandateId() view returns (uint256)",
  "function createMandate(address circleAccount,address requiredSettlementAsset,address allowedTarget,uint8 actionType,uint256 maxAmountPerIntent,uint256 dailyCap,uint8 maxRiskLevel,uint16 minBpsOut,bytes32 labelHash) returns (uint256)",
  "function hashAction((uint256 mandateId,address actor,address circleAccount,address settlementAsset,address target,uint8 actionType,uint256 amountUSDC,uint8 riskLevel,uint16 minBpsOut,uint256 expiry,bytes32 intentHash,bytes32 executionRef) action) view returns (bytes32)",
]);
const attestorAbi = parseAbi([
  "function receiptCount() view returns (uint256)",
  "function receiptByActionHash(bytes32 actionHash) view returns (bytes32)",
  "function getReceiptDecision(bytes32 receiptHash) view returns (uint256 mandateId,uint256 amountUSDC,uint8 decision,uint8 reason,bytes32 executionRef)",
  "function getReceiptParties(bytes32 receiptHash) view returns (address actor,address circleAccount,address enforcer,address settlementAsset,address target)",
]);
const enforcerAbi = parseAbi(["function minBondUSDC() view returns (uint256)", "function bondUSDC(address enforcer) view returns (uint256)"]);
const morphoAbi = parseAbi([
  "function adapterBondUSDC() view returns (uint256)",
  "function depositedUSDC() view returns (uint256)",
  "function blockedUSDC() view returns (uint256)",
  "function depositWithMandate((uint256 mandateId,address actor,address circleAccount,address settlementAsset,address target,uint8 actionType,uint256 amountUSDC,uint8 riskLevel,uint16 minBpsOut,uint256 expiry,bytes32 intentHash,bytes32 executionRef) action) returns (bytes32 receiptHash,bool allowed,uint8 reason)",
  "function morphoMarketExecutionRef(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,bytes32 salt) view returns (bytes32)",
  "function postBond(uint256 amountUSDC)",
]);
const sinkAbi = parseAbi(["function totalDepositedUSDC() view returns (uint256)", "function depositsByAccountUSDC(address account) view returns (uint256)"]);
const floatAbi = parseAbi([
  "function previewSpend(address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 requestHash) view returns (bool allowed,uint8 reason)",
  "function recordX402Spend(address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 requestHash,bytes32 x402Hash,address facilitator) returns (bytes32 receiptHash,bool allowed,uint8 reason)",
  "function receiptCount() view returns (uint256)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function totalFeesAccruedUSDC() view returns (uint256)",
  "function totalProviderPaidUSDC() view returns (uint256)",
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
]);

await main();

async function main() {
  const requirement = await fetchX402Requirement(PROVIDER_URL);
  const provider = getAddress(requirement.payTo);
  const x402Amount = BigInt(clean(env.TREASURY_OPERATOR_X402_AMOUNT_ATOMIC || env.FLOAT_X402_SPEND_ATOMIC) || requirement.maxAmountRequired);
  if (requirement.asset && getAddress(requirement.asset) !== USDC) {
    throw new Error(`x402 provider asset mismatch: expected ${USDC}, got ${requirement.asset}`);
  }
  if (x402Amount <= 0n) throw new Error("x402 amount must be positive");

  let before = await snapshot(provider);
  printHeader(before, provider, x402Amount);
  const bondTopUp = before.adapterBond < minBond ? minBond - before.adapterBond : 0n;
  const requiredForMandate = allowAmount + bondTopUp;
  if (before.operatorUsdc < requiredForMandate + x402Amount) {
    throw new Error(`operator needs at least ${fmt(requiredForMandate + x402Amount)} USDC; has ${fmt(before.operatorUsdc)}`);
  }
  if (before.nativeBalance === 0n) throw new Error("operator has no native gas balance");
  if (before.adapterBond < minBond) {
    if (!EXECUTE || !AUTO_BOND) {
      throw new Error(`Morpho adapter bond ${fmt(before.adapterBond)} is below required ${fmt(minBond)}; set TREASURY_OPERATOR_AUTO_BOND=1 to post bond during the spike`);
    }
    await approveIfNeeded(USDC, MORPHO_ADAPTER, bondTopUp);
    await send("post Morpho adapter bond", MORPHO_ADAPTER, morphoAbi, "postBond", [bondTopUp]);
    before = await snapshot(provider);
    if (before.adapterBond < minBond) {
      throw new Error(`Morpho adapter bond ${fmt(before.adapterBond)} is still below required ${fmt(minBond)}`);
    }
  }
  if (before.alphaLine.availableCreditUSDC < x402Amount) {
    throw new Error(`Float alpha available ${fmt(before.alphaLine.availableCreditUSDC)} is below x402 amount ${fmt(x402Amount)}`);
  }

  const nextMandateId = before.nextMandateId;
  const expiry = BigInt(now + 86_400);
  const allowExecutionRef = await readMorphoExecutionRef("allow");
  const blockExecutionRef = await readMorphoExecutionRef("block");
  const mandateLabel = hash(`shadow-treasury-operator-mandate-${salt}`);

  const allowedAction = {
    mandateId: nextMandateId,
    actor: operator.address,
    circleAccount: operator.address,
    settlementAsset: USDC,
    target: MORPHO_ADAPTER,
    actionType: 2,
    amountUSDC: allowAmount,
    riskLevel: Math.min(2, maxRisk),
    minBpsOut: minBpsOut + 50 > 10_000 ? minBpsOut : minBpsOut + 50,
    expiry,
    intentHash: hash(`shadow-treasury-operator-allow-${salt}`),
    executionRef: allowExecutionRef,
  };
  const blockedAction = {
    ...allowedAction,
    amountUSDC: blockAmount,
    intentHash: hash(`shadow-treasury-operator-block-${salt}`),
    executionRef: blockExecutionRef,
  };

  const actionHashes = await Promise.all([
    publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "hashAction", args: [allowedAction] }),
    publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "hashAction", args: [blockedAction] }),
  ]);
  if (RESUME_M1) {
    actionHashes[0] = requiredHash("TREASURY_OPERATOR_ALLOWED_ACTION_HASH");
    actionHashes[1] = requiredHash("TREASURY_OPERATOR_BLOCKED_ACTION_HASH");
  }
  console.log(`planned mandate #${nextMandateId}`);
  console.log(`allowed actionHash ${actionHashes[0]}`);
  console.log(`blocked actionHash ${actionHashes[1]}`);

  if (!EXECUTE) {
    console.log("\npreflight PASS");
    console.log("Set TREASURY_OPERATOR_EXECUTE=1 to run the live 48-hour gate transactions.");
    return;
  }

  const txs = {};
  if (RESUME_M1) {
    txs.createMandate = requiredHash("TREASURY_OPERATOR_CREATE_MANDATE_TX");
    txs.allowedAllocation = requiredHash("TREASURY_OPERATOR_ALLOWED_TX");
    txs.blockedAllocation = requiredHash("TREASURY_OPERATOR_BLOCKED_TX");
    console.log("\nresume M1 receipts");
    console.log(`  create ${txs.createMandate}`);
    console.log(`  allow  ${txs.allowedAllocation}`);
    console.log(`  block  ${txs.blockedAllocation}`);
  } else {
    await approveIfNeeded(USDC, MORPHO_ADAPTER, allowAmount);
    txs.createMandate = await send("create treasury deposit mandate", REGISTRY, registryAbi, "createMandate", [
      operator.address,
      USDC,
      MORPHO_ADAPTER,
      2,
      allowAmount,
      dailyCap,
      maxRisk,
      minBpsOut,
      mandateLabel,
    ]);
    txs.allowedAllocation = await send("allowed vault-style allocation", MORPHO_ADAPTER, morphoAbi, "depositWithMandate", [allowedAction]);
    txs.blockedAllocation = await send("blocked over-limit allocation", MORPHO_ADAPTER, morphoAbi, "depositWithMandate", [blockedAction]);
  }

  const requestHash = hash(`shadow-treasury-operator-float-x402-${salt}`);
  const [allowed, reason] = await publicClient.readContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "previewSpend",
    args: [FLOAT_ALPHA, provider, endpointHash, x402Amount, requestHash],
  });
  if (!allowed) throw new Error(`Float x402 preview blocked with reason ${reason}`);
  const x402 = await payProviderX402(PROVIDER_URL, provider, x402Amount);
  const x402Hash = x402.txHash;
  txs.x402Settlement = x402Hash;
  txs.x402SettlementMode = x402.mode;
  txs.floatBind = await send("bind Float x402 draw", FLOAT, floatAbi, "recordX402Spend", [
    FLOAT_ALPHA,
    provider,
    endpointHash,
    x402Amount,
    requestHash,
    x402Hash,
    operator.address,
  ]);

  const after = await snapshot(provider);
  const proof = await verifySpike({ before, after, provider, x402Amount, requestHash, actionHashes, txs, resumedM1: RESUME_M1 });
  console.log("\ncombined treasury operator proof");
  console.log(JSON.stringify(proof, null, 2));
  const proofOut = clean(env.TREASURY_OPERATOR_PROOF_OUT);
  if (proofOut) {
    writeFileSync(proofOut, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(`proof written to ${proofOut}`);
  }
  if (!proof.ok) process.exit(1);
}

async function snapshot(provider) {
  const [
    operatorUsdc,
    nativeBalance,
    allowance,
    nextMandateId,
    attestorReceiptCount,
    adapterBond,
    enforcerBond,
    morphoDeposited,
    morphoBlocked,
    sinkDeposited,
    sinkDepositsByOperator,
    floatReceiptCount,
    floatFees,
    floatProviderPaid,
    alphaLineRaw,
  ] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [operator.address] }),
    publicClient.getBalance({ address: operator.address }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [operator.address, MORPHO_ADAPTER] }),
    publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "nextMandateId" }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "receiptCount" }),
    publicClient.readContract({ address: MORPHO_ADAPTER, abi: morphoAbi, functionName: "adapterBondUSDC" }),
    publicClient.readContract({ address: ENFORCER, abi: enforcerAbi, functionName: "bondUSDC", args: [MORPHO_ADAPTER] }),
    publicClient.readContract({ address: MORPHO_ADAPTER, abi: morphoAbi, functionName: "depositedUSDC" }),
    publicClient.readContract({ address: MORPHO_ADAPTER, abi: morphoAbi, functionName: "blockedUSDC" }),
    publicClient.readContract({ address: MORPHO_SINK, abi: sinkAbi, functionName: "totalDepositedUSDC" }),
    publicClient.readContract({ address: MORPHO_SINK, abi: sinkAbi, functionName: "depositsByAccountUSDC", args: [operator.address] }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "receiptCount" }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "totalFeesAccruedUSDC" }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "totalProviderPaidUSDC" }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lines", args: [FLOAT_ALPHA] }),
  ]);
  return {
    operatorUsdc,
    nativeBalance,
    allowance,
    nextMandateId,
    attestorReceiptCount,
    adapterBond,
    enforcerBond,
    morphoDeposited,
    morphoBlocked,
    sinkDeposited,
    sinkDepositsByOperator,
    floatReceiptCount,
    floatFees,
    floatProviderPaid,
    alphaLine: lineSummary(alphaLineRaw),
    provider,
  };
}

async function verifySpike({ before, after, provider, x402Amount, requestHash, actionHashes, txs, resumedM1 }) {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ check: name, status: ok ? "PASS" : "FAIL", ok, detail: String(detail) });

  if (resumedM1) {
    const [createOk, allowOk, blockOk] = await Promise.all([
      assertTxSuccess(txs.createMandate),
      assertTxSuccess(txs.allowedAllocation),
      assertTxSuccess(txs.blockedAllocation),
    ]);
    check("M1 create mandate tx succeeded", createOk.ok, createOk.detail);
    check("M1 allowed allocation tx succeeded", allowOk.ok, allowOk.detail);
    check("M1 blocked allocation tx succeeded", blockOk.ok, blockOk.detail);
  } else {
    check("M1 attestor wrote two receipts", after.attestorReceiptCount >= before.attestorReceiptCount + 2n, `${before.attestorReceiptCount} -> ${after.attestorReceiptCount}`);
    check("vault adapter moved allowed USDC", after.morphoDeposited >= before.morphoDeposited + allowAmount, `${fmt(before.morphoDeposited)} -> ${fmt(after.morphoDeposited)}`);
    check("vault sink recorded allowed deposit", after.sinkDeposited >= before.sinkDeposited + allowAmount, `${fmt(before.sinkDeposited)} -> ${fmt(after.sinkDeposited)}`);
    check("blocked allocation changed only blocked notional", after.morphoBlocked >= before.morphoBlocked + blockAmount, `${fmt(before.morphoBlocked)} -> ${fmt(after.morphoBlocked)}`);
    check("blocked allocation did not move vault funds", after.sinkDeposited === before.sinkDeposited + allowAmount, `${fmt(before.sinkDeposited)} -> ${fmt(after.sinkDeposited)}`);
  }
  check("operator USDC moved only allowed allocation plus x402", before.operatorUsdc >= after.operatorUsdc, `${fmt(before.operatorUsdc)} -> ${fmt(after.operatorUsdc)}`);
  check("Float wrote one x402 receipt", after.floatReceiptCount >= before.floatReceiptCount + 1n, `${before.floatReceiptCount} -> ${after.floatReceiptCount}`);
  check("Float provider paid increased", after.floatProviderPaid >= before.floatProviderPaid + x402Amount, `${fmt(before.floatProviderPaid)} -> ${fmt(after.floatProviderPaid)}`);
  check("Float fee accrued", after.floatFees > before.floatFees, `${fmt(before.floatFees)} -> ${fmt(after.floatFees)}`);

  const [allowedReceipt, blockedReceipt, floatReceiptHash] = await Promise.all([
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "receiptByActionHash", args: [actionHashes[0]] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "receiptByActionHash", args: [actionHashes[1]] }),
    publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "receiptByRequestHash", args: [requestHash] }),
  ]);
  check("allowed action hash anchored", allowedReceipt !== zeroHash(), allowedReceipt);
  check("blocked action hash anchored", blockedReceipt !== zeroHash(), blockedReceipt);
  check("Float request hash anchored", floatReceiptHash !== zeroHash(), floatReceiptHash);

  const [allowDecision, blockDecision, allowParties, blockParties] = await Promise.all([
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptDecision", args: [allowedReceipt] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptDecision", args: [blockedReceipt] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptParties", args: [allowedReceipt] }),
    publicClient.readContract({ address: ATTESTOR, abi: attestorAbi, functionName: "getReceiptParties", args: [blockedReceipt] }),
  ]);
  check("allowed receipt is ALLOW/NONE", Number(allowDecision[2]) === 0 && Number(allowDecision[3]) === 0, `decision=${allowDecision[2]} reason=${allowDecision[3]}`);
  check("blocked receipt is BLOCK/AMOUNT_TOO_HIGH", Number(blockDecision[2]) === 1 && Number(blockDecision[3]) === 3, `decision=${blockDecision[2]} reason=${blockDecision[3]}`);
  check("allowed receipt targets Morpho-style adapter", getAddress(allowParties[4]) === MORPHO_ADAPTER, allowParties[4]);
  check("blocked receipt targets Morpho-style adapter", getAddress(blockParties[4]) === MORPHO_ADAPTER, blockParties[4]);

  const settlementOk = await assertSettlementTransfer(txs.x402Settlement, { from: operator.address, to: provider, amount: x402Amount });
  check("x402 settlement transferred USDC operator -> provider", settlementOk.ok, settlementOk.detail);
  const bindOk = await assertX402Bound(txs.floatBind, { requestHash, x402Hash: txs.x402Settlement, provider, amount: x402Amount });
  check("Float bind emitted matching X402PaymentBound", bindOk.ok, bindOk.detail);

  return {
    ok: checks.every((entry) => entry.ok),
    mode: "shadow-treasury-operator-spike",
    resumedM1,
    chainId: CHAIN_ID,
    operator: operator.address,
    provider,
    contracts: {
      float: FLOAT,
      mandateRegistry: REGISTRY,
      mandateAttestor: ATTESTOR,
      bondedEnforcer: ENFORCER,
      morphoStyleVaultAdapter: MORPHO_ADAPTER,
      morphoStyleVaultSink: MORPHO_SINK,
    },
    txs,
    requestHash,
    actionHashes: {
      allowed: actionHashes[0],
      blocked: actionHashes[1],
    },
    amounts: {
      vaultAllowedUSDC: fmt(allowAmount),
      vaultBlockedUSDC: fmt(blockAmount),
      x402PaidUSDC: fmt(x402Amount),
      floatFeeDeltaUSDC: fmt(after.floatFees - before.floatFees),
    },
    amountsAtomic: {
      vaultAllowedUSDC: allowAmount.toString(),
      vaultBlockedUSDC: blockAmount.toString(),
      x402PaidUSDC: x402Amount.toString(),
      floatFeeDeltaUSDC: (after.floatFees - before.floatFees).toString(),
    },
    checks,
  };
}

async function approveIfNeeded(token, spender, amount) {
  const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [operator.address, spender] });
  if (allowance >= amount) {
    console.log(`allowance ok ${fmt(allowance)} USDC`);
    return null;
  }
  return send("approve Morpho-style adapter", token, erc20Abi, "approve", [spender, amount]);
}

async function payProviderX402(url, payTo, amount) {
  console.log("\npay x402 provider");
  const timestamp = Math.floor(Date.now() / 1000);
  const message = {
    from: operator.address,
    to: payTo,
    value: amount,
    validAfter: BigInt(timestamp - 60),
    validBefore: BigInt(timestamp + 600),
    nonce: generatePrivateKey(),
  };
  const signature = await operator.signTypedData({
    domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
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
      from: operator.address,
      to: payTo,
      value: amount.toString(),
      validAfter: message.validAfter.toString(),
      validBefore: message.validBefore.toString(),
      nonce: message.nonce,
      signature,
    },
  };
  const response = await fetchWithRetry(url, {
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
  return { txHash: settled.txHash, mode: "provider-http" };
}

async function fetchX402Requirement(url) {
  const response = await fetchWithRetry(url);
  const body = await response.json().catch(() => ({}));
  if (response.status !== 402) throw new Error(`expected HTTP 402 from provider, got ${response.status}`);
  const requirement = body.accepts?.[0];
  if (!requirement?.payTo || !isAddress(requirement.payTo)) throw new Error("x402 provider did not return a valid payTo");
  if (!requirement.maxAmountRequired) throw new Error("x402 provider did not return maxAmountRequired");
  return requirement;
}

async function fetchWithRetry(url, init = {}, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await sleep(750 * (i + 1));
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readMorphoExecutionRef(label) {
  return publicClient.readContract({
    address: MORPHO_ADAPTER,
    abi: morphoAbi,
    functionName: "morphoMarketExecutionRef",
    args: [USDC, zeroAddress(), zeroAddress(), zeroAddress(), 0n, hash(`shadow-treasury-${label}-${salt}`)],
  });
}

async function send(label, address, abi, functionName, args) {
  console.log(`\n${label}`);
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: operator, chain });
  console.log(`  tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  block ${receipt.blockNumber} status=${receipt.status}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return hash;
}

async function assertSettlementTransfer(txHash, expected) {
  try {
    const [tx, receipt] = await Promise.all([
      publicClient.getTransaction({ hash: txHash }),
      publicClient.getTransactionReceipt({ hash: txHash }),
    ]);
    if (receipt.status !== "success") return { ok: false, detail: "settlement tx failed" };
    if (!tx.to || getAddress(tx.to) !== USDC) return { ok: false, detail: `settlement tx.to ${tx.to || "null"} is not USDC` };
    const matched = receipt.logs.some((log) => {
      if (getAddress(log.address) !== USDC) return false;
      const decoded = decodeLog(transferEvent, log);
      return Boolean(
        decoded &&
          getAddress(decoded.args.from) === getAddress(expected.from) &&
          getAddress(decoded.args.to) === getAddress(expected.to) &&
          decoded.args.value === expected.amount,
      );
    });
    return matched ? { ok: true, detail: `${fmt(expected.amount)} ${short(expected.from)} -> ${short(expected.to)}` } : { ok: false, detail: "missing matching Transfer" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function assertTxSuccess(txHash) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    return receipt.status === "success"
      ? { ok: true, detail: `block ${receipt.blockNumber}` }
      : { ok: false, detail: `status ${receipt.status}` };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

async function assertX402Bound(txHash, expected) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, detail: "bind tx failed" };
    const matched = receipt.logs.some((log) => {
      if (getAddress(log.address) !== FLOAT) return false;
      const decoded = decodeLog(x402PaymentBoundEvent, log);
      return Boolean(
        decoded &&
          decoded.args.requestHash?.toLowerCase() === expected.requestHash.toLowerCase() &&
          decoded.args.x402Hash?.toLowerCase() === expected.x402Hash.toLowerCase() &&
          getAddress(decoded.args.provider) === getAddress(expected.provider) &&
          decoded.args.amountUSDC === expected.amount &&
          getAddress(decoded.args.facilitator) === operator.address,
      );
    });
    return matched ? { ok: true, detail: txHash } : { ok: false, detail: "missing X402PaymentBound" };
  } catch (error) {
    return { ok: false, detail: sanitize(error) };
  }
}

function printHeader(state, provider, x402Amount) {
  console.log("Shadow Treasury operator spike");
  console.log(`mode       ${EXECUTE ? "LIVE" : "PREFLIGHT"}`);
  console.log(`operator   ${operator.address}`);
  console.log(`float      ${FLOAT}`);
  console.log(`registry   ${REGISTRY}`);
  console.log(`attestor   ${ATTESTOR}`);
  console.log(`enforcer   ${ENFORCER}`);
  console.log(`adapter    ${MORPHO_ADAPTER}`);
  console.log(`vault      ${MORPHO_SINK}`);
  console.log(`provider   ${provider}`);
  console.log(`x402       ${fmt(x402Amount)} USDC`);
  console.log(`vault allow ${fmt(allowAmount)} USDC`);
  console.log(`vault block ${fmt(blockAmount)} USDC`);
  console.log(`operator   ${fmt(state.operatorUsdc)} USDC, ${formatEther(state.nativeBalance)} native`);
  console.log(`adapter bond ${fmt(state.adapterBond)} USDC`);
  console.log(`Float alpha available ${fmt(state.alphaLine.availableCreditUSDC)} USDC`);
}

function lineSummary(line) {
  return {
    wallet: line[0],
    score: Number(line[1]),
    creditLimitUSDC: line[2],
    availableCreditUSDC: line[3],
    activeDebtUSDC: line[4],
    status: Number(line[5]),
  };
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

function hash(value) {
  return keccak256(stringToBytes(value));
}

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function requiredHash(name) {
  const value = clean(env[name]);
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`missing or invalid ${name}`);
  return value;
}

function zeroAddress() {
  return "0x0000000000000000000000000000000000000000";
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

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}

function sanitize(error) {
  return error?.shortMessage || error?.message || String(error);
}
