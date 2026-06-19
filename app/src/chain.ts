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
import {
  LIFETIME_SNAPSHOT_FLOOR,
  type LifetimeTotals,
  type RecentWindowTotals,
} from "./lifetimeSnapshot";

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
  pilotAttestor: readAddress("VITE_SHADOW_PILOT_ATTESTOR"),
};

export const leptonAddresses = {
  mandateRegistry: readAddress("VITE_SHADOW_MANDATE_REGISTRY", "0x394b6955162ce147e813e0eea6104cd1164e3d33"),
  mandateAttestor: readAddress("VITE_SHADOW_MANDATE_ATTESTOR", "0x440ef290d63174182c6115b4356727e0ac136d48"),
  bondedEnforcer: readAddress("VITE_SHADOW_BONDED_ENFORCER", "0x05a11588155c6bde55bb7b3986f200ca556b23cc"),
  v4StyleAdapter: readAddress("VITE_SHADOW_V4_STYLE_ADAPTER", "0x16ebc65c9f3188734277c9fafd73d9f13b93d868"),
};

export const startBlock = BigInt(import.meta.env.VITE_SHADOW_START_BLOCK || 0);

export const arcExplorerUrl = "https://testnet.arcscan.app";

export function txUrl(hash: `0x${string}`): string {
  return `${arcExplorerUrl}/tx/${hash}`;
}

export const isConfigured = Boolean(addresses.arceth && addresses.amm && addresses.registry && addresses.router);

export const isLeptonConfigured = Boolean(
  leptonAddresses.mandateRegistry &&
    leptonAddresses.mandateAttestor &&
    leptonAddresses.bondedEnforcer &&
    leptonAddresses.v4StyleAdapter,
);

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

export const pilotAttestorAbi = parseAbi([
  "function attest(bytes32 decisionHash, uint256 totalUSDC, uint8 sliceCount, uint16 confidenceBps, bytes32 modelHash)",
  "function attestationCount() view returns (uint256)",
  "function attestationsByFollower(address) view returns (uint256)",
]);

export const mandateRegistryAbi = parseAbi([
  "function nextMandateId() view returns (uint256)",
  "function getMandateSpend(uint256 mandateId) view returns (uint256 spentToday, uint64 day)",
  "function getMandateAccounts(uint256 mandateId) view returns (address mandateOwner, address circleAccount, address requiredSettlementAsset, address allowedTarget)",
]);

export const mandateAttestorAbi = parseAbi([
  "function nextReceiptId() view returns (uint256)",
  "function receiptCount() view returns (uint256)",
  "function receiptByActionHash(bytes32 actionHash) view returns (bytes32)",
]);

export const bondedMandateEnforcerAbi = parseAbi([
  "function minBondUSDC() view returns (uint256)",
  "function bondUSDC(address enforcer) view returns (uint256)",
]);

export const v4StyleArcAdapterAbi = parseAbi([
  "function adapterBondUSDC() view returns (uint256)",
  "function executedUSDC() view returns (uint256)",
  "function blockedUSDC() view returns (uint256)",
  "function liquiditySink() view returns (address)",
]);

