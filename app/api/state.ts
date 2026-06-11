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
} from "../src/lifetimeSnapshot";

export const config = { maxDuration: 20 };

// Cache the heavy log scans for 20s. Browser polls are typically every 30s, so
// most requests hit the cache; the underlying RPC sees one read per source per
// 20s window regardless of how many viewers are loaded.
const CACHE_KEY = "state:cache:v2";
const CACHE_TTL_SECONDS = 20;
const LOG_CHUNK_SIZE = 90_000n;
// The Canteen Arc RPC is a pruning node: getLogs against blocks older than its
// retention window fails with "pruned history unavailable". Cap historical scans
// to a recent window and let pruned ranges degrade to empty so /api/state never
// 500s on pruning. Live view reads (sources, follower counts, reserves, totals)
// are current-state reads and stay accurate regardless.
const SAFE_LOG_LOOKBACK = BigInt(process.env.SHADOW_LOG_LOOKBACK || "750000");

type KVConfig = { url: string; token: string };

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

const registryAbi = parseAbi([
  "function sourceCount() view returns (uint256)",
  "function sourceList(uint256) view returns (address)",
  "function sources(address) view returns (address agent, string name, string metadataURI, uint16 reputationScore, address erc8004Registry, uint256 erc8004TokenId, bool registered)",
]);

const routerAbi = parseAbi([
  "function followerCount(address sourceAgent) view returns (uint256)",
  "function sourceKickbackUSDC(address) view returns (uint256)",
  "function nextIntentId() view returns (uint256)",
  "function protocolFeesUSDC() view returns (uint256)",
]);

