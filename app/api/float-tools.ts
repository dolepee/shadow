import {
  createPublicClient,
  defineChain,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  stringToBytes,
} from "viem";

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

type LoopRun = {
  source?: string;
  requestHash?: string;
  rationalePreimage?: string;
  rationale?: string;
  action?: string;
  outcome?: string;
  model?: string;
  at?: string;
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
  nonce: string;
  expiry: string;
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
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
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

  res.status(400).json({
    error: "pass ?action=agent|rationale|verify",
    examples: [
      "/api/float-tools?action=agent&address=0x...",
      "/api/float-tools?action=rationale&hash=0x...",
      "/api/float-tools?action=verify&hash=0x...",
    ],
  });
}

async function handleAgent(req: Req, res: Res) {
  const address = readParam(req, "address");
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: "pass ?action=agent&address=0x... (the agent address whose Float standing you want)" });
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

async function handleRationale(req: Req, res: Res) {
  const hash = readHash(req);
  if (!hash) {
    res.status(400).json({ error: "pass ?action=rationale&hash=0x... (the requestHash from a Float receipt)" });
    return;
  }

  const runs = await readLoopRuns();
  const match = runs.find((r) => (r.requestHash || "").toLowerCase() === hash.toLowerCase());
  if (!match || !match.rationalePreimage) {
    res.status(200).json({
      found: false,
      requestHash: hash,
      note: "No published rationale preimage for this requestHash. Admin/demo actions and receipts predating re-hashable rationale will not have one.",
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

  const runs = await readLoopRuns();
  const match = runs.find((r) => r.source === "external-signed" && (r.requestHash || "").toLowerCase() === hash.toLowerCase());
  if (!match || !match.intent || !match.signature) {
    res.status(200).json({
      found: false,
      requestHash: hash,
      note: "No signed external intent for this requestHash. Lab-loop and requestSpend receipts are not signed-intent spends.",
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
  const message = {
    agent: getAddress(intent.agent),
    provider: getAddress(intent.provider),
    endpointHash: intent.endpointHash as `0x${string}`,
    amountUSDC: BigInt(intent.amountUSDC),
    nonce: BigInt(intent.nonce),
    expiry: BigInt(intent.expiry),
    reason: intent.reason,
  };

  try {
    const recovered = await recoverTypedDataAddress({
      domain,
      types: intentTypes,
      primaryType: "FloatSpendIntent",
      message,
      signature: match.signature as `0x${string}`,
    });
    const digest = hashTypedData({ domain, types: intentTypes, primaryType: "FloatSpendIntent", message });
    res.status(200).json({
      found: true,
      requestHash: hash,
      recoveredSigner: recovered,
      agent: getAddress(intent.agent),
      signerMatchesAgent: getAddress(recovered) === getAddress(intent.agent),
      digestMatchesRequestHash: digest.toLowerCase() === hash.toLowerCase(),
      intent,
      signature: match.signature,
      x402Hash: match.x402Hash,
      bindTxHash: match.bindTxHash,
      note: "Recompute: hashTypedData(intent) must equal requestHash, and recoverTypedDataAddress(intent, signature) must equal agent. Both true means the builder authorized this exact spend.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.status(200).json({ found: true, requestHash: hash, error: String((error as Error)?.message || error).slice(0, 200) });
  }
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

function labelFor(address: string): "lab" | "invited" | "demo" {
  const a = address.toLowerCase();
  const lab = parseSet(process.env.FLOAT_LAB_AGENTS, [DEFAULT_ALPHA]);
  const demo = parseSet(process.env.FLOAT_DEMO_AGENTS, [DEFAULT_BETA]);
  if (lab.has(a)) return "lab";
  if (demo.has(a)) return "demo";
  return "invited";
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
