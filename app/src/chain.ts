import {
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "USDC",
    symbol: "USDC",
  },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ARC_RPC_URL || "http://127.0.0.1:8545"],
    },
  },
});

export const addresses = {
  usdc: readAddress("VITE_ARC_USDC", "0x3600000000000000000000000000000000000000"),
  arceth: readAddress("VITE_SHADOW_ARCETH"),
  amm: readAddress("VITE_SHADOW_AMM"),
  registry: readAddress("VITE_SHADOW_REGISTRY"),
  router: readAddress("VITE_SHADOW_ROUTER"),
};

export const startBlock = BigInt(import.meta.env.VITE_SHADOW_START_BLOCK || 0);

export const arcExplorerUrl = "https://testnet.arcscan.app";

export function txUrl(hash: `0x${string}`): string {
  return `${arcExplorerUrl}/tx/${hash}`;
}

export const isConfigured = Boolean(addresses.arceth && addresses.amm && addresses.registry && addresses.router);

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(import.meta.env.VITE_ARC_RPC_URL || "http://127.0.0.1:8545"),
});

export const registryAbi = parseAbi([
  "function sourceCount() view returns (uint256)",
  "function sourceList(uint256) view returns (address)",
  "function sources(address) view returns (address agent, string name, string metadataURI, uint16 reputationScore, address erc8004Registry, uint256 erc8004TokenId, bool registered)",
  "function registerSource(address agent, string name, string metadataURI, uint16 reputationScore, address erc8004Registry, uint256 erc8004TokenId)",
]);

export const routerAbi = parseAbi([
  "function followerBalanceUSDC(address) view returns (uint256)",
  "function followerCount(address sourceAgent) view returns (uint256)",
  "function followSource(address sourceAgent, uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
  "function unfollowSource(address sourceAgent)",
  "function depositUSDC(uint256 amountUSDC)",
  "function withdrawUSDC(uint256 amountUSDC)",
  "function closePosition(uint256 intentId) returns (uint256 usdcOut, int256 pnlBps)",
  "function publishIntent((address asset, uint256 amountUSDC, uint256 minAmountOut, uint8 riskLevel, uint256 expiry, bytes32 intentHash) intent) returns (uint256)",
  "function nextIntentId() view returns (uint256)",
  "function protocolFeesUSDC() view returns (uint256)",
  "function sourceKickbackUSDC(address) view returns (uint256)",
  "function getPolicy(address follower, address sourceAgent) view returns (uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut, uint256 spentToday, uint64 day, bool active)",
]);

export const ammAbi = parseAbi([
  "function reserveUSDC() view returns (uint256)",
  "function reserveAsset() view returns (uint256)",
  "function quoteUSDCForAsset(uint256 usdcAmountIn) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const intentPublishedEvent = parseAbiItem(
  "event IntentPublished(uint256 indexed intentId, address indexed sourceAgent, address indexed asset, uint256 amountUSDC, uint8 riskLevel, bytes32 intentHash)",
);

const mirrorReceiptEvent = parseAbiItem(
  "event MirrorReceipt(uint256 indexed intentId, address indexed follower, address indexed sourceAgent, uint8 status, uint8 reason, uint256 usdcAmount, uint256 mirrorFeeUSDC, uint256 assetAmountOut)",
);

const positionClosedEvent = parseAbiItem(
  "event PositionClosed(uint256 indexed intentId, address indexed follower, address indexed sourceAgent, uint256 usdcIn, uint256 usdcOut, int256 pnlBps)",
);

const LOG_CHUNK_SIZE = 90_000n;

function logRanges(fromBlock: bigint, toBlock: bigint): { fromBlock: bigint; toBlock: bigint }[] {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = cursor + LOG_CHUNK_SIZE - 1n;
    const end = chunkEnd < toBlock ? chunkEnd : toBlock;
    ranges.push({ fromBlock: cursor, toBlock: end });
    cursor = end + 1n;
  }
  return ranges;
}

export type SourceAgent = {
  address: Address;
  name: string;
  metadataURI: string;
  reputationScore: number;
  erc8004Registry: Address;
  erc8004TokenId: bigint;
  followerCount: bigint;
  kickbackUSDC: bigint;
};

