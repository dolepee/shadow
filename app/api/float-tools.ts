import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
} from "viem";
import { FLOAT_V2_CONTRACT, FLOAT_V2_DEPLOY_BLOCK } from "../floatV2Config.js";

export const config = { maxDuration: 25 };

const ARC_CHAIN_ID = 5_042_002;
const ZERO = "0x0000000000000000000000000000000000000000";
const LEGACY_FLOAT_V1 = "0xF305647bA0ff7f1E2d4bE5f37F2EF9f930531057";
const DEFAULT_ALPHA = "0xa100000000000000000000000000000000000001";
const DEFAULT_BETA = "0xbe7a000000000000000000000000000000000002";
const DEFAULT_SELF_TEST_AGENTS = [
  "0x0C63826eE08aF1f144ec5D84B6c56fe393fE19F5",
  "0xD3eed2f7dcED5fbc96Fb1a0FC058C540D50b4f80",
  "0xa539a18b55e5e3b98892c724f8f75914c0b69942",
] as const;
const LOG_LOOKBACK = BigInt(process.env.FLOAT_LOG_LOOKBACK || "250000");
const LOG_CHUNK_SIZE = BigInt(process.env.FLOAT_LOG_CHUNK_SIZE || "9000");
const SCORE_EVIDENCE_CACHE_MS = Number(process.env.FLOAT_SCORE_EVIDENCE_CACHE_MS || "15000");
const STATUSES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];
const RECEIPT_TYPES = [
  "UNKNOWN",
  "FLOAT_GRANTED",
  "SPEND_ALLOWED",
  "SPEND_BLOCKED",
  "PROVIDER_PAID",
  "DEBT_OPENED",
  "REPAID",
  "LIMIT_REDUCED",
  "LIMIT_REVOKED",
  "CREDIT_DENIED",
  "FEE_ACCRUED",
  "DEFAULTED",
];
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
  "MISSING_REQUEST_HASH",
  "NO_DEBT",
  "REPAY_TOO_HIGH",
  "DEFAULTED",
];

const floatAbi = parseAbi([
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function behaviorStats(address agent) view returns (uint16 paidBound,uint16 signedExternalPaid,uint16 repaid,uint16 blocked,uint16 denied,uint16 errorCount)",
  "function autonomousLineScore(address agent) view returns (uint16 score,uint256 recommendedLimitUSDC,uint256 cappedLimitUSDC)",
  "function receiptCount() view returns (uint256)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function providerDeliveryByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function intentNonceUsed(address agent, uint256 nonce) view returns (bool)",
]);
const floatReceiptEvent = parseAbiItem(
  "event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)",
);
const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);
const floatIntentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const ERC1271_MAGIC_VALUE = "0x1626ba7e";

type Req = { method?: string; url?: string; query?: Record<string, string | string[] | undefined> };
type Res = { setHeader(n: string, v: string | number): void; status(c: number): Res; json(b: unknown): void };

type FloatToolsClient = {
  readContract: (args: any) => Promise<unknown>;
  getBlockNumber: () => Promise<bigint>;
  getLogs: (args: any) => Promise<Array<{ address: Address; data: `0x${string}`; topics: readonly `0x${string}`[]; transactionHash: `0x${string}`; blockNumber: bigint }>>;
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{
    status: "success" | "reverted";
    logs: Array<{ address: Address; data: `0x${string}`; topics: readonly `0x${string}`[] }>;
  }>;
};

type FloatReceiptEventArgs = {
  receiptId: bigint;
  receiptHash: `0x${string}`;
  receiptType: number;
  agent: Address;
  provider: Address;
  endpointHash: `0x${string}`;
  amountUSDC: bigint;
  creditBeforeUSDC: bigint;
  creditAfterUSDC: bigint;
  debtBeforeUSDC: bigint;
  debtAfterUSDC: bigint;
  reason: number;
  mandateId: `0x${string}`;
  requestHash: `0x${string}`;
  prevChecksum: `0x${string}`;
  checksum: `0x${string}`;
};

type IndexedFloatReceipt = {
  receiptId: string;
  receiptHash: `0x${string}`;
  receiptType: string;
  agent: Address;
  provider: Address;
  amountUSDC: string;
  reason: string;
  requestHash: `0x${string}`;
  debtBeforeUSDC: string;
  debtAfterUSDC: string;
  transactionHash: `0x${string}`;
  blockNumber: string;
  hasX402Bind: boolean;
};

type ReceiptEvidence = {
  receipts: IndexedFloatReceipt[];
  warnings: string[];
  fromBlock: bigint;
  toBlock: bigint;
  cached: boolean;
};

let receiptEvidenceCache:
  | {
      address: string;
      fromBlock: bigint;
      toBlock: bigint;
      cachedAt: number;
      receipts: IndexedFloatReceipt[];
      warnings: string[];
    }
  | null = null;

type X402PaymentBoundArgs = {
  requestHash: `0x${string}`;
  x402Hash: `0x${string}`;
  provider: Address;
  amountUSDC: bigint;
};
type TransferArgs = { from: Address; to: Address; value: bigint };

type DecodedX402PaymentBoundLog = { args: X402PaymentBoundArgs };
type DecodedTransferLog = { args: TransferArgs };
type FloatIntentConsumedArgs = {
  agent: Address;
  signer: Address;
  nonce: bigint;
  requestHash: `0x${string}`;
};
type DecodedFloatIntentConsumedLog = { args: FloatIntentConsumedArgs };

type LoopRun = {
  source?: string;
  float?: string;
  agent?: string;
  requestHash?: string;
  rationalePreimage?: string;
  rationale?: string;
  action?: string;
  outcome?: string;
  model?: string;
  at?: string;
  amountUSDC?: string;
  txHash?: string;
  signature?: string;
  intent?: SignedIntent;
  x402Hash?: string;
  bindTxHash?: string;
};

type SignedIntent = {
  agent: string;
  provider: string;
  endpointHash: string;
  amountUSDC: string;
  maxDebtUSDC?: string;
  nonce: string;
  expiry: string;
  executor?: string;
  reason: string;
  float: string;
  chainId: number;
};

