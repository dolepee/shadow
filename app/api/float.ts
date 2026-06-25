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
} from "viem";

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
  "0x4bDC17682C62E15Cb3296a5aA1D61d456597EBdc",
] as const;
const DEFAULT_SELF_TEST_AGENTS = [
  "0x0C63826eE08aF1f144ec5D84B6c56fe393fE19F5",
  "0xD3eed2f7dcED5fbc96Fb1a0FC058C540D50b4f80",
  "0xa539a18b55e5e3b98892c724f8f75914c0b69942",
] as const;

type VercelLikeRequest = {
  method?: string;
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
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
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
      transport: http(cfg.rpcUrl),
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
    trustBoundary: "operators are owner-approved executors; current scoring evidence is operator-reviewed, not permissionlessly auto-updated",
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
      const rawLogs = await client.getLogs({ address, fromBlock: start, toBlock: end });
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

function toBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
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