const ammAbi = parseAbi([
  "function reserveUSDC() view returns (uint256)",
  "function reserveAsset() view returns (uint256)",
  "function quoteUSDCForAsset(uint256 usdcAmountIn) view returns (uint256)",
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

const REASON_LABELS = [
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

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Content-Type", "application/json");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  const force = readQueryParam(req, "force") === "1";
  const kv = kvConfigFromEnv();

  try {
    if (!force && kv) {
      const cached = await kvGet<CachedState>(kv, CACHE_KEY);
      if (cached) {
        const ageSec = Math.max(0, Math.floor((Date.now() - cached.fetchedAt) / 1000));
        res.setHeader("Cache-Control", `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`);
        res.status(200).json({ source: "cache", ageSec, ...cached });
        return;
      }
    }

    const fresh = await fetchSerializedState();

    if (kv) {
      // Best-effort write; never block the response on a cache miss.
      kvSet(kv, CACHE_KEY, fresh, CACHE_TTL_SECONDS).catch((err) => {
        console.warn(`kv set failed: ${(err as Error).message}`);
      });
    }

    res.setHeader("Cache-Control", `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=60`);
    res.status(200).json({ source: "live", ageSec: 0, ...fresh });
  } catch (error) {
    // Last-ditch: serve any cached snapshot rather than erroring, and never leak
    // RPC URLs/tokens or request bodies in the public response.
    if (kv) {
      try {
        const cached = await kvGet<CachedState>(kv, CACHE_KEY);
        if (cached) {
          const ageSec = Math.max(0, Math.floor((Date.now() - cached.fetchedAt) / 1000));
          res.setHeader("Cache-Control", "no-store");
          res.status(200).json({ source: "stale-cache", ageSec, ...cached });
          return;
        }
      } catch {
        // ignore and fall through to the sanitized error
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: sanitizeError(error), degraded: true });
  }
}

// Collapse upstream errors to a short, single line with no RPC URL, swarm token,
// or request body, so the public error response can never leak the endpoint.
function sanitizeError(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg
    .replace(/https?:\/\/[^\s"']+/gi, "[rpc]")
    .replace(/swrm_[a-z0-9]+/gi, "[redacted]");
  msg = (msg.split("\n")[0] || "").slice(0, 200).trim();
  return msg || "upstream RPC unavailable";
}

type CachedState = {
  configured: boolean;
  fetchedAt: number;
  latestBlock: string;
  historyTruncated: boolean;
  lifetime: LifetimeTotals;
  recentWindow: RecentWindowTotals;
  sources: Array<{
    address: Address;
    name: string;
    metadataURI: string;
    reputationScore: number;
    erc8004Registry: Address;
    erc8004TokenId: string;
    followerCount: string;
    kickbackUSDC: string;
  }>;
  intents: Array<{
    intentId: string;
    sourceAgent: Address;
    asset: Address;
    amountUSDC: string;
    riskLevel: number;
    intentHash: `0x${string}`;
    transactionHash: `0x${string}`;
    blockNumber: string;
  }>;
  receipts: Array<{
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
  positionCloses: Array<{
    intentId: string;
    follower: Address;
    sourceAgent: Address;
    usdcIn: string;
    usdcOut: string;
    pnlBps: string;
    transactionHash: `0x${string}`;
    blockNumber: string;
  }>;
  follows: Array<{
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
  reserves: { usdc: string; asset: string };
  quoteForOneUSDC: string;
  nextIntentId: string;
  protocolFeesUSDC: string;
};

async function fetchSerializedState(): Promise<CachedState> {
  const rpcUrl = requireEnv("ARC_RPC_URL");
  const router = requireEnv("SHADOW_ROUTER") as Address;
  const amm = requireEnv("SHADOW_AMM") as Address;
  const registry = requireEnv("SHADOW_REGISTRY") as Address;
  const startBlock = BigInt(process.env.SHADOW_START_BLOCK || process.env.VITE_SHADOW_START_BLOCK || "0");

  const arcTestnet = defineChain({
    id: 5_042_002,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) }) as unknown as PublicClient;

  const sourceCount = await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "sourceCount",
  });

  const sourceAddresses = (await Promise.all(
    Array.from({ length: Number(sourceCount) }, (_, i) =>
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "sourceList",
        args: [BigInt(i)],
      }),
    ),
  )) as Address[];

  const sources = await Promise.all(
    sourceAddresses.map(async (addr) => {
      const [src, fc, kb] = await Promise.all([
        client.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "sources",
          args: [addr],
        }),
        client.readContract({
          address: router,
          abi: routerAbi,
          functionName: "followerCount",
          args: [addr],
        }),
        client.readContract({
          address: router,
          abi: routerAbi,
          functionName: "sourceKickbackUSDC",
          args: [addr],
        }),
      ]);
      return {
        address: src[0] as Address,
        name: src[1] as string,
        metadataURI: src[2] as string,
        reputationScore: Number(src[3]),
        erc8004Registry: src[4] as Address,
        erc8004TokenId: (src[5] as bigint).toString(),
        followerCount: (fc as bigint).toString(),
        kickbackUSDC: (kb as bigint).toString(),
      };
    }),
  );

  const [reserveUSDC, reserveAsset, quoteForOneUSDC, nextIntentId, protocolFeesUSDC, latestBlock] = await Promise.all([
    client.readContract({ address: amm, abi: ammAbi, functionName: "reserveUSDC" }),
    client.readContract({ address: amm, abi: ammAbi, functionName: "reserveAsset" }),
    client.readContract({ address: amm, abi: ammAbi, functionName: "quoteUSDCForAsset", args: [1_000_000n] }),
    client.readContract({ address: router, abi: routerAbi, functionName: "nextIntentId" }),
    client.readContract({ address: router, abi: routerAbi, functionName: "protocolFeesUSDC" }),
    client.getBlockNumber(),
  ]);

  // Start no earlier than the node's retention window, and let any pruned/failed
  // range degrade to an empty slice instead of throwing the whole request.
  const effectiveFrom =
    latestBlock > startBlock + SAFE_LOG_LOOKBACK ? latestBlock - SAFE_LOG_LOOKBACK : startBlock;
  const historyTruncated = effectiveFrom > startBlock;
  const ranges = logRanges(effectiveFrom, latestBlock);
  const [intentChunks, receiptChunks, closeChunks, followChunks] = await Promise.all([
    Promise.all(
      ranges.map((r) =>
        client.getLogs({ address: router, event: intentPublishedEvent, fromBlock: r.fromBlock, toBlock: r.toBlock }).catch(() => []),
      ),
    ),
    Promise.all(
      ranges.map((r) =>
        client.getLogs({ address: router, event: mirrorReceiptEvent, fromBlock: r.fromBlock, toBlock: r.toBlock }).catch(() => []),
      ),
    ),
    Promise.all(
      ranges.map((r) =>
        client.getLogs({ address: router, event: positionClosedEvent, fromBlock: r.fromBlock, toBlock: r.toBlock }).catch(() => []),
      ),
    ),
    Promise.all(
      ranges.map((r) =>
        client.getLogs({ address: router, event: followedEvent, fromBlock: r.fromBlock, toBlock: r.toBlock }).catch(() => []),
      ),
    ),
  ]);

  const intents = intentChunks.flat().map((log) => ({
    intentId: log.args.intentId!.toString(),
    sourceAgent: log.args.sourceAgent! as Address,
    asset: log.args.asset! as Address,
    amountUSDC: log.args.amountUSDC!.toString(),
    riskLevel: Number(log.args.riskLevel!),
    intentHash: log.args.intentHash! as `0x${string}`,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
  }));
  const receipts = receiptChunks.flat().map((log) => ({
    intentId: log.args.intentId!.toString(),
    follower: log.args.follower! as Address,
    sourceAgent: log.args.sourceAgent! as Address,
    status: log.args.status === 0 ? ("copied" as const) : ("blocked" as const),
    reason: REASON_LABELS[Number(log.args.reason!)] ?? `reason ${log.args.reason}`,
    usdcAmount: log.args.usdcAmount!.toString(),
    mirrorFeeUSDC: log.args.mirrorFeeUSDC!.toString(),
    assetAmountOut: log.args.assetAmountOut!.toString(),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
  }));
  const positionCloses = closeChunks.flat().map((log) => ({
    intentId: log.args.intentId!.toString(),
    follower: log.args.follower! as Address,
    sourceAgent: log.args.sourceAgent! as Address,
    usdcIn: log.args.usdcIn!.toString(),
    usdcOut: log.args.usdcOut!.toString(),
    pnlBps: log.args.pnlBps!.toString(),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
  }));
  const follows = followChunks.flat().map((log) => ({
    follower: log.args.follower! as Address,
    sourceAgent: log.args.sourceAgent! as Address,
    maxAmountPerIntent: log.args.maxAmountPerIntent!.toString(),
    dailyCap: log.args.dailyCap!.toString(),
    allowedAsset: log.args.allowedAsset! as Address,
    maxRiskLevel: Number(log.args.maxRiskLevel!),
    minBpsOut: Number(log.args.minBpsOut!),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
  }));
  const recentWindow = summarizeRecentWindow({
    fromBlock: effectiveFrom.toString(),
    toBlock: latestBlock.toString(),
    historyTruncated,
    receipts,
    positionCloses,
    follows,
    sourceAgents: sources.length,
  });

  return {
    configured: true,
    fetchedAt: Date.now(),
    latestBlock: latestBlock.toString(),
    historyTruncated,
    lifetime: applyLifetimeFloor({
      receipts,
      positionCloses,
      sourceAgents: sources.length,
    }),
    recentWindow,
    sources,
    intents,
    receipts,
    positionCloses,
    follows,
    reserves: { usdc: (reserveUSDC as bigint).toString(), asset: (reserveAsset as bigint).toString() },
    quoteForOneUSDC: (quoteForOneUSDC as bigint).toString(),
    nextIntentId: (nextIntentId as bigint).toString(),
    protocolFeesUSDC: (protocolFeesUSDC as bigint).toString(),
  };
}