const intentTypes = {
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
} as const;
const legacyIntentTypes = {
  FloatSpendIntent: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "reason", type: "string" },
  ],
} as const;
const legacyExecutorIntentTypes = {
  FloatSpendIntent: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "reason", type: "string" },
  ],
} as const;

export default async function handler(req: Req, res: Res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  const action = readParam(req, "action");
  if (action === "agent") return handleAgent(req, res);
  if (action === "rationale") return handleRationale(req, res);
  if (action === "verify") return handleVerify(req, res);
  if (action === "score") return handleScore(req, res);
  if (action === "intent") return handleIntent(req, res);

  res.status(400).json({
    error: "pass ?action=agent|rationale|verify|score|intent",
    examples: [
      "/api/float-tools?action=agent&address=0x...",
      "/api/float-tools?action=rationale&hash=0x...",
      "/api/float-tools?action=verify&hash=0x...",
      "/api/float-tools?action=score&address=0x...",
      "/api/float-tools?action=intent&agent=0x...&reason=one%20true%20sentence",
    ],
  });
}

async function handleAgent(req: Req, res: Res) {
  const address = readParam(req, "address");
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: "pass ?action=agent&address=0x... (the agent address whose Float standing you want)" });
    return;
  }

  const float = currentFloatAddress();
  const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";

  try {
    const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) });
    const line = await client.readContract({
      address: float,
      abi: floatAbi,
      functionName: "lines",
      args: [getAddress(address)],
    });
    const wallet = line[0] as string;
    const known = Boolean(wallet) && wallet.toLowerCase() !== ZERO;
    res.status(200).json({
      configured: true,
      testnet: true,
      network: "arc-testnet",
      float,
      agent: getAddress(address),
      label: labelFor(address),
      known,
      standing: known
        ? {
            wallet,
            score: Number(line[1]),
            creditLimitUSDC: (line[2] as bigint).toString(),
            availableCreditUSDC: (line[3] as bigint).toString(),
            activeDebtUSDC: (line[4] as bigint).toString(),
            status: STATUSES[Number(line[5])] || `STATUS_${line[5]}`,
            lastReview: Number(line[6]),
          }
        : null,
      note: known
        ? "Standing is sponsor-backed and contract-scored on V2: paid, blocked, and repaid behavior refresh the line within the sponsor reserve cap."
        : "No Float line for this address yet. Behavior earns a line; it is not self-claimed.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ configured: true, degraded: true, error: sanitize(error) });
  }
}

async function handleRationale(req: Req, res: Res) {
  const hash = readHash(req);
  if (!hash) {
    res.status(400).json({ error: "pass ?action=rationale&hash=0x... (the requestHash from a Float receipt)" });
    return;
  }

  const float = currentFloatAddress();
  const runs = filterRunsForFloat(await readLoopRuns(), float);
  const match = runs.find((r) => (r.requestHash || "").toLowerCase() === hash.toLowerCase());
  if (!match || !match.rationalePreimage) {
    res.status(200).json({
      found: false,
      requestHash: hash,
      note: "No published rationale preimage for this requestHash on the current Float deployment. Admin/demo actions and receipts predating re-hashable rationale will not have one.",
      fetchedAt: Date.now(),
    });
    return;
  }

  const recomputedHash = keccak256(stringToBytes(match.rationalePreimage));
  res.status(200).json({
    found: true,
    requestHash: hash,
    rationalePreimage: match.rationalePreimage,
    recomputedHash,
    matches: recomputedHash.toLowerCase() === hash.toLowerCase(),
    decision: {
      action: match.action,
      outcome: match.outcome,
      rationale: match.rationale,
      model: match.model,
      at: match.at,
    },
    note: "requestHash = keccak256(rationalePreimage). Re-hash the preimage to verify the on-chain commitment to the agent's reasoning.",
    fetchedAt: Date.now(),
  });
}

