import { getAddress, hashTypedData, recoverTypedDataAddress } from "viem";

// Verify a builder-signed external Float spend. Given a receipt's requestHash,
// this returns the builder's signed intent and signature, recovers the signer,
// and confirms it matches the agent and the on-chain requestHash. So anyone can
// prove the spend was authorized by the builder, even though Shadow submitted
// the transaction.
export const config = { maxDuration: 15 };

const ARC_CHAIN_ID = 5_042_002;

type Req = { method?: string; url?: string; query?: Record<string, string | string[] | undefined> };
type Res = { setHeader(n: string, v: string | number): void; status(c: number): Res; json(b: unknown): void };

type Intent = {
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

type SignedRun = {
  source?: string;
  requestHash?: string;
  signature?: string;
  intent?: Intent;
  x402Hash?: string;
  bindTxHash?: string;
  at?: string;
};

const types = {
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

  const hash = readHash(req);
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    res.status(400).json({ error: "pass ?hash=0x... (the requestHash from a signed external Float receipt)" });
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
      types,
      primaryType: "FloatSpendIntent",
      message,
      signature: match.signature as `0x${string}`,
    });
    const digest = hashTypedData({ domain, types, primaryType: "FloatSpendIntent", message });
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

async function readLoopRuns(): Promise<SignedRun[]> {
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
    return Array.isArray(parsed) ? (parsed as SignedRun[]).filter((r) => r && typeof r === "object") : [];
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
