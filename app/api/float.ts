import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  type Address,
  type Hash,
} from "viem";
import {
  FLOAT_V2_ACTIVITY_CHECKPOINT,
  FLOAT_V2_CONTRACT,
  FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE,
  FLOAT_V2_DEPLOY_BLOCK,
  FLOAT_V2_SHADOW_CONTROLLED_SPONSORS,
  FLOAT_V2_STATUS_NAMES,
  FLOAT_V2_TRACKED_EXTERNAL_AGENTS,
  FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS,
  countFloatV2VerifiedReturningSponsors,
  floatV2Abi,
  floatV2IntentConsumedEvent,
  floatV2ReceiptEvent,
  type FloatV2TrackedExternalAgent,
} from "../floatV2Config.js";
import { createRpcReadQueue } from "../scripts/rpc-read-queue.mjs";

export const config = { maxDuration: 20 };

const ARC_CHAIN_ID = 5_042_002;
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const LOG_LOOKBACK = BigInt(process.env.FLOAT_LOG_LOOKBACK || "250000");
const LOG_CHUNK_SIZE = BigInt(process.env.FLOAT_LOG_CHUNK_SIZE || "9000");
const DEFAULT_INVITED_AGENTS = [
  "0x13585c6004fbA9D7D49219a6435B68348fD30770",
  "0x7891d0B43F067f1bA52B21682847Bb63985862Cc",
  "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
  "0x9972fF27a2EADBDB8414072736395236E0BF0092",
  "0x5c0b33b209f510868E07792Edc46c3792B0b92EC",
  "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3",
  "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf",
  "0x7d4897489bfc663b90baaf5b0803d18ae0ca817c",
  "0x43e0630025fd0339be1fa04d3d75daf355f50c89",
  "0x4bDC17682C62E15Cb3296a5aA1D61d456597EBdc",
] as const;
const DEFAULT_SELF_TEST_AGENTS = [
  "0x0C63826eE08aF1f144ec5D84B6c56fe393fE19F5",
  "0xD3eed2f7dcED5fbc96Fb1a0FC058C540D50b4f80",
  "0xa539a18b55e5e3b98892c724f8f75914c0b69942",
] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const OPERATOR_SPONSOR = "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address;
const ARC_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const RPC_TRANSPORT_OPTIONS = { timeout: 60_000, retryCount: 3 } as const;
const FLOAT_V2_RPC_TRANSPORT_OPTIONS = { timeout: 3_000, retryCount: 0 } as const;
const FLOAT_V2_ACTIVITY_CACHE_KEY = "float:v2:activity-checkpoint";
const FLOAT_V2_LIVE_BUDGET_MS = 12_000;
const FLOAT_V2_RPC_READ_SPACING_MS = 125;

type VercelLikeRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  url?: string;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

type FloatConfig = {
  rpcUrl: string;
  float: Address;
  usdc: Address;
  alpha: Address;
  beta: Address;
  provider: Address;
  invitedAgents: Address[];
  selfTestAgents: Address[];
  startBlock: bigint;
};

type FloatV2AgentStats = FloatV2TrackedExternalAgent & {
  signedIntents: number;
  providerPaidCount: number;
  repaidCount: number;
  blockedCount: number;
  providerPaidUSDC: bigint;
  repaidUSDC: bigint;
  blockedUSDC: bigint;
  latestTxHash?: Hash;
};

type FloatV2ActivityCheckpointEntry = {
  agent: Address;
  signedIntents: number;
  providerPaidCount: number;
  repaidCount: number;
  blockedCount: number;
  providerPaidUSDC: bigint;
  repaidUSDC: bigint;
  blockedUSDC: bigint;
  latestTxHash?: Hash;
};

type FloatV2ActivityCheckpointRecord = {
  blockNumber: bigint;
  checkedAt: string;
  source: "source-checkpoint" | "kv-checkpoint";
  agents: FloatV2ActivityCheckpointEntry[];
};

type SerializedFloatV2ActivityCheckpoint = {
  version: 1;
  blockNumber: string;
  checkedAt: string;
  agents: Array<{
    agent: Address;
    signedIntents: number;
    providerPaidCount: number;
    repaidCount: number;
    blockedCount: number;
    providerPaidUSDC: string;
    repaidUSDC: string;
    blockedUSDC: string;
    latestTxHash?: Hash;
  }>;
};

type FloatV2AgentProvenance = "verified-external-signer" | "unverified";
type FloatV2SponsorProvenance = "verified-external" | "shadow-controlled" | "unverified" | "none";

type FloatV2ProvenanceAgent = {
  category: string;
  agentProvenance: FloatV2AgentProvenance;
  sponsor: Address;
  verifiedSponsor?: Address;
  sponsorProvenance: FloatV2SponsorProvenance;
  sponsorReserveUSDC: string;
  signedIntents: number;
};

const SHADOW_CONTROLLED_SPONSOR_KEYS = new Set(
  FLOAT_V2_SHADOW_CONTROLLED_SPONSORS.map((address: Address) => getAddress(address).toLowerCase()),
);
const VERIFIED_EXTERNAL_SPONSOR_KEYS = new Set(
  FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS.map((address: Address) => getAddress(address).toLowerCase()),
);

function classifySponsorProvenance(sponsor: Address): FloatV2SponsorProvenance {
  const key = getAddress(sponsor).toLowerCase();
  if (key === ZERO_ADDRESS.toLowerCase()) return "none";
  if (SHADOW_CONTROLLED_SPONSOR_KEYS.has(key)) return "shadow-controlled";
  if (VERIFIED_EXTERNAL_SPONSOR_KEYS.has(key)) return "verified-external";
  return "unverified";
}

function hasSponsoredReserve(agent: FloatV2ProvenanceAgent): boolean {
  return agent.sponsorProvenance !== "none" && BigInt(agent.sponsorReserveUSDC) > 0n;
}

function classifySponsorState(
  reserveUSDC: bigint,
  lineExpiry: bigint,
  activeDebtUSDC: bigint,
  repaidCount: number,
): "active-reserve" | "expired-reserve-reclaimable" | "expired-debt-open" | "closed-reserve-reclaimed" | "none" {
  if (reserveUSDC > 0n) {
    const expired = lineExpiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) > lineExpiry;
    if (expired) return activeDebtUSDC > 0n ? "expired-debt-open" : "expired-reserve-reclaimable";
    return "active-reserve";
  }
  return repaidCount > 0 && activeDebtUSDC === 0n ? "closed-reserve-reclaimed" : "none";
}

export function summarizeFloatV2Provenance(agents: FloatV2ProvenanceAgent[]) {
  const trackedExternalAgents = agents.filter(
    (agent) => agent.category === "external" && agent.agentProvenance === "verified-external-signer" && hasSponsoredReserve(agent),
  );
  const externallySponsoredAgents = trackedExternalAgents.filter(
    (agent) => agent.sponsorProvenance === "verified-external",
  );
  const operatorSponsoredAgents = trackedExternalAgents.filter(
    (agent) => agent.sponsorProvenance === "shadow-controlled",
  );
  const externallySponsoredHistory = agents.filter(
    (agent) =>
      agent.category === "external" &&
      agent.agentProvenance === "verified-external-signer" &&
      Number(agent.signedIntents) > 0,
  );

  return {
    trackedExternalAgentLines: trackedExternalAgents.length,
    externallySponsoredLines: externallySponsoredAgents.length,
    operatorSponsoredLines: operatorSponsoredAgents.length,
    returningAgents: externallySponsoredAgents.filter((agent) => Number(agent.signedIntents) > 1).length,
    returningSponsors: countFloatV2VerifiedReturningSponsors(externallySponsoredHistory),
  };
}

type FloatV2Line = readonly [
  wallet: Address,
  score: number,
  creditLimitUSDC: bigint,
  availableCreditUSDC: bigint,
  activeDebtUSDC: bigint,
  status: number,
  lastReview: bigint,
  mandateId: Hash,
  day: bigint,
  spentTodayUSDC: bigint,
];

type FloatV2SponsorLine = readonly [sponsor: Address, reserveUSDC: bigint];

type FloatV2BehaviorStats = readonly [
  paidBound: number,
  signedExternalPaid: number,
  repaid: number,
  blocked: number,
  denied: number,
  errorCount: number,
];

type FloatV2AutonomousScore = readonly [
  score: number,
  recommendedLimitUSDC: bigint,
  cappedLimitUSDC: bigint,
];

type FloatLoopRun = {
  source?: string;
  float?: string;
  agent?: string;
  action?: string;
  outcome?: string;
  at?: string;
  amountUSDC?: string;
  x402Hash?: string;
  bindTxHash?: string;
  repayTxHash?: string;
  txHash?: string;
  requestHash?: string;
  reason?: string;
  rationale?: string;
  rationalePreimage?: string;
  intent?: {
    agent?: string;
  };
  model?: string;
  fellBack?: boolean;
};

type FloatReadClient = {
  // Keep this helper boundary loose: viem's generic PublicClient type is very
  // deep and Vercel's serverless type pass can fail on it. The function only
  // calls the typed `lines(address)` view below.
  readContract: (args: any) => Promise<any>;
};