async function handleVerify(req: Req, res: Res) {
  const hash = readHash(req);
  if (!hash) {
    res.status(400).json({ error: "pass ?action=verify&hash=0x... (the requestHash from a signed external Float receipt)" });
    return;
  }

  const float = currentFloatAddress();
  const runs = filterRunsForFloat(await readLoopRuns(), float);
  const match = runs.find((r) => r.intent && r.signature && (r.requestHash || "").toLowerCase() === hash.toLowerCase());
  if (!match || !match.intent || !match.signature) {
    res.status(200).json({
      found: false,
      requestHash: hash,
      note: "No signed external intent for this requestHash on the current Float deployment. Lab-loop and requestSpend receipts are not signed-intent spends.",
      fetchedAt: Date.now(),
    });
    return;
  }

  const intent = match.intent;
  const domain = {
    name: "ShadowFloat",
    version: "1",
    chainId: intent.chainId || ARC_CHAIN_ID,
    verifyingContract: getAddress(intent.float),
  };
  const hasMaxDebt = Boolean(intent.maxDebtUSDC && /^\d+$/.test(intent.maxDebtUSDC));
  const hasV2Executor = Boolean(intent.executor && isAddress(intent.executor));
  const baseMessage = {
    agent: getAddress(intent.agent),
    provider: getAddress(intent.provider),
    endpointHash: intent.endpointHash as `0x${string}`,
    amountUSDC: BigInt(intent.amountUSDC),
    nonce: BigInt(intent.nonce),
    expiry: BigInt(intent.expiry),
  };
  const message = hasMaxDebt
    ? {
        ...baseMessage,
        maxDebtUSDC: BigInt(intent.maxDebtUSDC!),
        executor: hasV2Executor ? getAddress(intent.executor!) : ZERO,
        reason: intent.reason,
      }
    : hasV2Executor
      ? { ...baseMessage, executor: getAddress(intent.executor!), reason: intent.reason }
      : { ...baseMessage, reason: intent.reason };
  const typesForDigest = hasMaxDebt ? intentTypes : hasV2Executor ? legacyExecutorIntentTypes : legacyIntentTypes;
  const proofVersion = hasMaxDebt ? "v2-max-debt" : hasV2Executor ? "legacy-v2-executor" : "legacy-v1";

  try {
    const digest = hashTypedData({ domain, types: typesForDigest, primaryType: "FloatSpendIntent", message });
    const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
    const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) }) as unknown as FloatToolsClient;
    const signature = match.signature as `0x${string}`;
    let recovered = ZERO;
    let eoaSignerMatchesAgent = false;
    try {
      recovered = await recoverTypedDataAddress({
        domain,
        types: typesForDigest,
        primaryType: "FloatSpendIntent",
        message,
        signature,
      });
      eoaSignerMatchesAgent = getAddress(recovered) === getAddress(intent.agent);
    } catch {
      recovered = ZERO;
    }
    const erc1271SignerMatchesAgent = eoaSignerMatchesAgent
      ? false
      : await verifyErc1271Signature(client, getAddress(intent.agent), digest, signature);
    const signerMatchesAgent = eoaSignerMatchesAgent || erc1271SignerMatchesAgent;
    const verifiedSigner = erc1271SignerMatchesAgent ? getAddress(intent.agent) : recovered;
    const signatureMode = erc1271SignerMatchesAgent ? "erc1271" : "eoa";
    const digestMatchesRequestHash = digest.toLowerCase() === hash.toLowerCase();
    const onchain = await verifyOnchainExternalProof(client, {
      float,
      requestHash: hash,
      bindTxHash: match.bindTxHash,
      txHash: match.txHash,
      x402Hash: match.x402Hash,
      agent: getAddress(intent.agent),
      nonce: BigInt(intent.nonce),
      provider: getAddress(intent.provider),
      amountUSDC: BigInt(intent.amountUSDC),
      usdc: getAddress(clean(process.env.ARC_USDC || process.env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000"),
      requireContractEnforcedIntent: hasMaxDebt || hasV2Executor,
    });
    if (!signerMatchesAgent || !digestMatchesRequestHash || !onchain.ok) {
      res.status(200).json({
        found: false,
        metadataFound: true,
        requestHash: hash,
        recoveredSigner: verifiedSigner,
        signatureMode,
        agent: getAddress(intent.agent),
        signerMatchesAgent,
        digestMatchesRequestHash,
        onchainVerified: false,
        onchain,
        note: "A signed metadata record exists, but the current Float deployment did not verify the full on-chain bind proof.",
        fetchedAt: Date.now(),
      });
      return;
    }
    res.status(200).json({
      found: true,
      requestHash: hash,
      recoveredSigner: verifiedSigner,
      signatureMode,
      agent: getAddress(intent.agent),
      signerMatchesAgent,
      digestMatchesRequestHash,
      onchainVerified: true,
      contractEnforcedIntent: Boolean(onchain.contractEnforcedIntent),
      proofVersion,
      intentNonceUsed: onchain.intentNonceUsed ?? null,
      receiptHash: onchain.receiptHash,
      providerDeliveryConfirmed: Boolean(onchain.providerDeliveryConfirmed),
      providerDeliveryHash: onchain.providerDeliveryHash ?? null,
      intent,
      signature: match.signature,
      x402Hash: match.x402Hash,
      bindTxHash: match.bindTxHash,
      txHash: match.txHash,
      settlementMode: onchain.settlementMode,
      note: onchain.contractEnforcedIntent
        ? onchain.settlementMode === "direct-provider-transfer"
          ? onchain.providerDeliveryConfirmed
            ? "V2 direct proof: hashTypedData(intent) equals requestHash, the signature recovers to the agent, receiptByRequestHash is nonzero, the spend tx emitted FloatIntentConsumed, the contract nonce is marked used, Arc USDC moved directly from ShadowFloat to the signed provider, and the provider signed a delivery receipt for the same request."
            : "V2 direct proof: hashTypedData(intent) equals requestHash, the signature recovers to the agent, receiptByRequestHash is nonzero, the spend tx emitted FloatIntentConsumed, the contract nonce is marked used, and Arc USDC moved directly from ShadowFloat to the signed provider."
          : "V2 x402 proof: hashTypedData(intent) equals requestHash, the signature recovers to the agent, receiptByRequestHash is nonzero, the bind tx emitted matching FloatIntentConsumed and X402PaymentBound events, and the contract nonce is marked used."
        : "V1 proof: hashTypedData(intent) equals requestHash, the signature recovers to the agent, receiptByRequestHash is nonzero, and bindTxHash emits the matching X402PaymentBound event. V1 signature verification happened before bind; V2 additionally proves contract-side nonce consumption.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.status(200).json({ found: true, requestHash: hash, error: String((error as Error)?.message || error).slice(0, 200) });
  }
}

async function verifyOnchainExternalProof(
  client: FloatToolsClient,
  expected: {
    float: `0x${string}`;
    requestHash: `0x${string}`;
    bindTxHash?: string;
    txHash?: string;
    x402Hash?: string;
    agent: string;
    nonce: bigint;
    provider: string;
    amountUSDC: bigint;
    usdc: string;
    requireContractEnforcedIntent?: boolean;
  },
) {
  try {
    const receiptHash = (await client.readContract({
      address: expected.float,
      abi: floatAbi,
      functionName: "receiptByRequestHash",
      args: [expected.requestHash],
    })) as `0x${string}`;
    if (!receiptHash || receiptHash === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      return { ok: false, reason: "receiptByRequestHash is empty" };
    }
    const proofTxHash = expected.bindTxHash || expected.txHash;
    if (!proofTxHash || !/^0x[0-9a-fA-F]{64}$/.test(proofTxHash)) {
      return { ok: false, receiptHash, reason: "missing valid proof transaction hash" };
    }
    const proofReceipt = await client.getTransactionReceipt({ hash: proofTxHash as `0x${string}` });
    if (proofReceipt.status !== "success") return { ok: false, receiptHash, reason: "proof transaction failed" };
    let intentNonceUsed: boolean | null = null;
    let providerDeliveryHash: `0x${string}` | null = null;
    try {
      intentNonceUsed = (await client.readContract({
        address: expected.float,
        abi: floatAbi,
        functionName: "intentNonceUsed",
        args: [expected.agent, expected.nonce],
      })) as boolean;
    } catch {
      intentNonceUsed = null;
    }
    try {
      providerDeliveryHash = (await client.readContract({
        address: expected.float,
        abi: floatAbi,
        functionName: "providerDeliveryByRequestHash",
        args: [expected.requestHash],
      })) as `0x${string}`;
    } catch {
      providerDeliveryHash = null;
    }
    const providerDeliveryConfirmed =
      Boolean(providerDeliveryHash) &&
      providerDeliveryHash !== "0x0000000000000000000000000000000000000000000000000000000000000000";
    const intentConsumed = proofReceipt.logs.some((log) => {
      if (getAddress(log.address) !== expected.float) return false;
      const decoded = decodeFloatIntentConsumedLog(log);
      return Boolean(
        decoded &&
          getAddress(decoded.args.agent) === getAddress(expected.agent) &&
          decoded.args.nonce === expected.nonce &&
          decoded.args.requestHash?.toLowerCase() === expected.requestHash.toLowerCase(),
      );
    });
    let matched = false;
    let settlementMode = "direct-provider-transfer";
    if (expected.x402Hash && /^0x[0-9a-fA-F]{64}$/.test(expected.x402Hash)) {
      settlementMode = "operator-assisted-x402";
      matched = proofReceipt.logs.some((log) => {
        if (getAddress(log.address) !== expected.float) return false;
        const decoded = decodeX402PaymentBoundLog(log);
        return Boolean(
          decoded &&
            decoded.args.requestHash?.toLowerCase() === expected.requestHash.toLowerCase() &&
            decoded.args.x402Hash?.toLowerCase() === expected.x402Hash!.toLowerCase() &&
            getAddress(decoded.args.provider) === getAddress(expected.provider) &&
            decoded.args.amountUSDC === expected.amountUSDC,
        );
      });
    } else {
      matched = proofReceipt.logs.some((log) => {
        if (getAddress(log.address) !== getAddress(expected.usdc)) return false;
        const decoded = decodeTransferLog(log);
        return Boolean(
          decoded &&
            getAddress(decoded.args.from) === expected.float &&
            getAddress(decoded.args.to) === getAddress(expected.provider) &&
            decoded.args.value === expected.amountUSDC,
        );
      });
    }
    const contractEnforcedIntent = intentNonceUsed === true && intentConsumed;
    if (expected.requireContractEnforcedIntent && !contractEnforcedIntent) {
      return {
        ok: false,
        receiptHash,
        proofTxHash,
        intentNonceUsed,
        intentConsumed,
        contractEnforcedIntent,
        reason: "V2 proof missing FloatIntentConsumed or nonce-used confirmation",
      };
    }
    return matched
      ? {
          ok: true,
          receiptHash,
          proofTxHash,
          bindTxHash: expected.bindTxHash,
          txHash: expected.txHash,
          settlementMode,
          intentNonceUsed,
          intentConsumed,
          contractEnforcedIntent,
          providerDeliveryConfirmed,
          providerDeliveryHash,
        }
      : {
          ok: false,
          receiptHash,
          settlementMode,
          reason:
            settlementMode === "operator-assisted-x402"
              ? "bind transaction missing matching X402PaymentBound event"
              : "proof transaction missing direct Arc USDC transfer from ShadowFloat to signed provider",
        };
  } catch (error) {
    return { ok: false, reason: sanitize(error) };
  }
}

async function verifyErc1271Signature(
  client: FloatToolsClient,
  signer: `0x${string}`,
  digest: `0x${string}`,
  signature: `0x${string}`,
) {
  try {
    const magicValue = (await client.readContract({
      address: signer,
      abi: erc1271Abi,
      functionName: "isValidSignature",
      args: [digest, signature],
    })) as string;
    return magicValue.toLowerCase() === ERC1271_MAGIC_VALUE;
  } catch {
    return false;
  }
}

function decodeX402PaymentBoundLog(log: { data: `0x${string}`; topics: readonly `0x${string}`[] }): DecodedX402PaymentBoundLog | null {
  try {
    return decodeEventLog({
      abi: [x402PaymentBoundEvent] as any,
      data: log.data,
      topics: log.topics as any,
    }) as unknown as DecodedX402PaymentBoundLog;
  } catch {
    return null;
  }
}

function decodeFloatIntentConsumedLog(log: { data: `0x${string}`; topics: readonly `0x${string}`[] }): DecodedFloatIntentConsumedLog | null {
  try {
    return decodeEventLog({
      abi: [floatIntentConsumedEvent] as any,
      data: log.data,
      topics: log.topics as any,
    }) as unknown as DecodedFloatIntentConsumedLog;
  } catch {
    return null;
  }
}

function decodeTransferLog(log: { data: `0x${string}`; topics: readonly `0x${string}`[] }): DecodedTransferLog | null {
  try {
    return decodeEventLog({
      abi: [transferEvent] as any,
      data: log.data,
      topics: log.topics as any,
    }) as unknown as DecodedTransferLog;
  } catch {
    return null;
  }
}

function decodeFloatReceiptLog(log: { data: `0x${string}`; topics: readonly `0x${string}`[] }): { args: FloatReceiptEventArgs } | null {
  try {
    return decodeEventLog({
      abi: [floatReceiptEvent] as any,
      data: log.data,
      topics: log.topics as any,
    }) as unknown as { args: FloatReceiptEventArgs };
  } catch {
    return null;
  }
}

async function handleScore(req: Req, res: Res) {
  const address = readParam(req, "address");
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: "pass ?action=score&address=0x... (the agent address whose deterministic Float score you want)" });
    return;
  }

  const float = currentFloatAddress();
  const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
  const agent = getAddress(address);

  try {
    const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) }) as unknown as FloatToolsClient;
    const [line, stats, autonomousScore, receiptCount, latestBlock] = await Promise.all([
      client.readContract({
        address: float,
        abi: floatAbi,
        functionName: "lines",
        args: [agent],
      }),
      client.readContract({
        address: float,
        abi: floatAbi,
        functionName: "behaviorStats",
        args: [agent],
      }),
      client.readContract({
        address: float,
        abi: floatAbi,
        functionName: "autonomousLineScore",
        args: [agent],
      }),
      client.readContract({ address: float, abi: floatAbi, functionName: "receiptCount" }),
      client.getBlockNumber(),
    ]);
    const startBlock = BigInt(clean(process.env.SHADOW_FLOAT_START_BLOCK || process.env.VITE_SHADOW_FLOAT_START_BLOCK) || FLOAT_V2_DEPLOY_BLOCK.toString());
    const fromBlock = startBlock > 0n ? startBlock : latestBlock > LOG_LOOKBACK ? latestBlock - LOG_LOOKBACK : 0n;
    const receiptEvidence = await readReceiptEvidence(client, float, fromBlock, latestBlock);
    const runs = filterRunsForFloat(await readLoopRuns(), float);
    const label = labelFor(agent);
    const evidence = scoreEvidenceFromReceipts(agent, receiptEvidence.receipts, runs);
    const score = deterministicScore(label, evidence);
    const recommendedLimitUSDC = recommendedLimitForScore(score);
    const currentLine = serializeLine(line as readonly unknown[]);
    const contractStats = serializeBehaviorStats(stats as readonly unknown[]);
    const contractScore = serializeAutonomousScore(autonomousScore as readonly unknown[]);

    res.status(200).json({
      configured: true,
      testnet: true,
      network: "arc-testnet",
      float,
      agent,
      label,
      formulaVersion: "shadow-float-score-v0",
      evidenceMode: "receipt-derived",
      authoritativeContractScore: {
        score: contractScore.score,
        recommendedLimitUSDC: contractScore.recommendedLimitUSDC,
        recommendedLimitFormatted: formatAtomicUSDC(contractScore.recommendedLimitUSDC),
        cappedLimitUSDC: contractScore.cappedLimitUSDC,
        cappedLimitFormatted: formatAtomicUSDC(contractScore.cappedLimitUSDC),
        behaviorStats: contractStats,
        source: "ShadowFloat.autonomousLineScore(agent) and ShadowFloat.behaviorStats(agent)",
      },
      formula: {
        base: {
          lab: 8500,
          invited: 7500,
          selfTest: 6500,
          demo: 5000,
        },
        adjustments: {
          paidBound: "+150 each, max 5",
          signedExternalPaidBound: "+350 each, max 3",
          repaid: "+400 each, max 3",
          blocked: "-250 each, max 5",
          denied: "-900 each, max 3",
          error: "-300 each, max 3",
        },
        lineBandsAtomicUSDC: [
          { scoreGte: 9000, limit: "1000000" },
          { scoreGte: 8000, limit: "50000" },
          { scoreGte: 7500, limit: "25000" },
          { scoreGte: 0, limit: "0" },
        ],
      },
      evidence,
      evidenceCompleteness: {
        fromBlock: receiptEvidence.fromBlock.toString(),
        toBlock: receiptEvidence.toBlock.toString(),
        cache: receiptEvidence.cached ? "hit" : "miss",
        receiptLogsIndexed: receiptEvidence.receipts.length,
        onchainReceiptCount: (receiptCount as bigint).toString(),
        indexedReceiptCountMatchesChain: BigInt(receiptEvidence.receipts.length) === (receiptCount as bigint),
        logFetchComplete: receiptEvidence.warnings.length === 0,
        warnings: receiptEvidence.warnings,
      },
      evidenceSources: {
        lineLabel: "operator-configured label set for lab, invited, self-test, and demo addresses",
        paidBound:
          "FloatReceipt logs with SPEND_ALLOWED, PROVIDER_PAID, and DEBT_OPENED for the same requestHash. X402PaymentBound is the legacy/operator-assisted settlement subtype; V2 direct sponsored spends are counted from contract-paid provider receipts.",
        signedExternalPaidBound:
          "published signed-intent metadata, but counted only when the same requestHash is present in receipt-derived paid-bound evidence",
        repaid: "FloatReceipt logs with REPAID for this agent",
        blocked: "FloatReceipt logs with SPEND_BLOCKED for this agent",
        denied: "FloatReceipt logs with CREDIT_DENIED for this agent",
        error: "offchain execution errors are not scored from receipts in v0; chain-derived value is zero",
        currentLine: "ShadowFloat.lines(address) on Arc testnet",
      },
      computed: {
        score,
        recommendedLimitUSDC,
        recommendedLimitFormatted: formatAtomicUSDC(recommendedLimitUSDC),
        note: "Offchain receipt-derived mirror used for diagnostics. The authoritative V2 value is autonomousLineScore from the contract.",
      },
      currentLine,
      supportCheck: {
        currentScore: currentLine.score,
        currentCreditLimitUSDC: currentLine.creditLimitUSDC,
        scoreSupportedByContract: currentLine.score <= contractScore.score,
        limitSupportedByContract: BigInt(currentLine.creditLimitUSDC) <= BigInt(contractScore.cappedLimitUSDC),
        currentLineSupportedByContract:
          currentLine.score <= contractScore.score && BigInt(currentLine.creditLimitUSDC) <= BigInt(contractScore.cappedLimitUSDC),
      },
      trustAssumption:
        "Deterministic v0 formula over receipt-derived evidence. Sponsored V2 lines are refreshed by the contract from recorded paid, blocked, and repaid behavior, while legacy non-sponsored lines remain outside this permissionless sponsor path.",
      note:
        "This v0 verifier derives behavior counts from FloatReceipt logs, then mirrors the V2 scoring bands. signedExternalPaidBound still requires published builder signature metadata because signatures are not stored onchain.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ configured: true, degraded: true, error: sanitize(error) });
  }
}

