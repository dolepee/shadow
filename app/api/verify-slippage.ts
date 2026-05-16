import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

export const config = { maxDuration: 30 };

const FOLLOWER_A = "0x495cb55E288E9105E3b3080F2A7323F870538695" as Address;
const FOLLOWER_B = "0x7A3FFC0294f21E040b2bEa3e5Aad33cA08B33AcD" as Address;
const FOLLOWER_A_MIN_BPS = 10000n;
const FOLLOWER_B_MIN_BPS = 9000n;
const BPS = 10000n;
const MIRROR_FEE_BPS = 10n;
const COOLDOWN_MS = 60_000;

const STATUS_LABEL = ["COPIED", "BLOCKED"];
const REASON_LABEL = [
  "none",
  "not following",
  "insufficient balance",
  "amount too high",
  "daily cap exceeded",
  "asset not allowed",
  "unsupported AMM asset",
  "risk too high",
  "intent expired",
  "slippage too tight",
];

const routerAbi = parseAbi([
  "function publishIntent((address asset, uint256 amountUSDC, uint256 minAmountOut, uint8 riskLevel, uint256 expiry, bytes32 intentHash) intent) returns (uint256)",
  "function followerBalanceUSDC(address) view returns (uint256)",
  "function getPolicy(address follower, address sourceAgent) view returns (uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut, uint256 spentToday, uint64 day, bool active)",
]);

const ammAbi = parseAbi([
  "function quoteUSDCForAsset(uint256 usdcAmountIn) view returns (uint256)",
]);

const mirrorReceiptEvent = parseAbiItem(
  "event MirrorReceipt(uint256 indexed intentId, address indexed follower, address indexed sourceAgent, uint8 status, uint8 reason, uint256 usdcAmount, uint256 mirrorFeeUSDC, uint256 assetAmountOut)",
);

type VerifyResult = {
  ok: boolean;
  tx: `0x${string}`;
  blockNumber: string;
  amountUSDC: string;
  liveQuote: string;
  minAmountOut: string;
  scaledMinA: string;
  scaledMinB: string;
  followerA: {
    address: Address;
    status: string;
    reason: string;
    usdcAmount: string;
    mirrorFee: string;
    assetOut: string;
  };
  followerB: {
    address: Address;
    status: string;
    reason: string;
    usdcAmount: string;
    mirrorFee: string;
    assetOut: string;
  };
};

let lastRun: { at: number; result: VerifyResult } | null = null;
let inFlight: Promise<VerifyResult> | null = null;

