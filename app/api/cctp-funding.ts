import { getAddress, isAddress, type Address, type Hex } from "viem";

export const config = { maxDuration: 20 };

const DEFAULT_IRIS_API = "https://iris-api-sandbox.circle.com";
const DEFAULT_DESTINATION_DOMAIN = 26; // Arc testnet Gateway domain in Circle examples.
const FUNDING_INDEX_KEY = "cctp:funding:index:v1";
const FUNDING_LIMIT = 200;

type VercelLikeRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

type KVConfig = { url: string; token: string };

type FundingRequest = {
  burnTx?: string;
  sourceDomain?: number | string;
  destinationDomain?: number | string;
  follower?: string;
  expectedAmountAtomic?: string;
};

type FundingAck = {
  burnTx: Hex;
  sourceDomain: number;
  destinationDomain: number;
  follower: Address | null;
  expectedAmountAtomic: string | null;
  attestationStatus: string;
  attestation: string | null;
  message: string | null;
  acknowledged: boolean;
  credited: false;
  note: string;
  at: string;
  testnet: true;
};

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (!req.method || req.method === "GET") {
    const kv = kvConfigFromEnv();
    const records = kv ? await kvGet<FundingAck[]>(kv, FUNDING_INDEX_KEY).catch(() => null) : null;
    res.status(200).json({
      configured: true,
      kvConfigured: Boolean(kv),
      testnet: true,
      destinationDomain: DEFAULT_DESTINATION_DOMAIN,
      records: records || [],
      note: "POST burnTx + sourceDomain to verify Circle attestation and acknowledge follower funding. This route does not mint or deposit into Shadow Router.",
    });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed, use GET or POST" });
    return;
  }

  let input: FundingRequest;
  try {
    input = await readBody(req);
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }

  let request: {
    burnTx: Hex;
    sourceDomain: number;
    destinationDomain: number;
    follower: Address | null;
    expectedAmountAtomic: string | null;
  };
  try {
    request = normalizeFundingRequest(input);
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error) });
    return;
  }

  try {
    const attestation = await fetchCctpAttestation(request.sourceDomain, request.burnTx);
    const status = String(attestation.status || attestation.attestationStatus || "unknown");
    const complete = Boolean(attestation.attestation && attestation.message && isCompleteStatus(status));
    const ack: FundingAck = {
      ...request,
      attestationStatus: status,
      attestation: typeof attestation.attestation === "string" ? attestation.attestation : null,
      message: typeof attestation.message === "string" ? attestation.message : null,
      acknowledged: complete,
      credited: false,
      note: complete
        ? "Attestation verified. Funding is acknowledged for the follower; actual Shadow Router credit still requires mint/deposit execution on Arc."
        : "Attestation is not complete yet; poll this route again after Circle finalizes the burn.",
      at: new Date().toISOString(),
      testnet: true,
    };

    const kv = kvConfigFromEnv();
    if (kv) await saveFundingAck(kv, ack).catch(() => undefined);

    res.status(complete ? 200 : 202).json({ funding: ack, raw: slimAttestation(attestation) });
  } catch (error) {
    res.status(502).json({ error: sanitizeError(error), acknowledged: false });
  }
}

async function fetchCctpAttestation(sourceDomain: number, burnTx: Hex): Promise<Record<string, unknown>> {
  const base = (process.env.CCTP_ATTESTATION_API_URL || DEFAULT_IRIS_API).replace(/\/$/, "");
  const url = `${base}/v2/messages/${sourceDomain}?transactionHash=${burnTx}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CCTP attestation lookup failed status=${res.status} body=${await res.text()}`);
  const json = (await res.json()) as Record<string, unknown>;
  const messages = Array.isArray(json.messages) ? (json.messages as Record<string, unknown>[]) : [];
  return messages[0] || json;
}

function normalizeFundingRequest(input: FundingRequest) {
  const burnTx = input.burnTx;
  const sourceDomain = Number(input.sourceDomain);
  const destinationDomain =
    input.destinationDomain === undefined || input.destinationDomain === "" ? DEFAULT_DESTINATION_DOMAIN : Number(input.destinationDomain);
  if (!burnTx || !/^0x[a-fA-F0-9]{64}$/.test(burnTx)) throw new Error("burnTx must be a transaction hash");
  if (!Number.isInteger(sourceDomain) || sourceDomain < 0) throw new Error("sourceDomain must be a non-negative integer");
  if (!Number.isInteger(destinationDomain) || destinationDomain < 0) throw new Error("destinationDomain must be a non-negative integer");
  if (input.follower && !isAddress(input.follower)) throw new Error("follower must be an address");
  if (input.expectedAmountAtomic && !/^\d+$/.test(input.expectedAmountAtomic)) {
    throw new Error("expectedAmountAtomic must be a decimal integer");
  }
  return {
    burnTx: burnTx as Hex,
    sourceDomain,
    destinationDomain,
    follower: input.follower ? getAddress(input.follower) : null,
    expectedAmountAtomic: input.expectedAmountAtomic || null,
  };
}

function isCompleteStatus(status: string): boolean {
  return ["complete", "completed", "attested", "confirmed"].includes(status.toLowerCase());
}

function slimAttestation(raw: Record<string, unknown>) {
  return {
    status: raw.status || raw.attestationStatus || null,
    eventNonce: raw.eventNonce || raw.nonce || null,
    messageHash: raw.messageHash || null,
    hasMessage: typeof raw.message === "string",
    hasAttestation: typeof raw.attestation === "string",
  };
}

async function saveFundingAck(kv: KVConfig, ack: FundingAck) {
  const key = `cctp:funding:${ack.burnTx.toLowerCase()}`;
  const existing = (await kvGet<FundingAck[]>(kv, FUNDING_INDEX_KEY).catch(() => null)) || [];
  await kvSet(kv, key, ack);
  const next = [ack, ...existing.filter((item) => item.burnTx.toLowerCase() !== ack.burnTx.toLowerCase())].slice(0, FUNDING_LIMIT);
  await kvSet(kv, FUNDING_INDEX_KEY, next);
}

async function readBody(req: VercelLikeRequest): Promise<FundingRequest> {
  if (req.body && typeof req.body === "object") return req.body as FundingRequest;
  const readable = req as unknown as AsyncIterable<Buffer>;
  let raw = "";
  for await (const chunk of readable) raw += chunk.toString("utf8");
  return raw ? (JSON.parse(raw) as FundingRequest) : {};
}

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
  if (!res.ok) throw new Error(`kv get failed status=${res.status}`);
  const json = (await res.json()) as { result: string | null };
  if (json.result === null || json.result === undefined) return null;
  try {
    return JSON.parse(json.result) as T;
  } catch {
    return json.result as unknown as T;
  }
}

async function kvSet(kv: KVConfig, key: string, value: unknown): Promise<void> {
  const res = await fetch(`${kv.url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`kv set failed status=${res.status}`);
}

function sanitizeError(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg
    .replace(/https?:\/\/[^\s"']+/gi, "[upstream]")
    .replace(/Bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted]");
  msg = (msg.split("\n")[0] || "").slice(0, 180).trim();
  return msg || "CCTP funding verification unavailable";
}
