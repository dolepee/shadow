import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";

export const config = { maxDuration: 20 };

const ARC_CHAIN_ID = 5_042_002;
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const LOG_LOOKBACK = BigInt(process.env.FLOAT_LOG_LOOKBACK || "250000");

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
  startBlock: bigint;
};

const floatAbi = parseAbi([
  "function receiptCount() view returns (uint256)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalProviderPaidUSDC() view returns (uint256)",
  "function totalDebtOpenedUSDC() view returns (uint256)",
  "function totalBlockedUSDC() view returns (uint256)",
  "function totalDeniedUSDC() view returns (uint256)",
  "function totalRepaidUSDC() view returns (uint256)",
  "function lastChecksum() view returns (bytes32)",
  "function providerMandates(address provider) view returns (bytes32 endpointHash, uint256 maxPerRequestUSDC, uint256 dailyLimitUSDC, uint64 expiry, bool active)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
]);

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
];

const STATUSES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID"];

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
      lastChecksum,
      alphaLine,
      betaLine,
      providerMandate,
      latestBlock,
    ] = await Promise.all([
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "receiptCount" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "treasuryBalanceUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalProviderPaidUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalDebtOpenedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalBlockedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalDeniedUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "totalRepaidUSDC" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "lastChecksum" }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "lines", args: [cfg.alpha] }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "lines", args: [cfg.beta] }),
      client.readContract({ address: cfg.float, abi: floatAbi, functionName: "providerMandates", args: [cfg.provider] }),
      client.getBlockNumber(),
    ]);

    const fromBlock = cfg.startBlock > 0n ? cfg.startBlock : latestBlock > LOG_LOOKBACK ? latestBlock - LOG_LOOKBACK : 0n;
    const [logs, x402Logs] = await Promise.all([
      client
        .getLogs({
          address: cfg.float,
          event: floatReceiptEvent,
          fromBlock,
          toBlock: latestBlock,
        })
        .catch(() => []),
      client
        .getLogs({
          address: cfg.float,
          event: x402PaymentBoundEvent,
          fromBlock,
          toBlock: latestBlock,
        })
        .catch(() => []),
    ]);
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
      lastChecksum,
      alphaLine: serializeLine(alphaLine),
      betaLine: serializeLine(betaLine),
      providerMandate: serializeProvider(providerMandate),
      receipts: logs
        .slice()
        .sort((a, b) => Number(b.args.receiptId! - a.args.receiptId!))
        .slice(0, 30)
        .map((log) => {
          const x402 = x402ByRequest.get(log.args.requestHash);
          return {
            receiptId: log.args.receiptId!.toString(),
            receiptHash: log.args.receiptHash,
            receiptType: RECEIPT_TYPES[Number(log.args.receiptType)] || `TYPE_${log.args.receiptType}`,
            agent: log.args.agent,
            provider: log.args.provider,
            endpointHash: log.args.endpointHash,
            amountUSDC: log.args.amountUSDC!.toString(),
            amountFormatted: formatUnits(log.args.amountUSDC!, 6),
            creditBeforeUSDC: log.args.creditBeforeUSDC!.toString(),
            creditAfterUSDC: log.args.creditAfterUSDC!.toString(),
            debtBeforeUSDC: log.args.debtBeforeUSDC!.toString(),
            debtAfterUSDC: log.args.debtAfterUSDC!.toString(),
            reason: REASONS[Number(log.args.reason)] || `REASON_${log.args.reason}`,
            mandateId: log.args.mandateId,
            requestHash: log.args.requestHash,
            prevChecksum: log.args.prevChecksum,
            checksum: log.args.checksum,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
            x402,
          };
        }),
      latestBlock: latestBlock.toString(),
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ configured: true, degraded: true, error: sanitizeError(error) });
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
    startBlock: BigInt(cleanEnv(process.env.SHADOW_FLOAT_START_BLOCK || process.env.VITE_SHADOW_FLOAT_START_BLOCK) || "0"),
  };
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