export const mandateVaultSinkAbi = parseAbi([
  "function totalDepositedUSDC() view returns (uint256)",
  "function adapter() view returns (address)",
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

const followedEvent = parseAbiItem(
  "event Followed(address indexed follower, address indexed sourceAgent, uint256 maxAmountPerIntent, uint256 dailyCap, address indexed allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
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
  gatewaySettlement?: GatewaySettlementSummary;
};

export type GatewaySettlementSummary = {
  feeAtomic: string;
  feeUSDC: string;
  gatewayBatchId: string | null;
  gatewayTx: string | null;
  payer: string | null;
  rail: "circle-gateway-x402-batching";
  status: "settled";
  at: string;
  testnet: true;
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

export type FollowLog = {
  follower: Address;
  sourceAgent: Address;
  maxAmountPerIntent: bigint;
  dailyCap: bigint;
  allowedAsset: Address;
  maxRiskLevel: number;
  minBpsOut: number;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
};

export type ShadowState = {
  sources: SourceAgent[];
  intents: IntentLog[];
  receipts: ReceiptLog[];
  positionCloses: PositionCloseLog[];
  follows: FollowLog[];
  reserves: {
    usdc: bigint;
    asset: bigint;
  };
  quoteForOneUSDC: bigint;
  nextIntentId: bigint;
  protocolFeesUSDC: bigint;
  latestBlock: bigint;
  historyTruncated: boolean;
  lifetime: HydratedLifetimeTotals;
  recentWindow: HydratedRecentWindowTotals;
  fetchedAt: number;
};

export type LeptonState = {
  configured: boolean;
  nextMandateId: bigint;
  mandateCount: bigint;
  nextReceiptId: bigint;
  receiptCount: bigint;
  minBondUSDC: bigint;
  adapterBondUSDC: bigint;
  executedUSDC: bigint;
  blockedUSDC: bigint;
  vaultDepositedUSDC?: bigint;
  liquiditySink?: Address;
  fetchedAt: number;
};

export type HydratedLifetimeTotals = Omit<LifetimeTotals, "mirroredUsdcAtomic"> & {
  mirroredUsdcAtomic: bigint;
};

export type HydratedRecentWindowTotals = Omit<RecentWindowTotals, "mirroredUsdcAtomic"> & {
  mirroredUsdcAtomic: bigint;
};

export async function fetchLeptonState(): Promise<LeptonState | null> {
  if (!isLeptonConfigured) return null;

  const [nextMandateId, nextReceiptId, receiptCount, minBondUSDC, adapterBondUSDC, executedUSDC, blockedUSDC, liquiditySink] =
    await Promise.all([
      publicClient.readContract({
        address: leptonAddresses.mandateRegistry!,
        abi: mandateRegistryAbi,
        functionName: "nextMandateId",
      }),
      publicClient.readContract({
        address: leptonAddresses.mandateAttestor!,
        abi: mandateAttestorAbi,
        functionName: "nextReceiptId",
      }),
      publicClient.readContract({
        address: leptonAddresses.mandateAttestor!,
        abi: mandateAttestorAbi,
        functionName: "receiptCount",
      }),
      publicClient.readContract({
        address: leptonAddresses.bondedEnforcer!,
        abi: bondedMandateEnforcerAbi,
        functionName: "minBondUSDC",
      }),
      publicClient.readContract({
        address: leptonAddresses.v4StyleAdapter!,
        abi: v4StyleArcAdapterAbi,
        functionName: "adapterBondUSDC",
      }),
      publicClient.readContract({
        address: leptonAddresses.v4StyleAdapter!,
        abi: v4StyleArcAdapterAbi,
        functionName: "executedUSDC",
      }),
      publicClient.readContract({
        address: leptonAddresses.v4StyleAdapter!,
        abi: v4StyleArcAdapterAbi,
        functionName: "blockedUSDC",
      }),
      publicClient.readContract({
        address: leptonAddresses.v4StyleAdapter!,
        abi: v4StyleArcAdapterAbi,
        functionName: "liquiditySink",
      }),
    ]);
  const vaultDepositedUSDC = await publicClient
    .readContract({
      address: liquiditySink,
      abi: mandateVaultSinkAbi,
      functionName: "totalDepositedUSDC",
    })
    .catch(() => undefined);

  return {
    configured: true,
    nextMandateId,
    mandateCount: nextMandateId > 0n ? nextMandateId - 1n : 0n,
    nextReceiptId,
    receiptCount,
    minBondUSDC,
    adapterBondUSDC,
    executedUSDC,
    blockedUSDC,
    vaultDepositedUSDC,
    liquiditySink,
    fetchedAt: Date.now(),
  };
}

type SerializedShadowState = {
  configured?: boolean;
  fetchedAt?: number;
  latestBlock?: string;
  historyTruncated?: boolean;
  lifetime?: LifetimeTotals;
  recentWindow?: RecentWindowTotals;
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
    gatewaySettlement?: GatewaySettlementSummary;
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
  follows?: Array<{
    follower: Address;
    sourceAgent: Address;
    maxAmountPerIntent: string;
    dailyCap: string;
    allowedAsset: Address;
    maxRiskLevel: number;
    minBpsOut: number;
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
      follows: [],
      reserves: { usdc: 0n, asset: 0n },
      quoteForOneUSDC: 0n,
      nextIntentId: 1n,
      protocolFeesUSDC: 0n,
      latestBlock: 0n,
      historyTruncated: false,
      lifetime: hydrateLifetimeTotals(),
      recentWindow: emptyRecentWindowTotals(),
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
  const [intentChunks, receiptChunks, closeChunks, followChunks] = await Promise.all([
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
    Promise.all(
      ranges.map((range) =>
        client.getLogs({
          address: addresses.router!,
          event: followedEvent,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }),
      ),
    ),
  ]);
  const intentLogs = intentChunks.flat();
  const receiptLogs = receiptChunks.flat();
  const closeLogs = closeChunks.flat();
  const followLogs = followChunks.flat();

  const receipts = receiptLogs.map((log) => ({
    intentId: log.args.intentId!,
    follower: log.args.follower!,
    sourceAgent: log.args.sourceAgent!,
    status: log.args.status === 0 ? ("copied" as const) : ("blocked" as const),
    reason: blockReasonLabel(Number(log.args.reason!)),
    usdcAmount: log.args.usdcAmount!,
    mirrorFeeUSDC: log.args.mirrorFeeUSDC!,
    assetAmountOut: log.args.assetAmountOut!,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
  }));
  const positionCloses = closeLogs.map((log) => ({
    intentId: log.args.intentId!,
    follower: log.args.follower!,
    sourceAgent: log.args.sourceAgent!,
    usdcIn: log.args.usdcIn!,
    usdcOut: log.args.usdcOut!,
    pnlBps: log.args.pnlBps!,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
  }));
  const follows = followLogs.map((log) => ({
    follower: log.args.follower!,
    sourceAgent: log.args.sourceAgent!,
    maxAmountPerIntent: log.args.maxAmountPerIntent!,
    dailyCap: log.args.dailyCap!,
    allowedAsset: log.args.allowedAsset!,
    maxRiskLevel: Number(log.args.maxRiskLevel!),
    minBpsOut: Number(log.args.minBpsOut!),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
  }));

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
    receipts,
    positionCloses,
    follows,
    reserves: {
      usdc: reserveUSDC,
      asset: reserveAsset,
    },
    quoteForOneUSDC,
    nextIntentId,
    protocolFeesUSDC,
    latestBlock,
    historyTruncated: false,
    lifetime: buildLifetimeFromState(receipts, positionCloses, sources.length),
    recentWindow: buildRecentWindowFromState(receipts, positionCloses, follows, sources.length, startBlock, latestBlock, false),
    fetchedAt: Date.now(),
  };
}

function hydrateShadowState(data: SerializedShadowState): ShadowState {
  const receipts = (data.receipts || []).map((receipt) => ({
    ...receipt,
    intentId: BigInt(receipt.intentId),
    usdcAmount: BigInt(receipt.usdcAmount),
    mirrorFeeUSDC: BigInt(receipt.mirrorFeeUSDC),
    assetAmountOut: BigInt(receipt.assetAmountOut),
    blockNumber: BigInt(receipt.blockNumber),
  }));
  const positionCloses = (data.positionCloses || []).map((close) => ({
    ...close,
    intentId: BigInt(close.intentId),
    usdcIn: BigInt(close.usdcIn),
    usdcOut: BigInt(close.usdcOut),
    pnlBps: BigInt(close.pnlBps),
    blockNumber: BigInt(close.blockNumber),
  }));
  const follows = (data.follows || []).map((f) => ({
    ...f,
    maxAmountPerIntent: BigInt(f.maxAmountPerIntent),
    dailyCap: BigInt(f.dailyCap),
    blockNumber: BigInt(f.blockNumber),
  }));
  const sources = (data.sources || []).map((source) => ({
    ...source,
    erc8004TokenId: BigInt(source.erc8004TokenId),
    followerCount: BigInt(source.followerCount),
    kickbackUSDC: BigInt(source.kickbackUSDC),
  }));
  const latestBlock = BigInt(data.latestBlock || "0");
  return {
    sources,
    intents: (data.intents || []).map((intent) => ({
      ...intent,
      intentId: BigInt(intent.intentId),
      amountUSDC: BigInt(intent.amountUSDC),
      blockNumber: BigInt(intent.blockNumber),
    })),
    receipts,
    positionCloses,
    follows,
    reserves: {
      usdc: BigInt(data.reserves?.usdc || "0"),
      asset: BigInt(data.reserves?.asset || "0"),
    },
    quoteForOneUSDC: BigInt(data.quoteForOneUSDC || "0"),
    nextIntentId: BigInt(data.nextIntentId || "1"),
    protocolFeesUSDC: BigInt(data.protocolFeesUSDC || "0"),
    latestBlock,
    historyTruncated: Boolean(data.historyTruncated),
    lifetime: data.lifetime
      ? hydrateLifetimeTotals(data.lifetime)
      : buildLifetimeFromState(receipts, positionCloses, sources.length),
    recentWindow:
      hydrateRecentWindowTotals(data.recentWindow) ??
      buildRecentWindowFromState(receipts, positionCloses, follows, sources.length, 0n, latestBlock, Boolean(data.historyTruncated)),
    fetchedAt: data.fetchedAt || Date.now(),
  };
}

function hydrateLifetimeTotals(totals?: LifetimeTotals): HydratedLifetimeTotals {
  const source = totals ?? LIFETIME_SNAPSHOT_FLOOR;
  return {
    ...source,
    mirroredUsdcAtomic: BigInt(source.mirroredUsdcAtomic),
  };
}

function hydrateRecentWindowTotals(totals?: RecentWindowTotals): HydratedRecentWindowTotals | null {
  if (!totals) return null;
  return {
    ...totals,
    mirroredUsdcAtomic: BigInt(totals.mirroredUsdcAtomic),
  };
}

function emptyRecentWindowTotals(): HydratedRecentWindowTotals {
  return {
    fromBlock: "0",
    toBlock: "0",
    historyTruncated: false,
    followerWallets: 0,
    receipts: 0,
    copied: 0,
    blocked: 0,
    closedPositions: 0,
    mirroredUsdc: "0",
    mirroredUsdcAtomic: 0n,
    sourceAgents: 0,
  };
}

function buildLifetimeFromState(
  receipts: ReceiptLog[],
  positionCloses: PositionCloseLog[],
  sourceAgents: number,
): HydratedLifetimeTotals {
  const snapshotBlock = BigInt(LIFETIME_SNAPSHOT_FLOOR.snapshotBlock);
  const receiptsAfterSnapshot = receipts.filter((r) => r.blockNumber > snapshotBlock);
  const copiedAfterSnapshot = receiptsAfterSnapshot.filter((r) => r.status === "copied");
  const blockedAfterSnapshot = receiptsAfterSnapshot.length - copiedAfterSnapshot.length;
  const closesAfterSnapshot = positionCloses.filter((c) => c.blockNumber > snapshotBlock);
  const mirroredUsdcAtomic =
    BigInt(LIFETIME_SNAPSHOT_FLOOR.mirroredUsdcAtomic) +
    copiedAfterSnapshot.reduce((sum, receipt) => sum + receipt.usdcAmount, 0n);
  return {
    snapshotAt: LIFETIME_SNAPSHOT_FLOOR.snapshotAt,
    snapshotBlock: LIFETIME_SNAPSHOT_FLOOR.snapshotBlock,
    followerWallets: LIFETIME_SNAPSHOT_FLOOR.followerWallets,
    receipts: LIFETIME_SNAPSHOT_FLOOR.receipts + receiptsAfterSnapshot.length,
    copied: LIFETIME_SNAPSHOT_FLOOR.copied + copiedAfterSnapshot.length,
    blocked: LIFETIME_SNAPSHOT_FLOOR.blocked + blockedAfterSnapshot,
    closedPositions: LIFETIME_SNAPSHOT_FLOOR.closedPositions + closesAfterSnapshot.length,
    mirroredUsdc: formatUnits(mirroredUsdcAtomic, 6),
    mirroredUsdcAtomic,
    sourceAgents: Math.max(LIFETIME_SNAPSHOT_FLOOR.sourceAgents, sourceAgents),
  };
}

function buildRecentWindowFromState(
  receipts: ReceiptLog[],
  positionCloses: PositionCloseLog[],
  follows: FollowLog[],
  sourceAgents: number,
  fromBlock: bigint,
  toBlock: bigint,
  historyTruncated: boolean,
): HydratedRecentWindowTotals {
  const copiedReceipts = receipts.filter((r) => r.status === "copied");
  const mirroredUsdcAtomic = copiedReceipts.reduce((sum, receipt) => sum + receipt.usdcAmount, 0n);
  return {
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    historyTruncated,
    followerWallets: new Set(follows.map((f) => f.follower.toLowerCase())).size,
    receipts: receipts.length,
    copied: copiedReceipts.length,
    blocked: receipts.length - copiedReceipts.length,
    closedPositions: positionCloses.length,
    mirroredUsdc: formatUnits(mirroredUsdcAtomic, 6),
    mirroredUsdcAtomic,
    sourceAgents,
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
  const raw = import.meta.env[key] || fallback;
  const value = typeof raw === "string" ? raw.trim() : raw;
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
  lastIntent: IntentLog | null;
};

export type AgentSignal = "healthy" | "watch" | "stop" | "warming";

export type AgentSignalDetail = {
  level: AgentSignal;
  reason: string;
};

// Brutally simple: trust an agent when the router copies its trades and
// realized PnL on closed positions is not deeply negative. Drop trust when
// the router blocks more than half its trades or losses exceed 5%. Pure
// aggregation, no model, no LLM, no off chain truth.
export function agentSignal(row: EarnedReputation): AgentSignalDetail {
  const totalReceipts = row.copyCount + row.blockCount;
  if (row.intentsPublished === 0 || totalReceipts === 0) {
    return { level: "warming", reason: "no follower activity yet" };
  }
  const copyRatePct = row.copyRateBps / 100;
  const pnlPct = row.realizedPnlAvgBps === null ? null : row.realizedPnlAvgBps / 100;

  if (copyRatePct < 25 || (pnlPct !== null && pnlPct < -5)) {
    return {
      level: "stop",
      reason:
        copyRatePct < 25
          ? `policy blocked ${(100 - copyRatePct).toFixed(0)}% of trades`
          : `realized PnL ${pnlPct!.toFixed(2)}% on ${row.closedCount} closes`,
    };
  }
  if (copyRatePct < 50 || (pnlPct !== null && pnlPct < -1)) {
    return {
      level: "watch",
      reason:
        copyRatePct < 50
          ? `copy rate ${copyRatePct.toFixed(0)}%, leaning blocks`
          : `realized PnL ${pnlPct!.toFixed(2)}% on ${row.closedCount} closes`,
    };
  }
  return {
    level: "healthy",
    reason:
      pnlPct === null
        ? `copy rate ${copyRatePct.toFixed(0)}%, no realized PnL yet`
        : `copy rate ${copyRatePct.toFixed(0)}%, PnL ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
  };
}

// Earned reputation is what the source has actually done on-chain: how many
// intents it published, how often followers copied vs blocked, USDC routed
// through it, fees its activity generated, and the average realized PnL of
// closed positions. All of these are derivable from logs already loaded in
// ShadowState, so this is a pure aggregation.
export function computeEarnedReputation(state: ShadowState): EarnedReputation[] {
  return state.sources
    .map((source) => {
      const key = source.address.toLowerCase();
      const ownIntents = state.intents.filter(
        (intent) => intent.sourceAgent.toLowerCase() === key,
      );
      const intentsPublished = ownIntents.length;
      const lastIntent =
        ownIntents.length === 0
          ? null
          : ownIntents.reduce((best, current) =>
              current.blockNumber > best.blockNumber ? current : best,
            );
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
        lastIntent,
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