export type IntentLog = {
  intentId: bigint;
  sourceAgent: Address;
  asset: Address;
  amountUSDC: bigint;
  riskLevel: number;
  intentHash: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
};

export type ReceiptLog = {
  intentId: bigint;
  follower: Address;
  sourceAgent: Address;
  status: "copied" | "blocked";
  reason: string;
  usdcAmount: bigint;
  mirrorFeeUSDC: bigint;
  assetAmountOut: bigint;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
};

export type PositionCloseLog = {
  intentId: bigint;
  follower: Address;
  sourceAgent: Address;
  usdcIn: bigint;
  usdcOut: bigint;
  pnlBps: bigint;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
};

export type ShadowState = {
  sources: SourceAgent[];
  intents: IntentLog[];
  receipts: ReceiptLog[];
  positionCloses: PositionCloseLog[];
  reserves: {
    usdc: bigint;
    asset: bigint;
  };
  quoteForOneUSDC: bigint;
  nextIntentId: bigint;
  protocolFeesUSDC: bigint;
  latestBlock: bigint;
  fetchedAt: number;
};

type SerializedShadowState = {
  configured?: boolean;
  fetchedAt?: number;
  latestBlock?: string;
  sources?: Array<{
    address: Address;
    name: string;
    metadataURI: string;
    reputationScore: number;
    erc8004Registry: Address;
    erc8004TokenId: string;
    followerCount: string;
    kickbackUSDC: string;
  }>;
  intents?: Array<{
    intentId: string;
    sourceAgent: Address;
    asset: Address;
    amountUSDC: string;
    riskLevel: number;
    intentHash: `0x${string}`;
    transactionHash: `0x${string}`;
    blockNumber: string;
  }>;
  receipts?: Array<{
    intentId: string;
    follower: Address;
    sourceAgent: Address;
    status: "copied" | "blocked";
    reason: string;
    usdcAmount: string;
    mirrorFeeUSDC: string;
    assetAmountOut: string;
    transactionHash: `0x${string}`;
    blockNumber: string;
  }>;
  positionCloses?: Array<{
    intentId: string;
    follower: Address;
    sourceAgent: Address;
    usdcIn: string;
    usdcOut: string;
    pnlBps: string;
    transactionHash: `0x${string}`;
    blockNumber: string;
  }>;
  reserves?: { usdc: string; asset: string };
  quoteForOneUSDC?: string;
  nextIntentId?: string;
  protocolFeesUSDC?: string;
};