async function handleIntent(req: Req, res: Res) {
  res.setHeader("Cache-Control", "no-store");
  const agentParam = readParam(req, "agent") || readParam(req, "address");
  const reason = clean(readParam(req, "reason"));
  if (!agentParam || !isAddress(agentParam)) {
    res.status(400).json({ error: "pass ?action=intent&agent=0x... (the agent address that will sign)" });
    return;
  }
  if (!reason) {
    res.status(400).json({ error: "pass a truthful reason=... sentence that the agent will sign" });
    return;
  }

  const float = currentFloatAddress();

  const providerRaw = clean(readParam(req, "provider")) || clean(process.env.FLOAT_PROVIDER || process.env.VITE_FLOAT_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937";
  const endpointHash = clean(readParam(req, "endpointHash")) || clean(process.env.FLOAT_ENDPOINT_HASH || process.env.VITE_FLOAT_ENDPOINT_HASH) || "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160";
  const amountUSDC = clean(readParam(req, "amountUSDC")) || "10000";
  const maxDebtRaw = clean(readParam(req, "maxDebtUSDC"));
  const nonce = clean(readParam(req, "nonce")) || Date.now().toString();
  const ttlSeconds = BigInt(clean(readParam(req, "ttl")) || `${7 * 24 * 3600}`);
  const expiry = clean(readParam(req, "expiry")) || (BigInt(Math.floor(Date.now() / 1000)) + ttlSeconds).toString();
  const executorRaw = clean(readParam(req, "executor")) || clean(process.env.FLOAT_INTENT_EXECUTOR || process.env.VITE_FLOAT_INTENT_EXECUTOR) || ZERO;

  if (!providerRaw || !isAddress(providerRaw)) {
    res.status(400).json({ error: "provider must be a valid address" });
    return;
  }
  if (!isAddress(executorRaw)) {
    res.status(400).json({ error: "executor must be a valid address or omitted for open execution" });
    return;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(endpointHash)) {
    res.status(400).json({ error: "endpointHash must be bytes32" });
    return;
  }
  if (!/^\d+$/.test(amountUSDC) || BigInt(amountUSDC) <= 0n) {
    res.status(400).json({ error: "amountUSDC must be a positive integer in 6-decimal atomic units" });
    return;
  }
  const agent = getAddress(agentParam);
  let activeDebtUSDC = 0n;
  let activeDebtRead = false;
  if (!maxDebtRaw) {
    const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
    try {
      const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) }) as unknown as FloatToolsClient;
      const line = (await client.readContract({ address: float, abi: floatAbi, functionName: "lines", args: [agent] })) as readonly unknown[];
      activeDebtUSDC = BigInt(line[4] as bigint);
      activeDebtRead = true;
    } catch {
      activeDebtUSDC = 0n;
    }
  }
  const maxDebtUSDC = maxDebtRaw || (activeDebtUSDC + (BigInt(amountUSDC) * 110n) / 100n).toString();
  if (!/^\d+$/.test(maxDebtUSDC) || BigInt(maxDebtUSDC) < BigInt(amountUSDC)) {
    res.status(400).json({ error: "maxDebtUSDC must be an integer >= amountUSDC" });
    return;
  }
  if (!/^\d+$/.test(nonce) || !/^\d+$/.test(expiry)) {
    res.status(400).json({ error: "nonce and expiry must be integer strings" });
    return;
  }

  const provider = getAddress(providerRaw);
  const executor = getAddress(executorRaw);
  const domain = { name: "ShadowFloat", version: "1", chainId: ARC_CHAIN_ID, verifyingContract: float };
  const message = {
    agent,
    provider,
    endpointHash: endpointHash as `0x${string}`,
    amountUSDC: BigInt(amountUSDC),
    maxDebtUSDC: BigInt(maxDebtUSDC),
    nonce: BigInt(nonce),
    expiry: BigInt(expiry),
    executor,
    reason,
  };
  const digest = hashTypedData({ domain, types: intentTypes, primaryType: "FloatSpendIntent", message });

  res.status(200).json({
    configured: true,
    testnet: true,
    network: "arc-testnet",
    purpose:
      "Sign this EIP-712 typed data with your own agent signer. Do not share a private key. Return { intent, signature, digest }.",
    typedData: {
      domain,
      types: intentTypes,
      primaryType: "FloatSpendIntent",
      message: {
        ...message,
        amountUSDC: amountUSDC,
        maxDebtUSDC,
        nonce,
        expiry,
        executor,
      },
    },
    intent: {
      agent,
      provider,
      endpointHash,
      amountUSDC,
      maxDebtUSDC,
      nonce,
      expiry,
      executor,
      reason,
      float,
      chainId: ARC_CHAIN_ID,
    },
    digest,
    requestHash: digest,
    signingNotes: [
      "The digest is the requestHash Shadow will bind onchain.",
      "A signature authorizes only this provider, endpoint hash, amount, maximum debt, nonce, expiry, executor, and reason.",
      "If executor is nonzero, only that address can consume the signed intent; if it is zero, any caller can submit it once.",
      "No transaction, approval, or USDC movement is required from the builder to sign typed data.",
      "On V2, the Float contract verifies this signature, consumes the nonce, and emits FloatIntentConsumed before direct provider payment from sponsor reserve.",
    ],
    debtContext: {
      activeDebtUSDC: activeDebtUSDC.toString(),
      activeDebtIncludedInDefaultMaxDebt: !maxDebtRaw && activeDebtRead,
      maxDebtSource: maxDebtRaw ? "caller-provided" : activeDebtRead ? "active-debt-plus-amount-headroom" : "amount-headroom-fallback",
    },
    verifyBeforeBinding:
      "A V2 direct spend is enforced entirely by the contract: signer, nonce, expiry, provider, endpoint, executor, amount, max debt, sponsor reserve, and line policy are checked before provider payment.",
    fetchedAt: Date.now(),
  });
}