type SerializedReceipt = CachedState["receipts"][number];
type SerializedClose = CachedState["positionCloses"][number];
type SerializedFollow = CachedState["follows"][number];

function summarizeRecentWindow(input: {
  fromBlock: string;
  toBlock: string;
  historyTruncated: boolean;
  receipts: SerializedReceipt[];
  positionCloses: SerializedClose[];
  follows: SerializedFollow[];
  sourceAgents: number;
}): RecentWindowTotals {
  const copied = input.receipts.filter((r) => r.status === "copied");
  const blocked = input.receipts.length - copied.length;
  const followerWallets = new Set(input.follows.map((f) => f.follower.toLowerCase())).size;
  const mirroredUsdcAtomic = copied.reduce((sum, receipt) => sum + BigInt(receipt.usdcAmount), 0n);
  return {
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    historyTruncated: input.historyTruncated,
    followerWallets,
    receipts: input.receipts.length,
    copied: copied.length,
    blocked,
    closedPositions: input.positionCloses.length,
    mirroredUsdc: formatUsdc(mirroredUsdcAtomic),
    mirroredUsdcAtomic: mirroredUsdcAtomic.toString(),
    sourceAgents: input.sourceAgents,
  };
}

function applyLifetimeFloor(input: {
  receipts: SerializedReceipt[];
  positionCloses: SerializedClose[];
  sourceAgents: number;
}): LifetimeTotals {
  const snapshotBlock = BigInt(LIFETIME_SNAPSHOT_FLOOR.snapshotBlock);
  const receiptsAfterSnapshot = input.receipts.filter((r) => BigInt(r.blockNumber) > snapshotBlock);
  const copiedAfterSnapshot = receiptsAfterSnapshot.filter((r) => r.status === "copied");
  const blockedAfterSnapshot = receiptsAfterSnapshot.length - copiedAfterSnapshot.length;
  const closesAfterSnapshot = input.positionCloses.filter((c) => BigInt(c.blockNumber) > snapshotBlock);
  const mirroredDelta = copiedAfterSnapshot.reduce((sum, receipt) => sum + BigInt(receipt.usdcAmount), 0n);
  const mirroredUsdcAtomic = BigInt(LIFETIME_SNAPSHOT_FLOOR.mirroredUsdcAtomic) + mirroredDelta;
  return {
    snapshotAt: LIFETIME_SNAPSHOT_FLOOR.snapshotAt,
    snapshotBlock: LIFETIME_SNAPSHOT_FLOOR.snapshotBlock,
    followerWallets: LIFETIME_SNAPSHOT_FLOOR.followerWallets,
    receipts: LIFETIME_SNAPSHOT_FLOOR.receipts + receiptsAfterSnapshot.length,
    copied: LIFETIME_SNAPSHOT_FLOOR.copied + copiedAfterSnapshot.length,
    blocked: LIFETIME_SNAPSHOT_FLOOR.blocked + blockedAfterSnapshot,
    closedPositions: LIFETIME_SNAPSHOT_FLOOR.closedPositions + closesAfterSnapshot.length,
    mirroredUsdc: formatUsdc(mirroredUsdcAtomic),
    mirroredUsdcAtomic: mirroredUsdcAtomic.toString(),
    sourceAgents: Math.max(LIFETIME_SNAPSHOT_FLOOR.sourceAgents, input.sourceAgents),
  };
}