export async function fetchShadowState(client: PublicClient = publicClient): Promise<ShadowState> {
  if (client === publicClient && typeof window !== "undefined" && typeof fetch === "function") {
    try {
      const response = await fetch("/api/state");
      if (response.ok) {
        return hydrateShadowState((await response.json()) as SerializedShadowState);
      }
    } catch {
      // Fall back to direct RPC reads if the cached API is unavailable locally.
    }
  }

  if (!isConfigured) {
    return {
      sources: [],
      intents: [],
      receipts: [],
      positionCloses: [],
      reserves: { usdc: 0n, asset: 0n },
      quoteForOneUSDC: 0n,
      nextIntentId: 1n,
      protocolFeesUSDC: 0n,
      latestBlock: 0n,
      fetchedAt: Date.now(),
    };
  }

  const sourceCount = await client.readContract({
    address: addresses.registry!,
    abi: registryAbi,
    functionName: "sourceCount",
  });

  const sourceAddresses = await Promise.all(
    Array.from({ length: Number(sourceCount) }, (_, index) =>
      client.readContract({
        address: addresses.registry!,
        abi: registryAbi,
        functionName: "sourceList",
        args: [BigInt(index)],
      }),
    ),
  );

  const sources = await Promise.all(
    sourceAddresses.map(async (sourceAddress) => {
      const [source, followerCount, kickbackUSDC] = await Promise.all([
        client.readContract({
          address: addresses.registry!,
          abi: registryAbi,
          functionName: "sources",
          args: [sourceAddress],
        }),
        client.readContract({
          address: addresses.router!,
          abi: routerAbi,
          functionName: "followerCount",
          args: [sourceAddress],
        }),
        client.readContract({
          address: addresses.router!,
          abi: routerAbi,
          functionName: "sourceKickbackUSDC",
          args: [sourceAddress],
        }),
      ]);

      return {
        address: source[0],
        name: source[1],
        metadataURI: source[2],
        reputationScore: Number(source[3]),
        erc8004Registry: source[4],
        erc8004TokenId: source[5],
        followerCount,
        kickbackUSDC,
      };
    }),
  );

  const [reserveUSDC, reserveAsset, quoteForOneUSDC, nextIntentId, protocolFeesUSDC, latestBlock] = await Promise.all([
    client.readContract({
      address: addresses.amm!,
      abi: ammAbi,
      functionName: "reserveUSDC",
    }),
    client.readContract({
      address: addresses.amm!,
      abi: ammAbi,
      functionName: "reserveAsset",
    }),
    client.readContract({
      address: addresses.amm!,
      abi: ammAbi,
      functionName: "quoteUSDCForAsset",
      args: [1_000_000n],
    }),
    client.readContract({
      address: addresses.router!,
      abi: routerAbi,
      functionName: "nextIntentId",
    }),
    client.readContract({
      address: addresses.router!,
      abi: routerAbi,
      functionName: "protocolFeesUSDC",
    }),
    client.getBlockNumber(),
  ]);

  const ranges = logRanges(startBlock, latestBlock);
  const [intentChunks, receiptChunks, closeChunks] = await Promise.all([
    Promise.all(
      ranges.map((range) =>
        client.getLogs({
          address: addresses.router!,
          event: intentPublishedEvent,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }),
      ),
    ),
    Promise.all(
      ranges.map((range) =>
        client.getLogs({
          address: addresses.router!,
          event: mirrorReceiptEvent,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }),
      ),
    ),
    Promise.all(
      ranges.map((range) =>
        client.getLogs({
          address: addresses.router!,
          event: positionClosedEvent,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }),
      ),
    ),
  ]);
  const intentLogs = intentChunks.flat();
  const receiptLogs = receiptChunks.flat();
  const closeLogs = closeChunks.flat();

  return {
    sources,
    intents: intentLogs.map((log) => ({
      intentId: log.args.intentId!,
      sourceAgent: log.args.sourceAgent!,
      asset: log.args.asset!,
      amountUSDC: log.args.amountUSDC!,
      riskLevel: Number(log.args.riskLevel!),
      intentHash: log.args.intentHash!,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
    })),
    receipts: receiptLogs.map((log) => ({
      intentId: log.args.intentId!,
      follower: log.args.follower!,
      sourceAgent: log.args.sourceAgent!,
      status: log.args.status === 0 ? "copied" : "blocked",
      reason: blockReasonLabel(Number(log.args.reason!)),
      usdcAmount: log.args.usdcAmount!,
      mirrorFeeUSDC: log.args.mirrorFeeUSDC!,
      assetAmountOut: log.args.assetAmountOut!,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
    })),
    positionCloses: closeLogs.map((log) => ({
      intentId: log.args.intentId!,
      follower: log.args.follower!,
      sourceAgent: log.args.sourceAgent!,
      usdcIn: log.args.usdcIn!,
      usdcOut: log.args.usdcOut!,
      pnlBps: log.args.pnlBps!,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
    })),
    reserves: {
      usdc: reserveUSDC,
      asset: reserveAsset,
    },
    quoteForOneUSDC,
    nextIntentId,
    protocolFeesUSDC,
    latestBlock,
    fetchedAt: Date.now(),
  };
}