async function readLoopRuns(): Promise<LoopRun[]> {
  const url = clean(process.env.KV_REST_API_URL);
  const token = clean(process.env.KV_REST_API_TOKEN);
  if (!url || !token) return [];
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/get/${encodeURIComponent("float:loop:runs")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const json = (await response.json()) as { result?: string | null };
    if (!json.result) return [];
    const parsed = JSON.parse(json.result) as unknown;
    return Array.isArray(parsed) ? (parsed as LoopRun[]).filter((r) => r && typeof r === "object") : [];
  } catch {
    return [];
  }
}

async function readReceiptEvidence(client: FloatToolsClient, address: Address, fromBlock: bigint, toBlock: bigint): Promise<ReceiptEvidence> {
  const cacheKey = address.toLowerCase();
  if (
    receiptEvidenceCache &&
    receiptEvidenceCache.address === cacheKey &&
    receiptEvidenceCache.fromBlock === fromBlock &&
    Date.now() - receiptEvidenceCache.cachedAt <= SCORE_EVIDENCE_CACHE_MS
  ) {
    return {
      receipts: receiptEvidenceCache.receipts,
      warnings: receiptEvidenceCache.warnings,
      fromBlock: receiptEvidenceCache.fromBlock,
      toBlock: receiptEvidenceCache.toBlock,
      cached: true,
    };
  }

  const receiptLogs: IndexedFloatReceipt[] = [];
  const x402ByRequest = new Set<string>();
  const warnings: string[] = [];
  if (toBlock < fromBlock) return { receipts: receiptLogs, warnings, fromBlock, toBlock, cached: false };

  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = start + LOG_CHUNK_SIZE - 1n > toBlock ? toBlock : start + LOG_CHUNK_SIZE - 1n;
    try {
      const rawLogs = await client.getLogs({ address, fromBlock: start, toBlock: end });
      const decodedReceipts: Array<{ args: FloatReceiptEventArgs; transactionHash: `0x${string}`; blockNumber: bigint }> = [];
      for (const log of rawLogs) {
        const receipt = decodeFloatReceiptLog(log);
        if (receipt) {
          decodedReceipts.push({ args: receipt.args, transactionHash: log.transactionHash, blockNumber: log.blockNumber });
          continue;
        }
        const x402 = decodeX402PaymentBoundLog(log);
        if (x402?.args.requestHash) x402ByRequest.add(x402.args.requestHash.toLowerCase());
      }
      for (const log of decodedReceipts) {
        receiptLogs.push({
          receiptId: log.args.receiptId.toString(),
          receiptHash: log.args.receiptHash,
          receiptType: RECEIPT_TYPES[Number(log.args.receiptType)] || `TYPE_${log.args.receiptType}`,
          agent: log.args.agent,
          provider: log.args.provider,
          amountUSDC: log.args.amountUSDC.toString(),
          reason: REASONS[Number(log.args.reason)] || `REASON_${log.args.reason}`,
          requestHash: log.args.requestHash,
          debtBeforeUSDC: log.args.debtBeforeUSDC.toString(),
          debtAfterUSDC: log.args.debtAfterUSDC.toString(),
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber.toString(),
          hasX402Bind: x402ByRequest.has(log.args.requestHash.toLowerCase()),
        });
      }
    } catch (error) {
      warnings.push(`logs ${start.toString()}-${end.toString()}: ${sanitize(error)}`);
    }
  }

  if (warnings.length > 0 && receiptLogs.length === 0) {
    throw new Error(`Float receipt evidence fetch failed across ${warnings.length} chunks: ${warnings[0]}`);
  }

  const result = {
    receipts: receiptLogs.sort((a, b) => Number(BigInt(a.receiptId) - BigInt(b.receiptId))),
    warnings,
  };
  receiptEvidenceCache = {
    address: cacheKey,
    fromBlock,
    toBlock,
    cachedAt: Date.now(),
    receipts: result.receipts,
    warnings: result.warnings,
  };
  return { ...result, fromBlock, toBlock, cached: false };
}

