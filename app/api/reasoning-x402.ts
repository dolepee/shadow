import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseAbi,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const config = { maxDuration: 20 };

const ARC_CHAIN_ID = 5_042_002;
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const DEFAULT_PRICE_ATOMIC = "1000"; // 0.001 USDC, 6 decimals
const MAX_AUTHORIZATION_SECONDS = 15 * 60;

const usdcEip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

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
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  url?: string;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

type KVConfig = { url: string; token: string };

type PaymentPayload = {
  x402Version?: number;
  scheme?: "exact";
  network?: "arc-testnet";
  payload?: {
    from?: string;
    to?: string;
    value?: string;
    validAfter?: string | number;
    validBefore?: string | number;
    nonce?: string;
    signature?: string;
  };
};

type X402Config = {
  rpcUrl: string;
  usdc: Address;
  payTo: Address;
  priceAtomic: bigint;
  facilitatorKey: Hex;
};

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  const gate = x402ConfigFromEnv();
  const kv = kvConfigFromEnv();
  if (!gate) {
    res.status(503).json({
      error: "x402 gate not configured",
      configured: false,
      missing: ["X402_PAY_TO", "X402_FACILITATOR_PRIVATE_KEY"],
    });
    return;
  }

  const requirements = paymentRequirements(req, gate);
  const paymentHeader = readHeader(req, "x-payment");
  if (!paymentHeader) {
    res.status(402).json({
      x402Version: 1,
      error: "payment required",
      accepts: [requirements],
    });
    return;
  }

  let settled: Awaited<ReturnType<typeof verifyAndSettle>>;
  try {
    settled = await verifyAndSettle(paymentHeader, gate);
  } catch (error) {
    res.status(402).json({
      x402Version: 1,
      error: sanitizeError(error),
      accepts: [requirements],
    });
    return;
  }

  res.setHeader("X-PAYMENT-RESPONSE", encodeHeader(settled));
  if (kv) {
    recordX402Receipt(kv, settled, req).catch((err) => {
      console.warn(`x402 receipt kv write failed: ${(err as Error).message}`);
    });
  }

  try {
    const response = await loadReasoning(req, kv);
    res.status(200).json({ ...response, x402: settled });
  } catch (error) {
    res.status(404).json({
      error: sanitizeError(error),
      x402: settled,
    });
  }
}