type FloatV2LogClient = {
  getLogs: (args: any) => Promise<Array<{ data: `0x${string}`; topics: readonly `0x${string}`[]; transactionHash: `0x${string}` }>>;
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

type X402PaymentBoundEventArgs = {
  receiptId: bigint;
  requestHash: `0x${string}`;
  x402Hash: `0x${string}`;
  provider: Address;
  amountUSDC: bigint;
  facilitator: Address;
};

type IndexedLog<TArgs> = {
  args: TArgs;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  data: `0x${string}`;
  topics: readonly `0x${string}`[];
};

const floatAbi = parseAbi([
  "function receiptCount() view returns (uint256)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalProviderPaidUSDC() view returns (uint256)",
  "function totalDebtOpenedUSDC() view returns (uint256)",
  "function totalBlockedUSDC() view returns (uint256)",
  "function totalDeniedUSDC() view returns (uint256)",
  "function totalRepaidUSDC() view returns (uint256)",
  "function totalFeesAccruedUSDC() view returns (uint256)",
  "function totalDefaultedUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function lastChecksum() view returns (bytes32)",
  "function providerMandates(address provider) view returns (bytes32 endpointHash, uint256 maxPerRequestUSDC, uint256 dailyLimitUSDC, uint64 expiry, bool active)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
]);
const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

const floatReceiptEvent = parseAbiItem(
  "event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)",
);

const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);

const FLOAT_V2_LOG_CHUNK_SIZE = BigInt(process.env.FLOAT_V2_LOG_CHUNK_SIZE || FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE.toString());

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

const STATUSES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];

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

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  if (queryParam(req, "mode") === "desk") {
    await handleFloatDesk(res, req);
    return;
  }

  if (queryParam(req, "mode") === "v2" || queryParam(req, "v") === "2") {
    await handleFloatV2(res);
    return;
  }

  const cfg = floatConfigFromEnv();
  if (!cfg) {
    res.status(200).json({
      configured: false,
      missing: missingEnv(),
      testnet: true,
      network: "arc-testnet",
    });
    return;
  }

  try {
    const client = createPublicClient({
      chain: arcTestnet(cfg.rpcUrl),
      transport: http(cfg.rpcUrl, RPC_TRANSPORT_OPTIONS),
    });
    const [
      receiptCount,
      treasuryBalanceUSDC,
      totalProviderPaidUSDC,
      totalDebtOpenedUSDC,
      totalBlockedUSDC,
      totalDeniedUSDC,
      totalRepaidUSDC,
      totalFeesAccruedUSDC,
      totalDefaultedUSDC,
      totalAvailableCreditUSDC,
      feeBps,
      lastChecksum,
      alphaLine,
      betaLine,
      providerMandate,
      latestBlock,
      allLoopRuns,
    ] = await Promise.all([
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "receiptCount" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "treasuryBalanceUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalProviderPaidUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalDebtOpenedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalBlockedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalDeniedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalRepaidUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalFeesAccruedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalDefaultedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalAvailableCreditUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "feeBps" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "lastChecksum" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "lines", args: [cfg.alpha] }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "lines", args: [cfg.beta] }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "providerMandates", args: [cfg.provider] }),
      client.getBlockNumber(),
      readFloatLoopRuns(),
    ]);
    const loopRuns = (allLoopRuns as FloatLoopRun[]).filter((run: FloatLoopRun) => runMatchesFloat(run, cfg.float));

    const fromBlock = cfg.startBlock > 0n ? cfg.startBlock : latestBlock > LOG_LOOKBACK ? latestBlock - LOG_LOOKBACK : 0n;
    const { receiptLogs: logs, x402Logs, warnings: logWarnings } = await readFloatLogs(client, cfg.float, fromBlock, latestBlock);
    const x402ByRequest = new Map(
      x402Logs.map((log) => [
        log.args.requestHash,
        {
          receiptId: log.args.receiptId!.toString(),
          requestHash: log.args.requestHash,
          x402Hash: log.args.x402Hash,
          provider: log.args.provider,
          amountUSDC: log.args.amountUSDC!.toString(),
          amountFormatted: formatUnits(log.args.amountUSDC!, 6),
          facilitator: log.args.facilitator,
          bindingTxHash: log.transactionHash,
          blockNumber: log.blockNumber.toString(),
        },
      ]),
    );

    const standingBoard = await buildStandingBoard(client, cfg, logs as Array<{ args: Record<string, unknown> }>);
    const indexedReceipts = logs
      .slice()
      .sort((a, b) => Number(b.args.receiptId! - a.args.receiptId!))
      .map((log) => {
        const x402 = x402ByRequest.get(log.args.requestHash);
        const receiptType = RECEIPT_TYPES[Number(log.args.receiptType)] || `TYPE_${log.args.receiptType}`;
        const amountUSDC = BigInt(log.args.amountUSDC!);
        const debtBefore = BigInt(log.args.debtBeforeUSDC!);
        const debtAfter = BigInt(log.args.debtAfterUSDC!);
        const debtDelta = debtAfter > debtBefore ? debtAfter - debtBefore : 0n;
        const feeUSDC = receiptType === "DEBT_OPENED" && debtDelta > amountUSDC ? debtDelta - amountUSDC : 0n;
        return {
          receiptId: log.args.receiptId!.toString(),
          receiptHash: log.args.receiptHash,
          receiptType,
          agent: log.args.agent,
          provider: log.args.provider,
          endpointHash: log.args.endpointHash,
          amountUSDC: amountUSDC.toString(),
          amountFormatted: formatUnits(amountUSDC, 6),
          providerAmountUSDC: amountUSDC.toString(),
          feeUSDC: feeUSDC.toString(),
          debtOpenedUSDC: debtDelta.toString(),
          debtDeltaUSDC: debtDelta.toString(),
          creditBeforeUSDC: log.args.creditBeforeUSDC!.toString(),
          creditAfterUSDC: log.args.creditAfterUSDC!.toString(),
          debtBeforeUSDC: debtBefore.toString(),
          debtAfterUSDC: debtAfter.toString(),
          reason: REASONS[Number(log.args.reason)] || `REASON_${log.args.reason}`,
          mandateId: log.args.mandateId,
          requestHash: log.args.requestHash,
          prevChecksum: log.args.prevChecksum,
          checksum: log.args.checksum,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber.toString(),
          x402,
        };
      });
    const receipts = indexedReceipts.slice(0, 30);
    const sourceBreakdown = summarizeSources(
      loopRuns,
      totalProviderPaidUSDC,
      totalDebtOpenedUSDC,
      totalBlockedUSDC,
      totalDeniedUSDC,
      totalRepaidUSDC,
      indexedReceipts,
    );
    const proofPointers = buildProofPointers(indexedReceipts, loopRuns);
    const alphaWalletBalanceUSDC = await safeBalanceOf(client, cfg.usdc, cfg.alpha);
    const walletProof = buildWalletProof(indexedReceipts, alphaLine, alphaWalletBalanceUSDC);
    const proofChecks = buildProofChecks({
      cfg,
      receiptCount,
      receipts: indexedReceipts,
      logWarnings,
      treasuryBalanceUSDC,
      totalAvailableCreditUSDC,
      totalDebtOpenedUSDC,
      totalRepaidUSDC,
      standingBoard,
      sourceBreakdown,
    });

    res.status(200).json({
      configured: true,
      testnet: true,
      network: "arc-testnet",
      float: cfg.float,
      usdc: cfg.usdc,
      alpha: cfg.alpha,
      beta: cfg.beta,
      provider: cfg.provider,
      receiptCount: receiptCount.toString(),
      treasuryBalanceUSDC: treasuryBalanceUSDC.toString(),
      totalProviderPaidUSDC: totalProviderPaidUSDC.toString(),
      totalDebtOpenedUSDC: totalDebtOpenedUSDC.toString(),
      totalBlockedUSDC: totalBlockedUSDC.toString(),
      totalDeniedUSDC: totalDeniedUSDC.toString(),
      totalRepaidUSDC: totalRepaidUSDC.toString(),
      totalFeesAccruedUSDC: totalFeesAccruedUSDC.toString(),
      totalDefaultedUSDC: totalDefaultedUSDC.toString(),
      totalAvailableCreditUSDC: totalAvailableCreditUSDC.toString(),
      feeBps: Number(feeBps),
      lastChecksum,
      alphaLine: serializeLine(alphaLine),
      betaLine: serializeLine(betaLine),
      providerMandate: serializeProvider(providerMandate),
      standingBoard,
      sourceBreakdown,
      proofChecks,
      proofPointers,
      walletProof,
      logFetch: {
        fromBlock: fromBlock.toString(),
        toBlock: latestBlock.toString(),
        chunkSize: LOG_CHUNK_SIZE.toString(),
        complete: logWarnings.length === 0,
        warnings: logWarnings,
      },
      loopRuns: loopRuns.slice(-12).reverse(),
      receipts,
      latestBlock: latestBlock.toString(),
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ configured: true, degraded: true, error: sanitizeError(error) });
  }
}