function formatUsdc(value: bigint): string {
  return formatUnits(value, 6);
}

function logRanges(from: bigint, to: bigint) {
  const out: { fromBlock: bigint; toBlock: bigint }[] = [];
  let cur = from;
  while (cur <= to) {
    const end = cur + LOG_CHUNK_SIZE - 1n;
    out.push({ fromBlock: cur, toBlock: end < to ? end : to });
    cur = end + 1n;
  }
  return out;
}

function kvConfigFromEnv(): KVConfig | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function kvGet<T>(kv: KVConfig, key: string): Promise<T | null> {
  const res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) {
    throw new Error(`kv get failed status=${res.status} body=${await res.text()}`);
  }
  const json = (await res.json()) as { result: string | null };
  if (json.result === null || json.result === undefined) return null;
  try {
    return JSON.parse(json.result) as T;
  } catch {
    return json.result as unknown as T;
  }
}

async function kvSet(kv: KVConfig, key: string, value: unknown, ttlSec: number): Promise<void> {
  const body = JSON.stringify(value);
  const res = await fetch(`${kv.url}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`kv set failed status=${res.status} body=${await res.text()}`);
  }
}

function readQueryParam(req: VercelLikeRequest, name: string): string | null {
  const fromQuery = req.query?.[name];
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  if (req.url) {
    try {
      const u = new URL(req.url, "http://localhost");
      const v = u.searchParams.get(name);
      if (v) return v;
    } catch {
      // ignore
    }
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

// Suppress unused warnings if formatUnits is dropped during edits.
export const _unused = { formatUnits };