function labelFor(address: string): "lab" | "invited" | "self-test" | "demo" {
  const a = address.toLowerCase();
  const lab = parseSet(process.env.FLOAT_LAB_AGENTS, [DEFAULT_ALPHA]);
  const demo = parseSet(process.env.FLOAT_DEMO_AGENTS, [DEFAULT_BETA]);
  const selfTest = parseSet(process.env.FLOAT_SELF_TEST_AGENTS || process.env.VITE_FLOAT_SELF_TEST_AGENTS, [...DEFAULT_SELF_TEST_AGENTS]);
  if (lab.has(a)) return "lab";
  if (demo.has(a)) return "demo";
  if (selfTest.has(a)) return "self-test";
  return "invited";
}

type ScoreEvidence = {
  runs: number;
  paidBound: number;
  signedExternalPaidBound: number;
  repaid: number;
  blocked: number;
  denied: number;
  error: number;
  requestHashes: `0x${string}`[];
  receiptHashes: `0x${string}`[];
  scoringReceipts: Array<{
    receiptType: string;
    reason: string;
    requestHash: `0x${string}`;
    receiptHash: `0x${string}`;
    txHash: `0x${string}`;
    blockNumber: string;
  }>;
};

function scoreEvidenceFromReceipts(agent: string, receipts: IndexedFloatReceipt[], runs: LoopRun[]): ScoreEvidence {
  const a = agent.toLowerCase();
  const matchingReceipts = receipts.filter((receipt) => receipt.agent.toLowerCase() === a);
  const byRequest = groupReceiptsByRequest(matchingReceipts);
  const paidBoundRequests = [...byRequest.entries()]
    .filter(([, grouped]) => isPaidBoundReceiptGroup(grouped))
    .map(([requestHash]) => requestHash as `0x${string}`);
  const signedExternalRequests = new Set(
    runs
      .filter(
        (run) =>
          runAgent(run) === a &&
          run.source === "external-signed" &&
          run.outcome === "PAID_BOUND" &&
          Boolean(run.signature && run.intent && run.requestHash) &&
          (Boolean(run.x402Hash && run.bindTxHash) || Boolean(run.intent?.maxDebtUSDC)),
      )
      .map((run) => run.requestHash!.toLowerCase()),
  );
  const repaidReceipts = matchingReceipts.filter((receipt) => receipt.receiptType === "REPAID");
  const blockedReceipts = matchingReceipts.filter((receipt) => receipt.receiptType === "SPEND_BLOCKED");
  const deniedReceipts = matchingReceipts.filter((receipt) => receipt.receiptType === "CREDIT_DENIED");
  const scoringReceipts = matchingReceipts.filter(
    (receipt) =>
      receipt.receiptType === "SPEND_ALLOWED" ||
      receipt.receiptType === "DEBT_OPENED" ||
      receipt.receiptType === "REPAID" ||
      receipt.receiptType === "SPEND_BLOCKED" ||
      receipt.receiptType === "CREDIT_DENIED",
  );
  const signedExternalPaidBound = paidBoundRequests.filter((requestHash) => signedExternalRequests.has(requestHash.toLowerCase())).length;
  return {
    runs: matchingReceipts.length,
    paidBound: paidBoundRequests.length,
    signedExternalPaidBound,
    repaid: repaidReceipts.length,
    blocked: blockedReceipts.length,
    denied: deniedReceipts.length,
    error: 0,
    requestHashes: [...new Set([...paidBoundRequests, ...scoringReceipts.map((receipt) => receipt.requestHash)])].filter(isNonZeroHash).slice(-12),
    receiptHashes: scoringReceipts.map((receipt) => receipt.receiptHash).slice(-12),
    scoringReceipts: scoringReceipts.slice(-12).map((receipt) => ({
      receiptType: receipt.receiptType,
      reason: receipt.reason,
      requestHash: receipt.requestHash,
      receiptHash: receipt.receiptHash,
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
    })),
  };
}