async function handleFloatV2(res: VercelLikeResponse) {
  res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=300");
  try {
    const deadlineAt = Date.now() + FLOAT_V2_LIVE_BUDGET_MS;
    const rpcUrl = cleanEnv(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
    const client = createPublicClient({
      chain: arcTestnet(rpcUrl),
      transport: http(rpcUrl, FLOAT_V2_RPC_TRANSPORT_OPTIONS),
    });
    const rpcQueue = createRpcReadQueue({
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 1_000,
      spacingMs: FLOAT_V2_RPC_READ_SPACING_MS,
    });
    const rpcRead = <T>(label: string, operation: () => Promise<T>) =>
      rpcQueue(label, async () => {
        if (Date.now() >= deadlineAt) throw new Error("Float V2 live read budget exhausted");
        return operation();
      });
    const [latestBlock, checkpoint] = await Promise.all([
      rpcRead("eth_blockNumber", () => client.getBlockNumber()),
      readFloatV2ActivityCheckpoint(),
    ]);
    if (checkpoint.blockNumber > latestBlock) {
      throw new Error(`Float V2 checkpoint ${checkpoint.blockNumber} is ahead of Arc block ${latestBlock}`);
    }

    const checkpointByAgent = new Map(checkpoint.agents.map((entry) => [entry.agent.toLowerCase(), entry]));
    const stats = new Map<string, FloatV2AgentStats>();

    for (const entry of FLOAT_V2_TRACKED_EXTERNAL_AGENTS) {
      const agent = getAddress(entry.agent);
      const baseline = checkpointByAgent.get(agent.toLowerCase());
      if (!baseline) throw new Error(`Float V2 checkpoint is missing tracked agent ${agent}`);
      stats.set(agent.toLowerCase(), {
        ...entry,
        agent,
        signedIntents: baseline.signedIntents,
        providerPaidCount: baseline.providerPaidCount,
        repaidCount: baseline.repaidCount,
        blockedCount: baseline.blockedCount,
        providerPaidUSDC: baseline.providerPaidUSDC,
        repaidUSDC: baseline.repaidUSDC,
        blockedUSDC: baseline.blockedUSDC,
        latestTxHash: baseline.latestTxHash,
      });
    }

    const scanFromBlock = checkpoint.blockNumber + 1n;
    const logWarnings =
      scanFromBlock <= latestBlock
        ? await enrichFloatV2StatsFromLogs(client as FloatV2LogClient, stats, scanFromBlock, latestBlock, rpcRead)
        : [];
    if (logWarnings.length > 0) {
      throw new Error(`incomplete V2 log read: ${logWarnings.slice(0, 2).join("; ")}`);
    }
    const statEntries = [...stats.values()];
    const stateContracts: Array<{ address: Address; abi: typeof floatV2Abi; functionName: string; args?: readonly unknown[] }> = [
      { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "treasuryBalanceUSDC" },
      { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "totalAvailableCreditUSDC" },
      { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "totalSponsoredReserveUSDC" },
    ];
    for (const entry of statEntries) {
      stateContracts.push(
        { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lines", args: [entry.agent] },
        { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lineSponsors", args: [entry.agent] },
        { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lineExpiries", args: [entry.agent] },
        { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "behaviorStats", args: [entry.agent] },
        { address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "autonomousLineScore", args: [entry.agent] },
      );
    }
    const stateResults = (await rpcRead("ShadowFloat V2 state multicall", () =>
      client.multicall({
        contracts: stateContracts as any,
        multicallAddress: ARC_MULTICALL3,
        allowFailure: false,
        batchSize: 16_384,
        blockNumber: latestBlock,
      }),
    )) as unknown[];
    if (stateResults.length !== stateContracts.length) {
      throw new Error(`Float V2 multicall returned ${stateResults.length}/${stateContracts.length} results`);
    }
    const [treasuryBalance, totalAvailableCredit, totalSponsoredReserve] = stateResults.slice(0, 3) as [bigint, bigint, bigint];

    const agents = statEntries.map((entry, index) => {
      const offset = 3 + index * 5;
      const line = stateResults[offset] as FloatV2Line;
      const sponsorLine = stateResults[offset + 1] as FloatV2SponsorLine;
      const lineExpiry = stateResults[offset + 2] as bigint;
      const behaviorStats = stateResults[offset + 3] as FloatV2BehaviorStats;
      const autonomousScore = stateResults[offset + 4] as FloatV2AutonomousScore;
      const status = Number(line[5]);
      const lastReview = line[6].toString();
      const sponsorReserveUSDC = sponsorLine[1].toString();
      const sponsorState = classifySponsorState(sponsorLine[1], lineExpiry, line[4], entry.repaidCount);
      return {
        label: entry.label,
        category: "external",
        agent: entry.agent,
        agentOwner: entry.agent,
        agentProvenance: "verified-external-signer" as const,
        wallet: line[0],
        score: Number(line[1]),
        creditLimitUSDC: line[2].toString(),
        availableCreditUSDC: line[3].toString(),
        activeDebtUSDC: line[4].toString(),
        status,
        statusName: FLOAT_V2_STATUS_NAMES[status] || "UNKNOWN",
        lastReview,
        lastReviewISO: line[6] > 0n ? new Date(Number(line[6]) * 1000).toISOString() : null,
        lineExpiry: lineExpiry.toString(),
        lineExpiryISO: lineExpiry > 0n ? new Date(Number(lineExpiry) * 1000).toISOString() : null,
        scoredByContract: true,
        behavior: {
          paidBound: Number(behaviorStats[0]),
          signedExternalPaid: Number(behaviorStats[1]),
          repaid: Number(behaviorStats[2]),
          blocked: Number(behaviorStats[3]),
          denied: Number(behaviorStats[4]),
          errorCount: Number(behaviorStats[5]),
        },
        behaviorStateReset: Boolean(entry.retired),
        autonomousScore: {
          score: Number(autonomousScore[0]),
          recommendedLimitUSDC: autonomousScore[1].toString(),
          cappedLimitUSDC: autonomousScore[2].toString(),
        },
        sponsor: sponsorLine[0],
        verifiedSponsor: entry.verifiedSponsor ? getAddress(entry.verifiedSponsor) : undefined,
        sponsorProvenance: classifySponsorProvenance(sponsorLine[0]),
        sponsorReserveUSDC,
        sponsorState,
        signedIntents: entry.signedIntents,
        providerPaidCount: entry.providerPaidCount,
        repaidCount: entry.repaidCount,
        blockedCount: entry.blockedCount,
        providerPaidUSDC: entry.providerPaidUSDC.toString(),
        repaidUSDC: entry.repaidUSDC.toString(),
        blockedUSDC: entry.blockedUSDC.toString(),
        spendTx: entry.spendTx,
        repayTx: entry.repayTx,
        latestTxHash: entry.latestTxHash,
      };
    });

    const visibleAgents = agents.sort((a, b) => {
      const aDebt = BigInt(a.activeDebtUSDC) > 0n ? 1 : 0;
      const bDebt = BigInt(b.activeDebtUSDC) > 0n ? 1 : 0;
      if (a.statusName === "REPAID" && b.statusName !== "REPAID") return -1;
      if (b.statusName === "REPAID" && a.statusName !== "REPAID") return 1;
      if (aDebt !== bDebt) return bDebt - aDebt;
      return a.label.localeCompare(b.label);
    });

    const provenance = summarizeFloatV2Provenance(visibleAgents);
    const summary = {
      trackedExternalAgentLines: provenance.trackedExternalAgentLines,
      externallySponsoredLines: provenance.externallySponsoredLines,
      operatorSponsoredLines: provenance.operatorSponsoredLines,
      signedIntents: visibleAgents.reduce((sum, agent) => sum + agent.signedIntents, 0),
      paidSpends: visibleAgents.reduce((sum, agent) => sum + agent.providerPaidCount, 0),
      repaidLifecycles: visibleAgents.reduce((sum, agent) => sum + agent.repaidCount, 0),
      openDebtAgents: visibleAgents.filter((agent) => BigInt(agent.activeDebtUSDC) > 0n).length,
      providerPaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.providerPaidUSDC), 0n).toString(),
      repaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.repaidUSDC), 0n).toString(),
      activeDebtUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.activeDebtUSDC), 0n).toString(),
      blockedUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.blockedUSDC), 0n).toString(),
      returningAgents: provenance.returningAgents,
      returningSponsors: provenance.returningSponsors,
    };

    const checkpointPersisted = await writeFloatV2ActivityCheckpoint(latestBlock, stats);

    res.status(200).json({
      ok: true,
      source: "live-rpc",
      degraded: false,
      mode: "shadow-float-v2-activity",
      checkedAt: new Date().toISOString(),
      chainId: ARC_CHAIN_ID,
      float: FLOAT_V2_CONTRACT,
      latestBlock: latestBlock.toString(),
      treasuryBalanceUSDC: treasuryBalance.toString(),
      totalAvailableCreditUSDC: totalAvailableCredit.toString(),
      totalSponsoredReserveUSDC: totalSponsoredReserve.toString(),
      summary,
      agents: visibleAgents,
      selfTestAgents: [],
      activityCheckpoint: {
        source: checkpoint.source,
        baseBlock: checkpoint.blockNumber.toString(),
        scannedFromBlock: scanFromBlock <= latestBlock ? scanFromBlock.toString() : null,
        persistedThroughBlock: checkpointPersisted ? latestBlock.toString() : null,
      },
      logFetch: {
        fromBlock: scanFromBlock <= latestBlock ? scanFromBlock.toString() : null,
        toBlock: latestBlock.toString(),
        checkpointBlock: checkpoint.blockNumber.toString(),
        complete: logWarnings.length === 0,
        warnings: logWarnings,
      },
    });
  } catch (error) {
    res.status(200).json(buildFloatV2VerifiedSnapshot(error));
  }
}

