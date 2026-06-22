import { createPublicClient, defineChain, getAddress, http, isAddress, parseAbi } from "viem";

// Composable standing read: any agent or protocol can query a Float line's
// creditworthiness by address. This is the substrate that lets other agents
// plug into Float instead of just watching the demo. No redeploy: it reads the
// contract's existing public lines(address) view.
export const config = { maxDuration: 15 };

const ARC_CHAIN_ID = 5_042_002;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_ALPHA = "0xa100000000000000000000000000000000000001";
const DEFAULT_BETA = "0xbe7a000000000000000000000000000000000002";
const STATUSES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID"];

const floatAbi = parseAbi([
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
]);

type Req = { method?: string; url?: string; query?: Record<string, string | string[] | undefined> };
type Res = { setHeader(n: string, v: string | number): void; status(c: number): Res; json(b: unknown): void };

export default async function handler(req: Req, res: Res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  const address = readAddress(req);
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: "pass ?address=0x... (the agent address whose Float standing you want)" });
    return;
  }

  const floatRaw = clean(process.env.SHADOW_FLOAT || process.env.VITE_SHADOW_FLOAT);
  if (!floatRaw || !isAddress(floatRaw)) {
    res.status(200).json({ configured: false, testnet: true, network: "arc-testnet" });
    return;
  }
  const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";

  try {
    const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) });
    const line = await client.readContract({
      address: getAddress(floatRaw),
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
      float: getAddress(floatRaw),
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
        ? "Standing is behavior-backed: the Shadow operator grants and adjusts the line from observed on-chain behavior."
        : "No Float line for this address yet. Behavior earns a line; it is not self-claimed.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ configured: true, degraded: true, error: sanitize(error) });
  }
}

function labelFor(address: string): "lab" | "external" | "demo" {
  const a = address.toLowerCase();
  const lab = parseSet(process.env.FLOAT_LAB_AGENTS, [DEFAULT_ALPHA]);
  const demo = parseSet(process.env.FLOAT_DEMO_AGENTS, [DEFAULT_BETA]);
  if (lab.has(a)) return "lab";
  if (demo.has(a)) return "demo";
  return "external";
}

function parseSet(raw: string | undefined, fallback: string[]): Set<string> {
  const cleaned = clean(raw);
  const list = cleaned ? cleaned.split(",") : fallback;
  return new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function readAddress(req: Req): string | undefined {
  const q = req.query?.address;
  if (typeof q === "string") return q;
  if (Array.isArray(q) && q.length) return q[0];
  if (req.url) {
    try {
      return new URL(req.url, "http://local").searchParams.get("address") || undefined;
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