function groupReceiptsByRequest(receipts: IndexedFloatReceipt[]) {
  const grouped = new Map<string, IndexedFloatReceipt[]>();
  for (const receipt of receipts) {
    if (!isNonZeroHash(receipt.requestHash)) continue;
    const key = receipt.requestHash.toLowerCase();
    const current = grouped.get(key) || [];
    current.push(receipt);
    grouped.set(key, current);
  }
  return grouped;
}

function isPaidBoundReceiptGroup(receipts: IndexedFloatReceipt[]) {
  const types = new Set(receipts.map((receipt) => receipt.receiptType));
  return types.has("SPEND_ALLOWED") && types.has("PROVIDER_PAID") && types.has("DEBT_OPENED");
}

function isNonZeroHash(value: string | undefined): value is `0x${string}` {
  return Boolean(value && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value));
}

function runAgent(run: LoopRun): string | null {
  const agent = run.agent || run.intent?.agent;
  return agent && isAddress(agent) ? getAddress(agent).toLowerCase() : null;
}

function filterRunsForFloat(runs: LoopRun[], floatRaw: string | undefined): LoopRun[] {
  if (!floatRaw || !isAddress(floatRaw)) return [];
  const current = getAddress(floatRaw);
  return runs.filter((run) => Boolean(run.float && isAddress(run.float) && getAddress(run.float) === current));
}