function hydrateShadowState(data: SerializedShadowState): ShadowState {
  return {
    sources: (data.sources || []).map((source) => ({
      ...source,
      erc8004TokenId: BigInt(source.erc8004TokenId),
      followerCount: BigInt(source.followerCount),
      kickbackUSDC: BigInt(source.kickbackUSDC),
    })),
    intents: (data.intents || []).map((intent) => ({
      ...intent,
      intentId: BigInt(intent.intentId),
      amountUSDC: BigInt(intent.amountUSDC),
      blockNumber: BigInt(intent.blockNumber),
    })),
    receipts: (data.receipts || []).map((receipt) => ({
      ...receipt,
      intentId: BigInt(receipt.intentId),
      usdcAmount: BigInt(receipt.usdcAmount),
      mirrorFeeUSDC: BigInt(receipt.mirrorFeeUSDC),
      assetAmountOut: BigInt(receipt.assetAmountOut),
      blockNumber: BigInt(receipt.blockNumber),
    })),
    positionCloses: (data.positionCloses || []).map((close) => ({
      ...close,
      intentId: BigInt(close.intentId),
      usdcIn: BigInt(close.usdcIn),
      usdcOut: BigInt(close.usdcOut),
      pnlBps: BigInt(close.pnlBps),
      blockNumber: BigInt(close.blockNumber),
    })),
    reserves: {
      usdc: BigInt(data.reserves?.usdc || "0"),
      asset: BigInt(data.reserves?.asset || "0"),
    },
    quoteForOneUSDC: BigInt(data.quoteForOneUSDC || "0"),
    nextIntentId: BigInt(data.nextIntentId || "1"),
    protocolFeesUSDC: BigInt(data.protocolFeesUSDC || "0"),
    latestBlock: BigInt(data.latestBlock || "0"),
    fetchedAt: data.fetchedAt || Date.now(),
  };
}

export function formatUSDC(value: bigint): string {
  return Number(formatUnits(value, 6)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

export function formatAsset(value: bigint): string {
  return Number(formatUnits(value, 18)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

export function shortAddress(value?: string): string {
  if (!value) return "not set";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function blockReasonLabel(reason: number): string {
  const labels = [
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
  return labels[reason] || `reason ${reason}`;
}

function readAddress(key: string, fallback?: string): Address | undefined {
  const value = import.meta.env[key] || fallback;
  return value && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value as Address) : undefined;
}

export type EarnedReputation = {
  source: SourceAgent;
  intentsPublished: number;
  copyCount: number;
  blockCount: number;
  copyRateBps: number;
  routedUSDC: bigint;
  mirrorFeesUSDC: bigint;
  closedCount: number;
  realizedPnlAvgBps: number | null;
};

// Earned reputation is what the source has actually done on-chain: how many
// intents it published, how often followers copied vs blocked, USDC routed
// through it, fees its activity generated, and the average realized PnL of
// closed positions. All of these are derivable from logs already loaded in
// ShadowState, so this is a pure aggregation.
export function computeEarnedReputation(state: ShadowState): EarnedReputation[] {
  return state.sources
    .map((source) => {
      const key = source.address.toLowerCase();
      const intentsPublished = state.intents.filter(
        (intent) => intent.sourceAgent.toLowerCase() === key,
      ).length;
      const sourceReceipts = state.receipts.filter(
        (receipt) => receipt.sourceAgent.toLowerCase() === key,
      );
      const copies = sourceReceipts.filter((r) => r.status === "copied");
      const blocks = sourceReceipts.filter((r) => r.status === "blocked");
      const routedUSDC = copies.reduce((sum, r) => sum + r.usdcAmount, 0n);
      const mirrorFeesUSDC = copies.reduce((sum, r) => sum + r.mirrorFeeUSDC, 0n);

      const total = copies.length + blocks.length;
      const copyRateBps = total === 0 ? 0 : Math.round((copies.length / total) * 10_000);

      const closes = state.positionCloses.filter(
        (close) => close.sourceAgent.toLowerCase() === key,
      );
      const realizedPnlAvgBps =
        closes.length === 0
          ? null
          : Number(closes.reduce((sum, c) => sum + c.pnlBps, 0n)) / closes.length;

      return {
        source,
        intentsPublished,
        copyCount: copies.length,
        blockCount: blocks.length,
        copyRateBps,
        routedUSDC,
        mirrorFeesUSDC,
        closedCount: closes.length,
        realizedPnlAvgBps,
      };
    })
    .sort((a, b) => {
      // Rank by mirror fees earned (best proxy for "followers actually trusted this
      // source enough to copy"), then by intents published as a tiebreak.
      if (b.mirrorFeesUSDC !== a.mirrorFeesUSDC) {
        return b.mirrorFeesUSDC > a.mirrorFeesUSDC ? 1 : -1;
      }
      return b.intentsPublished - a.intentsPublished;
    });
}