export default async function handler(req: { method?: string }, res: VercelLikeResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method && req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const now = Date.now();
  if (lastRun && now - lastRun.at < COOLDOWN_MS) {
    const retryAfter = Math.ceil((COOLDOWN_MS - (now - lastRun.at)) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(200).json({
      cached: true,
      retryAfter,
      ...lastRun.result,
    });
    return;
  }

  try {
    if (!inFlight) {
      inFlight = runVerify().finally(() => {
        inFlight = null;
      });
    }
    const result = await inFlight;
    lastRun = { at: Date.now(), result };
    res.status(200).json({ cached: false, retryAfter: 0, ...result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function runVerify(): Promise<VerifyResult> {
  const rpcUrl = requireEnv("ARC_RPC_URL");
  const router = requireEnv("SHADOW_ROUTER") as `0x${string}`;
  const arceth = requireEnv("SHADOW_ARCETH") as `0x${string}`;
  const amm = requireEnv("SHADOW_AMM") as `0x${string}`;
  const key = normalizeKey(requireEnv("CAT_AGENT_PRIVATE_KEY"));

  const arcTestnet = defineChain({
    id: 5_042_002,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(key);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport });

  const [balanceA, balanceB, policyA, policyB] = await Promise.all([
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "followerBalanceUSDC", args: [FOLLOWER_A] }),
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "followerBalanceUSDC", args: [FOLLOWER_B] }),
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "getPolicy", args: [FOLLOWER_A, account.address] }),
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "getPolicy", args: [FOLLOWER_B, account.address] }),
  ]);

  if (!policyA[7] || !policyB[7]) {
    throw new Error(`Followers not seeded against ${account.address}.`);
  }

  const remainingA = policyA[1] > policyA[5] ? policyA[1] - policyA[5] : 0n;
  const remainingB = policyB[1] > policyB[5] ? policyB[1] - policyB[5] : 0n;
  const affordableA = (balanceA * BPS) / (BPS + MIRROR_FEE_BPS);
  const affordableB = (balanceB * BPS) / (BPS + MIRROR_FEE_BPS);
  const cap = bigMin([policyA[0], policyB[0], affordableA, affordableB, remainingA, remainingB]);

  if (cap === 0n) {
    throw new Error(
      `Follower headroom exhausted. balanceA=${formatUSDC(balanceA)} balanceB=${formatUSDC(balanceB)} remainingA=${formatUSDC(remainingA)} remainingB=${formatUSDC(remainingB)}.`,
    );
  }

  const targetAmount = parseUnits("0.1", 6);
  const amountUSDC = cap > targetAmount ? targetAmount : cap;
  const liveQuote = (await publicClient.readContract({
    address: amm,
    abi: ammAbi,
    functionName: "quoteUSDCForAsset",
    args: [amountUSDC],
  })) as bigint;
  const minAmountOut = (liveQuote * 105n) / 100n;
  const scaledMinA = (minAmountOut * FOLLOWER_A_MIN_BPS) / BPS;
  const scaledMinB = (minAmountOut * FOLLOWER_B_MIN_BPS) / BPS;

  if (scaledMinA <= liveQuote) {
    throw new Error("math drift: follower A scaled min not above live quote");
  }
  if (scaledMinB > liveQuote) {
    throw new Error("math drift: follower B scaled min above live quote");
  }

  const intentHash = keccak256(
    encodePacked(["string", "uint256"], ["shadow-verify-button", BigInt(Date.now())]),
  );

  const tx = await walletClient.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "publishIntent",
    args: [
      {
        asset: arceth,
        amountUSDC,
        minAmountOut,
        riskLevel: 2,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        intentHash,
      },
    ],
  });

  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: tx });

  const receipts = await publicClient.getLogs({
    address: router,
    event: mirrorReceiptEvent,
    blockHash: txReceipt.blockHash,
  });
  const intentReceipts = receipts.filter((log) => log.transactionHash === tx);

  const aLog = intentReceipts.find((log) => (log.args.follower ?? "").toLowerCase() === FOLLOWER_A.toLowerCase());
  const bLog = intentReceipts.find((log) => (log.args.follower ?? "").toLowerCase() === FOLLOWER_B.toLowerCase());

  if (!aLog || !bLog) {
    throw new Error("did not find MirrorReceipt for both followers");
  }

  const aStatus = Number(aLog.args.status);
  const aReason = Number(aLog.args.reason);
  const bStatus = Number(bLog.args.status);
  const bReason = Number(bLog.args.reason);
  const ok = aStatus === 1 && aReason === 9 && bStatus === 0;

  return {
    ok,
    tx,
    blockNumber: txReceipt.blockNumber.toString(),
    amountUSDC: formatUSDC(amountUSDC),
    liveQuote: formatAsset(liveQuote),
    minAmountOut: formatAsset(minAmountOut),
    scaledMinA: formatAsset(scaledMinA),
    scaledMinB: formatAsset(scaledMinB),
    followerA: {
      address: FOLLOWER_A,
      status: STATUS_LABEL[aStatus],
      reason: REASON_LABEL[aReason],
      usdcAmount: formatUSDC(aLog.args.usdcAmount as bigint),
      mirrorFee: formatUSDC(aLog.args.mirrorFeeUSDC as bigint),
      assetOut: formatAsset(aLog.args.assetAmountOut as bigint),
    },
    followerB: {
      address: FOLLOWER_B,
      status: STATUS_LABEL[bStatus],
      reason: REASON_LABEL[bReason],
      usdcAmount: formatUSDC(bLog.args.usdcAmount as bigint),
      mirrorFee: formatUSDC(bLog.args.mirrorFeeUSDC as bigint),
      assetOut: formatAsset(bLog.args.assetAmountOut as bigint),
    },
  };
}

function bigMin(values: bigint[]): bigint {
  return values.reduce((min, v) => (v < min ? v : min));
}

function formatUSDC(value: bigint): string {
  return Number(formatUnits(value, 6)).toFixed(6);
}

function formatAsset(value: bigint): string {
  return Number(formatUnits(value, 18)).toFixed(6);
}

function normalizeKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};