function buildFloatV2VerifiedSnapshot(error: unknown) {
  const agents = [
    snapshotV2Agent({
      label: "Argus Alpha",
      agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC",
      score: 9000,
      signedIntents: 2,
      paid: 2,
      repaid: 2,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      lastReview: "1784200309",
      latestTxHash: "0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699",
    }),
    snapshotV2Agent({
      label: "Argus Beta",
      agent: "0x7D4897489BFC663b90BaAF5B0803d18ae0ca817c",
      lastReview: "1784200317",
      latestTxHash: "0xac1b0d231b0d19ebcb8e18877e7fcffbb2cbf990f204f648c288053bb597d679",
    }),
    snapshotV2Agent({
      label: "Argus Gamma",
      agent: "0x43e0630025FD0339bE1fA04d3d75Daf355F50c89",
      lastReview: "1784200325",
      latestTxHash: "0xad8301ca4edbbed18bc7204d8da9be53492116649a326728ad0ca5bc19bb1682",
    }),
    snapshotV2Agent({
      label: "CitePay",
      agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
      lastReview: "1784200279",
      latestTxHash: "0x0090b55caa8553540e38b886e09e5b88fdda051254305eb36676e9dd8f842ad2",
    }),
    snapshotV2Agent({
      label: "CitePay sponsor (retired line)",
      agent: "0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f",
      wallet: ZERO_ADDRESS,
      score: 0,
      creditLimitUSDC: "0",
      availableCreditUSDC: "0",
      status: 4,
      statusName: "REVOKED",
      sponsor: ZERO_ADDRESS,
      verifiedSponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
      sponsorReserveUSDC: "0",
      sponsorState: "closed-reserve-reclaimed",
      lineExpiry: "0",
      lastReview: "1784399293",
      autonomousScore: { score: 0, recommendedLimitUSDC: "0", cappedLimitUSDC: "0" },
      behaviorPaid: 0,
      behaviorRepaid: 0,
      behaviorStateReset: true,
      spendTx: "0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae",
      repayTx: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe",
      latestTxHash: "0x2d91c37cc23ff8f342614bb9070e82efb37d0d588b15a43a3685c92786074e0d",
    }),
    snapshotV2Agent({
      label: "CitePay sponsor (renewed line)",
      agent: "0x236652EAd43fbb0948173fC4dDF23BC0971B274d",
      sponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
      verifiedSponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
      lineExpiry: "1792175302",
      lastReview: "1784399312",
      providerPaidUSDC: "5000",
      repaidUSDC: "5000",
      spendTx: "0x9007d0e8f66c0bc641caaa305266d50aeb5e2e969ff3edbbd8122542ed08eae4",
      repayTx: "0x52ef42211858713601721a9ae6935604c43c04a832fd7d7c5aef6c7c8156a911",
      latestTxHash: "0x52ef42211858713601721a9ae6935604c43c04a832fd7d7c5aef6c7c8156a911",
    }),
    snapshotV2Agent({
      label: "Crux",
      agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092",
      lastReview: "1784200287",
      spendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d",
      repayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368",
      latestTxHash: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368",
    }),
    snapshotV2Agent({
      label: "Driplet",
      agent: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf",
      score: 9000,
      lastReview: "1784200340",
      autonomousScore: { score: 9000, recommendedLimitUSDC: "1000000", cappedLimitUSDC: "50000" },
      signedIntents: 2,
      paid: 2,
      repaid: 2,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      spendTx: "0x2ea8a96245a427e8c307e89ae4abda055e172121789d1c0e30f41a400e1ba409",
      repayTx: "0x5ace712f258220aa891d3c786458ede15ba8a5e281173e66571807a3a93aa13e",
      latestTxHash: "0x5ace712f258220aa891d3c786458ede15ba8a5e281173e66571807a3a93aa13e",
    }),
    snapshotV2Agent({
      label: "Forum",
      agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770",
      lastReview: "1784200272",
      latestTxHash: "0xfba85515afe3fa1c9bae84b244bb874657756bd1656612d8b71b0686f412892e",
    }),
    snapshotV2Agent({
      label: "Obol",
      agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3",
      score: 7850,
      creditLimitUSDC: "25000",
      availableCreditUSDC: "15000",
      activeDebtUSDC: "10000",
      status: 2,
      statusName: "LIMITED",
      lastReview: "1784200332",
      signedIntents: 1,
      paid: 1,
      repaid: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "0",
      spendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a",
      latestTxHash: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a",
    }),
    snapshotV2Agent({
      label: "Forum Tollgate sponsor",
      agent: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C",
      wallet: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C",
      score: 7500,
      creditLimitUSDC: "25000",
      availableCreditUSDC: "25000",
      activeDebtUSDC: "0",
      status: 1,
      statusName: "ELIGIBLE",
      lastReview: "1784200302",
      sponsor: "0x12F25B721Cc21c38495e33A4c8524dd0B647ba03",
      lineExpiry: "1783785148",
      sponsorReserveUSDC: "50000",
      autonomousScore: { score: 7500, recommendedLimitUSDC: "25000", cappedLimitUSDC: "25000" },
      signedIntents: 1,
      paid: 1,
      repaid: 1,
      behaviorPaid: 0,
      behaviorRepaid: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      spendTx: "0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f",
      repayTx: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172",
      latestTxHash: "0xc8694da66f078d81c4199df813e8ee7b69941a14b6aef4531f6c35ca771da2e6",
    }),
  ];
  const visibleAgents = agents.sort((a, b) => {
    if (a.statusName === "REPAID" && b.statusName !== "REPAID") return -1;
    if (b.statusName === "REPAID" && a.statusName !== "REPAID") return 1;
    return a.label.localeCompare(b.label);
  });
  const provenance = summarizeFloatV2Provenance(visibleAgents);

  return {
    ok: true,
    source: "verified-checkpoint",
    degraded: true,
    fallbackReason: sanitizeError(error),
    mode: "shadow-float-v2-activity",
    checkedAt: FLOAT_V2_ACTIVITY_CHECKPOINT.checkedAt,
    servedAt: new Date().toISOString(),
    chainId: ARC_CHAIN_ID,
    float: FLOAT_V2_CONTRACT,
    latestBlock: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber.toString(),
    treasuryBalanceUSDC: "1523203",
    totalAvailableCreditUSDC: "590000",
    totalSponsoredReserveUSDC: "1500000",
    summary: {
      trackedExternalAgentLines: provenance.trackedExternalAgentLines,
      externallySponsoredLines: provenance.externallySponsoredLines,
      operatorSponsoredLines: provenance.operatorSponsoredLines,
      signedIntents: 13,
      paidSpends: 13,
      repaidLifecycles: 12,
      openDebtAgents: 1,
      providerPaidUSDC: "107000",
      repaidUSDC: "97000",
      activeDebtUSDC: "10000",
      blockedUSDC: "0",
      returningAgents: provenance.returningAgents,
      returningSponsors: provenance.returningSponsors,
    },
    agents: visibleAgents,
    selfTestAgents: [],
    activityCheckpoint: {
      source: "source-checkpoint",
      baseBlock: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber.toString(),
      scannedFromBlock: null,
      persistedThroughBlock: null,
    },
    logFetch: {
      fromBlock: FLOAT_V2_DEPLOY_BLOCK.toString(),
      toBlock: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber.toString(),
      checkpointBlock: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber.toString(),
      complete: true,
      fallback: true,
      warnings: [`live V2 read fell back to verified checkpoint: ${sanitizeError(error)}`],
    },
  };
}