// Same hygiene as /api/state: upstream errors can embed the RPC URL
// (including its access token) in the message, so never echo them raw.
function sanitizeError(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg
    .replace(/https?:\/\/[^\s"']+/gi, "[rpc]")
    .replace(/swrm_[a-z0-9]+/gi, "[redacted]");
  msg = (msg.split("\n")[0] || "").slice(0, 200).trim();
  return msg || "payment verification failed";
}

function paymentRequirements(req: VercelLikeRequest, gate: X402Config) {
  return {
    scheme: "exact",
    network: "arc-testnet",
    maxAmountRequired: gate.priceAtomic.toString(),
    resource: process.env.X402_RESOURCE_URL || absoluteUrl(req),
    description: "Read the latest Shadow source-agent reasoning packet",
    mimeType: "application/json",
    payTo: gate.payTo,
    asset: gate.usdc,
    maxTimeoutSeconds: MAX_AUTHORIZATION_SECONDS,
    extra: {
      chainId: ARC_CHAIN_ID,
      decimals: 6,
      eip712: { name: "USDC", version: "2" },
      authorization: "EIP-3009 transferWithAuthorization",
    },
  };
}

async function verifyAndSettle(paymentHeader: string, gate: X402Config) {
  const parsed = parsePaymentHeader(paymentHeader);
  if (parsed.x402Version !== 1 || parsed.scheme !== "exact" || parsed.network !== "arc-testnet") {
    throw new Error("unsupported x402 payment payload");
  }
  const p = parsed.payload;
  if (!p) throw new Error("missing payment payload");
  if (!p.from || !isAddress(p.from)) throw new Error("invalid payment from");
  if (!p.to || !isAddress(p.to)) throw new Error("invalid payment to");
  if (getAddress(p.to) !== gate.payTo) throw new Error("payment destination mismatch");
  if (!p.nonce || !/^0x[a-fA-F0-9]{64}$/.test(p.nonce)) throw new Error("invalid authorization nonce");
  if (!p.signature || !/^0x[a-fA-F0-9]{130}$/.test(p.signature)) throw new Error("invalid authorization signature");

  const value = BigInt(p.value || "0");
  if (value < gate.priceAtomic) throw new Error("payment amount below required price");

  const validAfter = BigInt(p.validAfter || 0);
  const validBefore = BigInt(p.validBefore || 0);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (validAfter > now) throw new Error("payment authorization not valid yet");
  if (validBefore <= now) throw new Error("payment authorization expired");
  if (validBefore - validAfter > BigInt(MAX_AUTHORIZATION_SECONDS)) {
    throw new Error("payment authorization window too long");
  }

  const from = getAddress(p.from);
  const client = publicClient(gate);
  const alreadyUsed = await client.readContract({
    address: gate.usdc,
    abi: usdcEip3009Abi,
    functionName: "authorizationState",
    args: [from, p.nonce as Hex],
  });
  if (alreadyUsed) throw new Error("payment authorization already used");

  const message = {
    from,
    to: gate.payTo,
    value,
    validAfter,
    validBefore,
    nonce: p.nonce as Hex,
  };
  const valid = await verifyTypedData({
    address: from,
    domain: {
      name: "USDC",
      version: "2",
      chainId: ARC_CHAIN_ID,
      verifyingContract: gate.usdc,
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
    signature: p.signature as Hex,
  });
  if (!valid) throw new Error("invalid EIP-3009 signature");

  const sig = splitSignature(p.signature as Hex);
  const account = privateKeyToAccount(gate.facilitatorKey);
  const wallet = createWalletClient({
    account,
    chain: arcTestnet(gate.rpcUrl),
    transport: http(gate.rpcUrl),
  });
  const txHash = await wallet.writeContract({
    address: gate.usdc,
    abi: usdcEip3009Abi,
    functionName: "transferWithAuthorization",
    args: [from, gate.payTo, value, validAfter, validBefore, p.nonce as Hex, sig.v, sig.r, sig.s],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("payment settlement reverted");

  return {
    settled: true,
    chainId: ARC_CHAIN_ID,
    network: "arc-testnet",
    asset: gate.usdc,
    amount: value.toString(),
    payer: from,
    payTo: gate.payTo,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
  };
}

async function loadReasoning(req: VercelLikeRequest, kv: KVConfig | null) {
  if (!kv) {
    return { configured: false, packet: null, latestIntentHash: null };
  }
  let targetHash = readQueryParam(req, "hash");
  const txParam = readQueryParam(req, "tx");
  if (!targetHash && txParam) {
    targetHash = await kvGet<string>(kv, `tx:${txParam.toLowerCase()}:reasoning`);
  }
  if (!targetHash) {
    targetHash = await kvGet<string>(kv, "latestReasoningIntentHash");
  }
  if (!targetHash) {
    return { configured: true, packet: null, latestIntentHash: null };
  }
  const packet = await kvGet<ReasoningPacket>(kv, `reasoning:${targetHash}`);
  if (!packet) {
    throw new Error(`reasoning not found for ${targetHash}`);
  }
  return { configured: true, packet, latestIntentHash: targetHash };
}

function x402ConfigFromEnv(): X402Config | null {
  const payTo = process.env.X402_PAY_TO?.trim();
  const facilitatorKey = process.env.X402_FACILITATOR_PRIVATE_KEY?.trim();
  if (!payTo || !facilitatorKey || !isAddress(payTo) || !/^0x[a-fA-F0-9]{64}$/.test(facilitatorKey)) {
    return null;
  }
  const usdc = process.env.X402_USDC || process.env.ARC_USDC || DEFAULT_USDC;
  if (!isAddress(usdc)) return null;
  return {
    rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
    usdc: getAddress(usdc),
    payTo: getAddress(payTo),
    priceAtomic: BigInt(process.env.X402_REASONING_PRICE_ATOMIC || DEFAULT_PRICE_ATOMIC),
    facilitatorKey: facilitatorKey as Hex,
  };
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

async function recordX402Receipt(kv: KVConfig, settled: { txHash: string }, req: VercelLikeRequest): Promise<void> {
  const body = JSON.stringify({
    ...settled,
    at: new Date().toISOString(),
    hash: readQueryParam(req, "hash"),
    tx: readQueryParam(req, "tx"),
  });
  const res = await fetch(`${kv.url}/set/${encodeURIComponent(`x402:reasoning:${settled.txHash.toLowerCase()}`)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`kv receipt set failed status=${res.status} body=${await res.text()}`);
  }
}

function parsePaymentHeader(header: string): PaymentPayload {
  const raw = header.trim();
  try {
    if (raw.startsWith("{")) return JSON.parse(raw) as PaymentPayload;
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PaymentPayload;
  } catch {
    throw new Error("invalid payment header encoding");
  }
}

function splitSignature(signature: Hex): { r: Hex; s: Hex; v: number } {
  const r = signature.slice(0, 66) as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { r, s, v };
}

function publicClient(gate: X402Config) {
  return createPublicClient({
    chain: arcTestnet(gate.rpcUrl),
    transport: http(gate.rpcUrl),
  });
}

function arcTestnet(rpcUrl: string) {
  return defineChain({
    id: ARC_CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function readHeader(req: VercelLikeRequest, name: string): string | null {
  const headers = req.headers || {};
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(direct)) return direct[0] || null;
  return direct || null;
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

function absoluteUrl(req: VercelLikeRequest): string {
  const host = readHeader(req, "x-forwarded-host") || readHeader(req, "host") || "shadow-arc.vercel.app";
  const proto = readHeader(req, "x-forwarded-proto") || "https";
  return req.url?.startsWith("http") ? req.url : `${proto}://${host}${req.url || "/api/reasoning-x402"}`;
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
