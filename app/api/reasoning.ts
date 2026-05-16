export const config = { maxDuration: 10 };

type ReasoningPacket = {
  sourceAgent: string;
  sourceName: string;
  intentHash: string;
  createdAt: number;
  amountUSDC: string;
  minAmountOut: string;
  liveQuote: string;
  reserveUSDC: string;
  reserveAsset: string;
  riskLevel: number;
  confidenceBps: number;
  decision: "publish" | "skip";
  rationale: string;
};

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

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  const kv = kvConfigFromEnv();
  if (!kv) {
    res.status(503).json({ error: "kv not configured", configured: false });
    return;
  }

  const hashParam = readQueryParam(req, "hash");
  const txParam = readQueryParam(req, "tx");

  try {
    let targetHash = hashParam;

    if (!targetHash && txParam) {
      targetHash = await kvGet<string>(kv, `tx:${txParam.toLowerCase()}:reasoning`);
    }

    if (!targetHash) {
      targetHash = await kvGet<string>(kv, "latestReasoningIntentHash");
    }

    if (!targetHash) {
      res.status(200).json({ configured: true, packet: null, latestIntentHash: null });
      return;
    }

    const packet = await kvGet<ReasoningPacket>(kv, `reasoning:${targetHash}`);
    if (!packet) {
      res.status(404).json({ error: "reasoning not found", intentHash: targetHash });
      return;
    }
    res.status(200).json({ configured: true, packet, latestIntentHash: targetHash });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

type KVConfig = { url: string; token: string };

function kvConfigFromEnv(): KVConfig | null {
  const url = process.env.KV_REST_API_URL?.trim();
  const token = process.env.KV_REST_API_TOKEN?.trim();
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
  // Upstash returns the raw stored string; JSON values were stored stringified.
  try {
    return JSON.parse(json.result) as T;
  } catch {
    return json.result as unknown as T;
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