function currentFloatAddress(): Address {
  const explicit = clean(process.env.FLOAT_TOOLS_FLOAT || process.env.FLOAT_V2_CONTRACT);
  const raw = explicit || FLOAT_V2_CONTRACT;
  if (!isAddress(raw)) return getAddress(FLOAT_V2_CONTRACT);
  const address = getAddress(raw);
  if (address.toLowerCase() === LEGACY_FLOAT_V1.toLowerCase() && clean(process.env.ALLOW_LEGACY_FLOAT_TOOLS) !== "1") {
    return getAddress(FLOAT_V2_CONTRACT);
  }
  return address;
}

function deterministicScore(label: "lab" | "invited" | "self-test" | "demo", evidence: ScoreEvidence) {
  const base = label === "lab" ? 8500 : label === "invited" ? 7500 : label === "self-test" ? 6500 : 5000;
  const raw =
    base +
    Math.min(evidence.paidBound, 5) * 150 +
    Math.min(evidence.signedExternalPaidBound, 3) * 350 +
    Math.min(evidence.repaid, 3) * 400 -
    Math.min(evidence.blocked, 5) * 250 -
    Math.min(evidence.denied, 3) * 900 -
    Math.min(evidence.error, 3) * 300;
  return Math.max(0, Math.min(10000, raw));
}

function recommendedLimitForScore(score: number): string {
  if (score >= 9000) return "1000000";
  if (score >= 8000) return "50000";
  if (score >= 7500) return "25000";
  return "0";
}

function serializeLine(line: readonly unknown[]) {
  return {
    wallet: line[0],
    score: Number(line[1]),
    creditLimitUSDC: (line[2] as bigint).toString(),
    availableCreditUSDC: (line[3] as bigint).toString(),
    activeDebtUSDC: (line[4] as bigint).toString(),
    status: STATUSES[Number(line[5])] || `STATUS_${line[5]}`,
    lastReview: Number(line[6]),
  };
}

function serializeBehaviorStats(stats: readonly unknown[]) {
  return {
    paidBound: Number(stats[0]),
    signedExternalPaid: Number(stats[1]),
    repaid: Number(stats[2]),
    blocked: Number(stats[3]),
    denied: Number(stats[4]),
    errorCount: Number(stats[5]),
  };
}

function serializeAutonomousScore(score: readonly unknown[]) {
  return {
    score: Number(score[0]),
    recommendedLimitUSDC: (score[1] as bigint).toString(),
    cappedLimitUSDC: (score[2] as bigint).toString(),
  };
}

function formatAtomicUSDC(value: string) {
  const atomic = BigInt(value);
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function parseSet(raw: string | undefined, fallback: string[]): Set<string> {
  const cleaned = clean(raw);
  const list = cleaned ? cleaned.split(",") : fallback;
  return new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function readHash(req: Req): `0x${string}` | undefined {
  const hash = readParam(req, "hash");
  return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash as `0x${string}`) : undefined;
}

function readParam(req: Req, name: string): string | undefined {
  const q = req.query?.[name];
  if (typeof q === "string") return q;
  if (Array.isArray(q) && q.length) return q[0];
  if (req.url) {
    try {
      return new URL(req.url, "http://local").searchParams.get(name) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function clean(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\\n/g, "").trim();
  return cleaned || undefined;
}

function sanitize(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg.replace(/https?:\/\/[^\s"']+/gi, "[rpc]");
  return (msg.split("\n")[0] || "").slice(0, 200).trim() || "standing unavailable";
}

function arcTestnet(rpcUrl: string) {
  return defineChain({
    id: ARC_CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
