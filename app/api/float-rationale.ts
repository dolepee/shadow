import { keccak256, stringToBytes } from "viem";

// Re-hashable rationale: the loop sets the on-chain requestHash to
// keccak256(rationale preimage) and publishes the preimage here, so anyone can
// re-hash it and confirm the on-chain commitment to the agent's reasoning.
// This is the glass-box bar with no contract change.
export const config = { maxDuration: 15 };

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
};

export default async function handler(req: Req, res: Res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  const hash = readHash(req);
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    res.status(400).json({ error: "pass ?hash=0x... (the requestHash from a Float receipt)" });
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

function readHash(req: Req): string | undefined {
  const q = req.query?.hash;
  if (typeof q === "string") return q;
  if (Array.isArray(q) && q.length) return q[0];
  if (req.url) {
    try {
      return new URL(req.url, "http://local").searchParams.get("hash") || undefined;
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