function snapshotV2Agent(input: {
  label: string;
  agent: string;
  wallet?: Address | string;
  score?: number;
  creditLimitUSDC?: string;
  availableCreditUSDC?: string;
  activeDebtUSDC?: string;
  status?: number;
  statusName?: string;
  lastReview: string;
  sponsor?: Address | string;
  verifiedSponsor?: Address | string;
  sponsorReserveUSDC?: string;
  sponsorState?: string;
  lineExpiry?: string;
  autonomousScore?: { score: number; recommendedLimitUSDC: string; cappedLimitUSDC: string };
  signedIntents?: number;
  paid?: number;
  repaid?: number;
  behaviorPaid?: number;
  behaviorRepaid?: number;
  behaviorStateReset?: boolean;
  providerPaidUSDC?: string;
  repaidUSDC?: string;
  spendTx?: string;
  repayTx?: string;
  latestTxHash?: string;
}) {
  const score = input.score ?? 8250;
  const paid = input.paid ?? 1;
  const repaid = input.repaid ?? 1;
  const behaviorPaid = input.behaviorPaid ?? paid;
  const behaviorRepaid = input.behaviorRepaid ?? repaid;
  const status = input.status ?? 5;
  const statusName = input.statusName || FLOAT_V2_STATUS_NAMES[status] || "UNKNOWN";
  const agent = getAddress(input.agent);
  const wallet = getAddress(input.wallet || agent);
  const sponsorReserveUSDC = input.sponsorReserveUSDC ?? "50000";
  const sponsor = getAddress(input.sponsor || OPERATOR_SPONSOR);
  const lineExpiry = input.lineExpiry ?? "0";
  return {
    label: input.label,
    category: "external",
    agent,
    agentOwner: agent,
    agentProvenance: "verified-external-signer" as const,
    wallet,
    score,
    creditLimitUSDC: input.creditLimitUSDC ?? "50000",
    availableCreditUSDC: input.availableCreditUSDC ?? "50000",
    activeDebtUSDC: input.activeDebtUSDC ?? "0",
    status,
    statusName,
    lastReview: input.lastReview,
    lastReviewISO: new Date(Number(input.lastReview) * 1000).toISOString(),
    lineExpiry,
    lineExpiryISO: BigInt(lineExpiry) > 0n ? new Date(Number(lineExpiry) * 1000).toISOString() : null,
    scoredByContract: true,
    behavior: {
      paidBound: 0,
      signedExternalPaid: behaviorPaid,
      repaid: behaviorRepaid,
      blocked: 0,
      denied: 0,
      errorCount: 0,
    },
    behaviorStateReset: input.behaviorStateReset || undefined,
    autonomousScore: input.autonomousScore || {
      score,
      recommendedLimitUSDC: score >= 9000 ? "1000000" : score >= 8250 ? "50000" : "25000",
      cappedLimitUSDC: input.creditLimitUSDC ?? "50000",
    },
    sponsor,
    verifiedSponsor: input.verifiedSponsor ? getAddress(input.verifiedSponsor) : undefined,
    sponsorProvenance: classifySponsorProvenance(sponsor),
    sponsorReserveUSDC,
    sponsorState:
      input.sponsorState ||
      classifySponsorState(BigInt(sponsorReserveUSDC), BigInt(lineExpiry), BigInt(input.activeDebtUSDC ?? "0"), repaid),
    signedIntents: input.signedIntents ?? paid,
    providerPaidCount: paid,
    repaidCount: repaid,
    blockedCount: 0,
    providerPaidUSDC: input.providerPaidUSDC ?? "10000",
    repaidUSDC: input.repaidUSDC ?? "10000",
    blockedUSDC: "0",
    spendTx: input.spendTx,
    repayTx: input.repayTx,
    latestTxHash: input.latestTxHash,
  };
}

async function handleFloatDesk(res: VercelLikeResponse, req: VercelLikeRequest) {
  try {
    const requested = Number(queryParam(req, "limit") || "20");
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.floor(requested))) : 20;
    const entriesRaw = await readFloatDeskRuns();
    const entries = entriesRaw.map((entry) => redactDeskSecrets(entry)).slice(-limit).reverse();
    let labLine: Record<string, unknown> | null = null;
    try {
      const rpcUrl = cleanEnv(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
      const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl, RPC_TRANSPORT_OPTIONS) });
      const agent = getAddress(cleanEnv(process.env.DESK_AGENT_ADDRESS) || "0x43553CaeE153496200d37644cE28775B2b2b522E");
      const [line, sponsor, score] = (await Promise.all([
        client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lines", args: [agent] }),
        client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lineSponsors", args: [agent] }),
        client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "autonomousLineScore", args: [agent] }),
      ])) as [any, any, any];
      const status = Number(line[5]);
      labLine = {
        agent,
        label: "desk-lab",
        score: Number(line[1]),
        creditLimitUSDC: line[2].toString(),
        availableCreditUSDC: line[3].toString(),
        activeDebtUSDC: line[4].toString(),
        statusName: FLOAT_V2_STATUS_NAMES[status] || "UNKNOWN",
        sponsor: sponsor[0],
        sponsorReserveUSDC: sponsor[1].toString(),
        recommendedLimitUSDC: score[1].toString(),
        cappedLimitUSDC: score[2].toString(),
        scoredByContract: true,
      };
    } catch {
      labLine = null;
    }
    res.status(200).json({
      ok: true,
      mode: "float-desk-journal",
      checkedAt: new Date().toISOString(),
      labLine,
      entries,
      counts: {
        cycles: entriesRaw.length,
        pays: entriesRaw.filter((entry) => entry?.decision?.action === "PAY").length,
        skips: entriesRaw.filter((entry) => entry?.decision?.action === "SKIP").length,
        holds: entriesRaw.filter((entry) => entry?.decision?.action === "HOLD").length,
        repays: entriesRaw.filter((entry) => entry?.decision?.action === "REPAY").length,
        settles: entriesRaw.filter((entry) => entry?.txs?.settle?.txHash).length,
        clamps: entriesRaw.filter((entry) => entry?.decision?.wasClamped).length,
      },
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ ok: false, mode: "float-desk-journal", error: sanitizeError(error) });
  }
}

async function enrichFloatV2StatsFromLogs(
  client: FloatV2LogClient,
  stats: Map<string, FloatV2AgentStats>,
  fromBlock: bigint,
  latestBlock: bigint,
  rpcRead: <T>(label: string, operation: () => Promise<T>) => Promise<T>,
) {
  const warnings: string[] = [];
  for (let start = fromBlock; start <= latestBlock; start += FLOAT_V2_LOG_CHUNK_SIZE) {
    const end = start + FLOAT_V2_LOG_CHUNK_SIZE - 1n > latestBlock ? latestBlock : start + FLOAT_V2_LOG_CHUNK_SIZE - 1n;
    try {
      const [intentLogs, receiptLogs] = await Promise.all([
        rpcRead(`FloatIntentConsumed logs ${start}-${end}`, () =>
          client.getLogs({ address: FLOAT_V2_CONTRACT, event: floatV2IntentConsumedEvent, fromBlock: start, toBlock: end }),
        ),
        rpcRead(`FloatReceipt logs ${start}-${end}`, () =>
          client.getLogs({ address: FLOAT_V2_CONTRACT, event: floatV2ReceiptEvent, fromBlock: start, toBlock: end }),
        ),
      ]);
      for (const log of intentLogs) {
        const intent = decodeFloatV2Log(log, floatV2IntentConsumedEvent);
        if (!intent) continue;
        const stat = stats.get(String(intent.args.agent).toLowerCase());
        if (stat) {
          stat.signedIntents += 1;
          stat.latestTxHash = log.transactionHash;
        }
      }
      for (const log of receiptLogs) {
        const receipt = decodeFloatV2Log(log, floatV2ReceiptEvent);
        if (!receipt) continue;
        const stat = stats.get(String(receipt.args.agent).toLowerCase());
        if (!stat) continue;
        const receiptType = Number(receipt.args.receiptType);
        const amount = toBigInt(receipt.args.amountUSDC);
        if (receiptType === 3) {
          stat.blockedCount += 1;
          stat.blockedUSDC += amount;
          stat.latestTxHash = log.transactionHash;
        }
        if (receiptType === 4) {
          stat.providerPaidCount += 1;
          stat.providerPaidUSDC += amount;
          stat.latestTxHash = log.transactionHash;
        }
        if (receiptType === 6) {
          stat.repaidCount += 1;
          stat.repaidUSDC += amount;
          stat.latestTxHash = log.transactionHash;
        }
      }
    } catch (error) {
      warnings.push(`logs ${start.toString()}-${end.toString()}: ${sanitizeError(error)}`);
    }
  }
  return warnings;
}

async function getLogsWithRetry<TLog>(client: { getLogs: (args: any) => Promise<TLog[]> }, args: any): Promise<TLog[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.getLogs(args);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(150 * (attempt + 1));
    }
  }
  throw lastError;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeFloatV2Log(log: { data: `0x${string}`; topics: readonly `0x${string}`[] }, item: ReturnType<typeof parseAbiItem>) {
  try {
    return decodeEventLog({ abi: [item] as any, data: log.data, topics: log.topics as any }) as unknown as {
      args: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

function buildProofPointers(receipts: Array<any>, runs: FloatLoopRun[]) {
  const x402BoundReceipt = receipts.find((receipt) => receipt.x402) || null;
  const debtReceipt = x402BoundReceipt
    ? receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED" && receipt.requestHash === x402BoundReceipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED");
  const latestExternal = runs
    .slice()
    .reverse()
    .find((run) => run.source === "external-signed" && run.requestHash);
  return {
    x402BoundReceipt,
    providerPaidReceipt: x402BoundReceipt
      ? receipts.find((receipt) => receipt.receiptType === "PROVIDER_PAID" && receipt.requestHash === x402BoundReceipt.requestHash) || null
      : receipts.find((receipt) => receipt.receiptType === "PROVIDER_PAID") || null,
    debtReceipt: debtReceipt || null,
    repaymentReceipt: receipts.find((receipt) => receipt.receiptType === "REPAID") || null,
    overspendReceipt:
      receipts.find((receipt) => receipt.receiptType === "SPEND_BLOCKED" && receipt.reason === "AMOUNT_TOO_HIGH") || null,
    denialReceipt: receipts.find((receipt) => receipt.receiptType === "CREDIT_DENIED") || null,
    grantReceipt: receipts.find((receipt) => receipt.receiptType === "FLOAT_GRANTED") || null,
    latestExternalVerify:
      latestExternal?.requestHash && latestExternal.source === "external-signed"
        ? {
            requestHash: latestExternal.requestHash,
            verifyUrl: `/api/float-tools?action=verify&hash=${latestExternal.requestHash}`,
          }
        : null,
  };
}

async function safeBalanceOf(client: FloatReadClient, token: Address, account: Address): Promise<bigint> {
  try {
    return BigInt(
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      }),
    );
  } catch {
    return 0n;
  }
}

function buildWalletProof(receipts: Array<any>, alphaLine: readonly unknown[], alphaWalletBalanceUSDC: bigint) {
  const latestX402Receipt = receipts.find((receipt) => receipt.x402);
  const debtReceipt = latestX402Receipt
    ? receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED" && receipt.requestHash === latestX402Receipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED");
  const required = BigInt(latestX402Receipt?.x402?.amountUSDC || latestX402Receipt?.amountUSDC || "0");
  const available = alphaLine?.[3] ? BigInt(alphaLine[3] as bigint) : 0n;
  const debtAssigned = BigInt(debtReceipt?.debtOpenedUSDC || debtReceipt?.debtDeltaUSDC || "0");
  const shortfall = required > alphaWalletBalanceUSDC ? required - alphaWalletBalanceUSDC : 0n;
  return {
    agent: alphaLine?.[0],
    balanceSnapshot: "current",
    historicalBeforeBalanceAvailable: false,
    note:
      "The contract did not store the agent wallet's historical pre-spend USDC balance. This panel shows current wallet balance plus the x402/debt receipts so the proof is not presented as a fake before-balance snapshot.",
    agentWalletUSDC: alphaWalletBalanceUSDC.toString(),
    requiredX402AmountUSDC: required.toString(),
    walletShortfallUSDC: shortfall.toString(),
    floatAvailableCapacityUSDC: available.toString(),
    facilitatorPaidUSDC: required.toString(),
    debtAssignedUSDC: debtAssigned.toString(),
    requestHash: latestX402Receipt?.requestHash || null,
    x402Hash: latestX402Receipt?.x402?.x402Hash || null,
    bindTxHash: latestX402Receipt?.x402?.bindingTxHash || latestX402Receipt?.transactionHash || null,
  };
}

function buildProofChecks(input: {
  cfg: FloatConfig;
  receiptCount: bigint;
  receipts: Array<any>;
  logWarnings: string[];
  treasuryBalanceUSDC: bigint;
  totalAvailableCreditUSDC: bigint;
  totalDebtOpenedUSDC: bigint;
  totalRepaidUSDC: bigint;
  standingBoard: Awaited<ReturnType<typeof buildStandingBoard>>;
  sourceBreakdown: ReturnType<typeof summarizeSources>;
}) {
  const has = (type: string, reason?: string) =>
    input.receipts.some((receipt) => receipt.receiptType === type && (!reason || receipt.reason === reason));
  const activeDebt = input.standingBoard.agents.reduce((sum, agent) => sum + toBigInt(agent.activeDebtUSDC), 0n);
  const expectedActiveDebt = clampSub(input.totalDebtOpenedUSDC, input.totalRepaidUSDC);
  return {
    contractMatchesReadme: input.cfg.float.toLowerCase() === "0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057",
    logFetchComplete: input.logWarnings.length === 0,
    indexedReceiptCountMatchesChain: BigInt(input.receipts.length) === input.receiptCount,
    treasuryBacksAvailableCapacity: input.treasuryBalanceUSDC >= input.totalAvailableCreditUSDC,
    hasX402BoundSpend: input.receipts.some((receipt) => Boolean(receipt.x402)),
    hasDebtOpened: has("DEBT_OPENED"),
    hasRepayment: has("REPAID"),
    hasOverspendBlock: has("SPEND_BLOCKED", "AMOUNT_TOO_HIGH"),
    hasRiskyDenial: has("CREDIT_DENIED", "CREDIT_DENIED"),
    externalSignedCurrentContract: Number(input.sourceBreakdown.externalSigned.cycles) > 0,
    externalSignedRepayLifecycle: Number(input.sourceBreakdown.externalSigned.lifecycleClosedCount || 0) > 0,
    activeDebtReconciles: activeDebt === expectedActiveDebt,
    feeMechanicsVisible: input.receipts.some((receipt) => receipt.receiptType === "DEBT_OPENED" && BigInt(receipt.feeUSDC || "0") > 0n),
    trustBoundary: "operators are owner-approved executors; score evidence is receipt-derived, but line execution is not permissionlessly auto-updated",
  };
}

async function readFloatLogs(client: any, address: Address, fromBlock: bigint, toBlock: bigint) {
  const receiptLogs: Array<IndexedLog<FloatReceiptEventArgs>> = [];
  const x402Logs: Array<IndexedLog<X402PaymentBoundEventArgs>> = [];
  const warnings: string[] = [];
  if (toBlock < fromBlock) return { receiptLogs, x402Logs, warnings };

  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = start + LOG_CHUNK_SIZE - 1n > toBlock ? toBlock : start + LOG_CHUNK_SIZE - 1n;
    try {
      const rawLogs = await getLogsWithRetry<{
        data: `0x${string}`;
        topics: readonly `0x${string}`[];
        transactionHash: `0x${string}`;
        blockNumber: bigint;
      }>(client, { address, fromBlock: start, toBlock: end });
      for (const log of rawLogs) {
        const receipt = decodeFloatReceiptLog(log);
        if (receipt) {
          receiptLogs.push({ ...log, args: receipt.args });
          continue;
        }
        const x402 = decodeX402PaymentBoundLog(log);
        if (x402) x402Logs.push({ ...log, args: x402.args });
      }
    } catch (error) {
      warnings.push(`logs ${start.toString()}-${end.toString()}: ${sanitizeError(error)}`);
    }
  }

  if (warnings.length > 0 && receiptLogs.length === 0 && x402Logs.length === 0) {
    throw new Error(`Float log fetch failed across ${warnings.length} chunks: ${warnings[0]}`);
  }
  return { receiptLogs, x402Logs, warnings };
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

function decodeX402PaymentBoundLog(log: { data: `0x${string}`; topics: readonly `0x${string}`[] }): { args: X402PaymentBoundEventArgs } | null {
  try {
    return decodeEventLog({
      abi: [x402PaymentBoundEvent] as any,
      data: log.data,
      topics: log.topics as any,
    }) as unknown as { args: X402PaymentBoundEventArgs };
  } catch {
    return null;
  }
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
    mandateId: line[7],
    day: Number(line[8]),
    spentTodayUSDC: (line[9] as bigint).toString(),
  };
}

function serializeProvider(provider: readonly unknown[]) {
  return {
    endpointHash: provider[0],
    maxPerRequestUSDC: (provider[1] as bigint).toString(),
    dailyLimitUSDC: (provider[2] as bigint).toString(),
    expiry: Number(provider[3]),
    active: Boolean(provider[4]),
  };
}

// Standing board: turn Float from a demo into a queryable layer. Derives the
// set of agents that have a line (the seeded pair plus anyone seen in receipts),
// reads each line, and labels it Lab / Invited / Self-test / Demo so the mix is honest at a
// glance. Signed usage is counted separately in sourceBreakdown.externalSigned.
async function buildStandingBoard(
  client: FloatReadClient,
  cfg: FloatConfig,
  logs: Array<{ args: Record<string, unknown> }>,
) {
  const seen = new Map<string, Address>();
  const add = (value?: string) => {
    if (value && isAddress(value)) seen.set(value.toLowerCase(), getAddress(value));
  };
  add(cfg.alpha);
  add(cfg.beta);
  for (const agent of cfg.invitedAgents) add(agent);
  for (const agent of cfg.selfTestAgents) add(agent);
  for (const log of logs) add(log.args.agent as string | undefined);
  const agents = [...seen.values()].slice(0, 40);

  const rows = (
    await Promise.all(
      agents.map(async (agent) => {
        try {
          const line = await client.readContract({
            address: cfg.float,
            abi: floatAbi,
            functionName: "lines",
            args: [agent],
          });
          return { agent, line: serializeLine(line as readonly unknown[]) };
        } catch {
          return null;
        }
      }),
    )
  )
    .filter((row): row is { agent: Address; line: ReturnType<typeof serializeLine> } => Boolean(row))
    .filter((row) => String(row.line.wallet).toLowerCase() !== "0x0000000000000000000000000000000000000000")
    .filter((row) => row.line.status !== "REVOKED")
    .map((row) => ({
      agent: row.agent,
      label: agentLabel(row.agent, cfg),
      score: row.line.score,
      status: row.line.status,
      creditLimitUSDC: row.line.creditLimitUSDC,
      availableCreditUSDC: row.line.availableCreditUSDC,
      activeDebtUSDC: row.line.activeDebtUSDC,
      lastReview: row.line.lastReview,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        cmpBig(b.creditLimitUSDC, a.creditLimitUSDC) ||
        cmpBig(a.activeDebtUSDC, b.activeDebtUSDC),
    );

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.label] += 1;
      return acc;
    },
    { lab: 0, invited: 0, "self-test": 0, demo: 0 },
  );

  return {
    generatedAt: Date.now(),
    legend: {
      lab: "Lab agents (Shadow-operated)",
      invited: "Invited builder wallets with a Float line",
      "self-test": "Self-test / reassigned wallets, not counted as external usage",
      demo: "Demo / admin",
    },
    counts,
    agents: rows,
  };
}

function agentLabel(address: string, cfg: FloatConfig): "lab" | "invited" | "self-test" | "demo" {
  const a = address.toLowerCase();
  if (labelSet(process.env.FLOAT_LAB_AGENTS, cfg.alpha).has(a)) return "lab";
  if (labelSet(process.env.FLOAT_DEMO_AGENTS, cfg.beta).has(a)) return "demo";
  if (cfg.selfTestAgents.some((agent) => agent.toLowerCase() === a)) return "self-test";
  return "invited";
}

function labelSet(raw: string | undefined, fallback: string): Set<string> {
  const cleaned = cleanEnv(raw);
  const list = cleaned ? cleaned.split(",") : [fallback];
  return new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function cmpBig(a: string, b: string): number {
  try {
    const A = BigInt(a);
    const B = BigInt(b);
    return A > B ? 1 : A < B ? -1 : 0;
  } catch {
    return 0;
  }
}

function summarizeSources(
  runs: FloatLoopRun[],
  totalProviderPaidUSDC: bigint,
  totalDebtOpenedUSDC: bigint,
  totalBlockedUSDC: bigint,
  totalDeniedUSDC: bigint,
  totalRepaidUSDC: bigint,
  receipts: Array<any> = [],
) {
  const agentLoop = summarizeRunSet(runs.filter((run) => run.source === "agent-loop"));
  const externalSignedRuns = runs.filter((run) => run.source === "external-signed");
  const externalSigned = summarizeRunSet(externalSignedRuns);
  applyExternalRepays(externalSigned, externalSignedRuns, receipts);
  const assisted = summarizeRunSet(runs.filter((run) => run.source === "operator-assisted" || run.source === "external"));
  const knownProviderPaidUSDC =
    agentLoop.providerPaidUSDC + externalSigned.providerPaidUSDC + assisted.providerPaidUSDC;
  const knownDebtOpenedUSDC =
    agentLoop.debtOpenedUSDC + externalSigned.debtOpenedUSDC + assisted.debtOpenedUSDC;
  const knownBlockedUSDC = agentLoop.blockedUSDC + externalSigned.blockedUSDC + assisted.blockedUSDC;
  const knownDeniedUSDC = agentLoop.deniedUSDC + externalSigned.deniedUSDC + assisted.deniedUSDC;
  const knownRepaidUSDC = agentLoop.repaidUSDC + externalSigned.repaidUSDC + assisted.repaidUSDC;
  const demoAdmin = {
    providerPaidUSDC: clampSub(totalProviderPaidUSDC, knownProviderPaidUSDC),
    debtOpenedUSDC: clampSub(totalDebtOpenedUSDC, knownDebtOpenedUSDC),
    blockedUSDC: clampSub(totalBlockedUSDC, knownBlockedUSDC),
    deniedUSDC: clampSub(totalDeniedUSDC, knownDeniedUSDC),
    repaidUSDC: clampSub(totalRepaidUSDC, knownRepaidUSDC),
  };
  return {
    agentLoop: serializeSourceSummary(agentLoop),
    externalSigned: serializeSourceSummary(externalSigned),
    assisted: serializeSourceSummary(assisted),
    demoAdmin: {
      providerPaidUSDC: demoAdmin.providerPaidUSDC.toString(),
      debtOpenedUSDC: demoAdmin.debtOpenedUSDC.toString(),
      blockedUSDC: demoAdmin.blockedUSDC.toString(),
      deniedUSDC: demoAdmin.deniedUSDC.toString(),
      repaidUSDC: demoAdmin.repaidUSDC.toString(),
    },
  };
}

function summarizeRunSet(runs: FloatLoopRun[]) {
  return runs.reduce(
    (acc, run) => {
      const amount = toBigInt(run.amountUSDC);
      acc.cycles += 1;
      if (run.fellBack) acc.fallbacks += 1;
      if (run.outcome === "PAID_BOUND") {
        acc.paidCount += 1;
        acc.providerPaidUSDC += amount;
        acc.debtOpenedUSDC += amount;
      } else if (run.outcome === "PREMIUM_BLOCKED" || run.outcome === "GATE_BLOCKED") {
        acc.blockedCount += 1;
        acc.blockedUSDC += amount;
      } else if (run.outcome === "DENIED") {
        acc.deniedCount += 1;
        acc.deniedUSDC += amount;
      } else if (run.outcome === "REPAID") {
        acc.repaidCount += 1;
        acc.repaidUSDC += amount;
      } else if (run.outcome === "SKIPPED_BY_AGENT" || run.outcome === "SKIPPED_LOW_FUNDS") {
        acc.skipCount += 1;
      } else if (run.outcome === "ERROR") {
        acc.errorCount += 1;
      }
      return acc;
    },
    emptySourceSummary(),
  );
}

function applyExternalRepays(summary: SourceSummaryAcc, runs: FloatLoopRun[], receipts: Array<any>) {
  const externalAgents = new Set(
    runs
      .map((run) => run.agent || run.intent?.agent)
      .filter((agent): agent is string => Boolean(agent))
      .map((agent) => agent.toLowerCase()),
  );
  if (!externalAgents.size) return;

  const repayReceipts = receipts.filter(
    (receipt) => receipt.receiptType === "REPAID" && externalAgents.has(String(receipt.agent || "").toLowerCase()),
  );
  if (!repayReceipts.length) return;

  const repaidUSDC = repayReceipts.reduce((sum, receipt) => sum + toBigInt(receipt.amountUSDC), 0n);
  const closedAgents = new Set(
    repayReceipts
      .filter((receipt) => toBigInt(receipt.debtAfterUSDC) === 0n)
      .map((receipt) => String(receipt.agent || "").toLowerCase()),
  );

  summary.repaidCount = Math.max(summary.repaidCount, repayReceipts.length);
  if (repaidUSDC > summary.repaidUSDC) summary.repaidUSDC = repaidUSDC;
  summary.lifecycleClosedCount = Math.max(summary.lifecycleClosedCount, closedAgents.size);
}

function emptySourceSummary(): SourceSummaryAcc {
  return {
    cycles: 0,
    paidCount: 0,
    blockedCount: 0,
    deniedCount: 0,
    repaidCount: 0,
    skipCount: 0,
    errorCount: 0,
    fallbacks: 0,
    providerPaidUSDC: 0n,
    debtOpenedUSDC: 0n,
    blockedUSDC: 0n,
    deniedUSDC: 0n,
    repaidUSDC: 0n,
    lifecycleClosedCount: 0,
  };
}

type SourceSummaryAcc = {
  cycles: number;
  paidCount: number;
  blockedCount: number;
  deniedCount: number;
  repaidCount: number;
  skipCount: number;
  errorCount: number;
  fallbacks: number;
  providerPaidUSDC: bigint;
  debtOpenedUSDC: bigint;
  blockedUSDC: bigint;
  deniedUSDC: bigint;
  repaidUSDC: bigint;
  lifecycleClosedCount: number;
};

function serializeSourceSummary(summary: SourceSummaryAcc) {
  return {
    cycles: summary.cycles,
    paidCount: summary.paidCount,
    blockedCount: summary.blockedCount,
    deniedCount: summary.deniedCount,
    repaidCount: summary.repaidCount,
    skipCount: summary.skipCount,
    errorCount: summary.errorCount,
    fallbacks: summary.fallbacks,
    providerPaidUSDC: summary.providerPaidUSDC.toString(),
    debtOpenedUSDC: summary.debtOpenedUSDC.toString(),
    blockedUSDC: summary.blockedUSDC.toString(),
    deniedUSDC: summary.deniedUSDC.toString(),
    repaidUSDC: summary.repaidUSDC.toString(),
    lifecycleClosedCount: summary.lifecycleClosedCount,
  };
}

function sourceFloatV2ActivityCheckpoint(): FloatV2ActivityCheckpointRecord {
  return {
    blockNumber: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber,
    checkedAt: FLOAT_V2_ACTIVITY_CHECKPOINT.checkedAt,
    source: "source-checkpoint",
    agents: FLOAT_V2_ACTIVITY_CHECKPOINT.agents.map((entry) => ({
      agent: getAddress(entry.agent),
      signedIntents: entry.signedIntents,
      providerPaidCount: entry.providerPaidCount,
      repaidCount: entry.repaidCount,
      blockedCount: entry.blockedCount,
      providerPaidUSDC: BigInt(entry.providerPaidUSDC),
      repaidUSDC: BigInt(entry.repaidUSDC),
      blockedUSDC: BigInt(entry.blockedUSDC),
      latestTxHash: entry.latestTxHash,
    })),
  };
}

async function readFloatV2ActivityCheckpoint(): Promise<FloatV2ActivityCheckpointRecord> {
  const source = sourceFloatV2ActivityCheckpoint();
  const kv = floatV2KvConfig();
  if (!kv) return source;

  try {
    const response = await fetch(`${kv.url}/get/${encodeURIComponent(FLOAT_V2_ACTIVITY_CACHE_KEY)}`, {
      headers: { authorization: `Bearer ${kv.token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return source;
    const json = (await response.json()) as { result?: string | null };
    if (!json.result) return source;
    const parsed = parseFloatV2ActivityCheckpoint(JSON.parse(json.result));
    if (!parsed || parsed.blockNumber < source.blockNumber) return source;
    return parsed;
  } catch {
    return source;
  }
}

async function writeFloatV2ActivityCheckpoint(latestBlock: bigint, stats: Map<string, FloatV2AgentStats>): Promise<boolean> {
  const kv = floatV2KvConfig();
  if (!kv) return false;

  const agents = FLOAT_V2_TRACKED_EXTERNAL_AGENTS.map((tracked) => {
    const agent = getAddress(tracked.agent);
    const entry = stats.get(agent.toLowerCase());
    if (!entry) throw new Error(`cannot persist missing Float V2 activity for ${agent}`);
    return {
      agent,
      signedIntents: entry.signedIntents,
      providerPaidCount: entry.providerPaidCount,
      repaidCount: entry.repaidCount,
      blockedCount: entry.blockedCount,
      providerPaidUSDC: entry.providerPaidUSDC.toString(),
      repaidUSDC: entry.repaidUSDC.toString(),
      blockedUSDC: entry.blockedUSDC.toString(),
      latestTxHash: entry.latestTxHash,
    };
  });
  const record: SerializedFloatV2ActivityCheckpoint = {
    version: 1,
    blockNumber: latestBlock.toString(),
    checkedAt: new Date().toISOString(),
    agents,
  };

  try {
    const response = await fetch(`${kv.url}/set/${encodeURIComponent(FLOAT_V2_ACTIVITY_CACHE_KEY)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function parseFloatV2ActivityCheckpoint(value: unknown): FloatV2ActivityCheckpointRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SerializedFloatV2ActivityCheckpoint>;
  if (record.version !== 1 || !record.blockNumber || !/^\d+$/.test(record.blockNumber) || !Array.isArray(record.agents)) return null;

  const expectedAgents = new Set(FLOAT_V2_TRACKED_EXTERNAL_AGENTS.map((entry) => getAddress(entry.agent).toLowerCase()));
  const seen = new Set<string>();
  const agents: FloatV2ActivityCheckpointEntry[] = [];
  for (const raw of record.agents) {
    if (!raw || !isAddress(raw.agent)) return null;
    const agent = getAddress(raw.agent);
    const key = agent.toLowerCase();
    if (!expectedAgents.has(key) || seen.has(key)) return null;
    if (
      !isNonNegativeSafeInteger(raw.signedIntents) ||
      !isNonNegativeSafeInteger(raw.providerPaidCount) ||
      !isNonNegativeSafeInteger(raw.repaidCount) ||
      !isNonNegativeSafeInteger(raw.blockedCount) ||
      !isAtomicAmount(raw.providerPaidUSDC) ||
      !isAtomicAmount(raw.repaidUSDC) ||
      !isAtomicAmount(raw.blockedUSDC) ||
      (raw.latestTxHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(raw.latestTxHash))
    ) {
      return null;
    }
    seen.add(key);
    agents.push({
      agent,
      signedIntents: raw.signedIntents,
      providerPaidCount: raw.providerPaidCount,
      repaidCount: raw.repaidCount,
      blockedCount: raw.blockedCount,
      providerPaidUSDC: BigInt(raw.providerPaidUSDC),
      repaidUSDC: BigInt(raw.repaidUSDC),
      blockedUSDC: BigInt(raw.blockedUSDC),
      latestTxHash: raw.latestTxHash,
    });
  }
  if (seen.size !== expectedAgents.size) return null;
  return {
    blockNumber: BigInt(record.blockNumber),
    checkedAt: typeof record.checkedAt === "string" ? record.checkedAt : "unknown",
    source: "kv-checkpoint",
    agents,
  };
}

function floatV2KvConfig(): { url: string; token: string } | null {
  const url = cleanEnv(process.env.KV_REST_API_URL);
  const token = cleanEnv(process.env.KV_REST_API_TOKEN);
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAtomicAmount(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

async function readFloatLoopRuns(): Promise<FloatLoopRun[]> {
  const url = cleanEnv(process.env.KV_REST_API_URL);
  const token = cleanEnv(process.env.KV_REST_API_TOKEN);
  if (!url || !token) return [];
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/get/${encodeURIComponent("float:loop:runs")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const json = (await response.json()) as { result?: string | null };
    if (!json.result) return [];
    const parsed = JSON.parse(json.result) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isFloatRun) : [];
  } catch {
    return [];
  }
}

async function readFloatDeskRuns(): Promise<any[]> {
  const url = cleanEnv(process.env.KV_REST_API_URL);
  const token = cleanEnv(process.env.KV_REST_API_TOKEN);
  if (!url || !token) return [];
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/get/${encodeURIComponent("float:desk:runs")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const json = (await response.json()) as { result?: string | null };
    if (!json.result) return [];
    const parsed = JSON.parse(json.result) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function redactDeskSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactDeskString(value);
  if (Array.isArray(value)) return value.map(redactDeskSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeskSecrets(entry)]));
}

function redactDeskString(value: string): string {
  return value.replace(/(sk-[A-Za-z0-9_-]{12,}|swrm_[A-Za-z0-9_-]+|croo_sk_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/g, "[redacted]");
}

function isFloatRun(value: unknown): value is FloatLoopRun {
  if (!value || typeof value !== "object") return false;
  const source = (value as FloatLoopRun).source;
  return (
    source === "agent-loop" ||
    source === "external-signed" ||
    source === "operator-assisted" ||
    source === "external"
  );
}

function runMatchesFloat(run: FloatLoopRun, currentFloat: Address): boolean {
  return Boolean(run.float && isAddress(run.float) && getAddress(run.float) === currentFloat);
}

function toBigInt(value: unknown): bigint {
  if (!value) return 0n;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return BigInt(value);
    return 0n;
  } catch {
    return 0n;
  }
}

function clampSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

function floatConfigFromEnv(): FloatConfig | null {
  const floatRaw = cleanEnv(process.env.SHADOW_FLOAT || process.env.VITE_SHADOW_FLOAT);
  if (!floatRaw || !isAddress(floatRaw)) return null;
  const usdcRaw = cleanEnv(process.env.ARC_USDC || process.env.VITE_ARC_USDC || DEFAULT_USDC) || DEFAULT_USDC;
  const alphaRaw = cleanEnv(process.env.FLOAT_ALPHA_ADDRESS || process.env.VITE_FLOAT_ALPHA_ADDRESS) || "0xa100000000000000000000000000000000000001";
  const betaRaw = cleanEnv(process.env.FLOAT_BETA_ADDRESS || process.env.VITE_FLOAT_BETA_ADDRESS) || "0xbe7a000000000000000000000000000000000002";
  const providerRaw =
    cleanEnv(process.env.FLOAT_PROVIDER_ADDRESS || process.env.VITE_FLOAT_PROVIDER_ADDRESS) ||
    cleanEnv(process.env.X402_PAY_TO || process.env.VITE_X402_PAY_TO) ||
    "0xf100000000000000000000000000000000000003";
  if (!isAddress(usdcRaw) || !isAddress(alphaRaw) || !isAddress(betaRaw) || !isAddress(providerRaw)) return null;
  return {
    rpcUrl: cleanEnv(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network",
    float: getAddress(floatRaw),
    usdc: getAddress(usdcRaw),
    alpha: getAddress(alphaRaw),
    beta: getAddress(betaRaw),
    provider: getAddress(providerRaw),
    invitedAgents: parseAddressList(
      process.env.FLOAT_INVITED_AGENTS ||
        process.env.VITE_FLOAT_INVITED_AGENTS ||
        process.env.FLOAT_EXTERNAL_AGENTS ||
        process.env.VITE_FLOAT_EXTERNAL_AGENTS,
      DEFAULT_INVITED_AGENTS,
    ),
    selfTestAgents: parseAddressList(
      process.env.FLOAT_SELF_TEST_AGENTS || process.env.VITE_FLOAT_SELF_TEST_AGENTS,
      DEFAULT_SELF_TEST_AGENTS,
    ),
    startBlock: BigInt(cleanEnv(process.env.SHADOW_FLOAT_START_BLOCK || process.env.VITE_SHADOW_FLOAT_START_BLOCK) || "0"),
  };
}

function parseAddressList(raw: string | undefined, fallback: readonly string[] = []): Address[] {
  const values = cleanEnv(raw)?.split(/[,\s]+/) || [...fallback];
  const seen = new Map<string, Address>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!isAddress(trimmed)) continue;
    const address = getAddress(trimmed);
    seen.set(address.toLowerCase(), address);
  }
  return [...seen.values()];
}

function missingEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.SHADOW_FLOAT && !process.env.VITE_SHADOW_FLOAT) missing.push("SHADOW_FLOAT");
  return missing;
}

function cleanEnv(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\\n/g, "").trim();
  return cleaned || undefined;
}

function queryParam(req: VercelLikeRequest, name: string): string | undefined {
  const direct = req.query?.[name];
  if (Array.isArray(direct)) return direct[0];
  if (direct) return direct;
  if (!req.url) return undefined;
  try {
    return new URL(req.url, "http://localhost").searchParams.get(name) || undefined;
  } catch {
    return undefined;
  }
}

function sanitizeError(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg
    .replace(/https?:\/\/[^\s"']+/gi, "[rpc]")
    .replace(/swrm_[a-z0-9]+/gi, "[redacted]");
  msg = (msg.split("\n")[0] || "").slice(0, 200).trim();
  return msg || "Float state unavailable";
}

function arcTestnet(rpcUrl: string) {
  return defineChain({
    id: ARC_CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
