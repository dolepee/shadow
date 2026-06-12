import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";

export const config = { maxDuration: 30 };

const ARC_CHAIN_ID = 5_042_002;
const ARC_NETWORK = "eip155:5042002";
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";
const DEFAULT_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const DEFAULT_FEE_ATOMIC = "100"; // 0.0001 USDC at 6 decimals.
const SETTLEMENT_INDEX_KEY = "gateway:settlements:index:v1";
const SETTLEMENT_LIMIT = 300;

type VercelLikeRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

type KVConfig = { url: string; token: string };

type SettlementConfig = {
  rpcUrl: string;
  router: Address;
  usdc: Address;
  payTo: Address;
  gatewayWallet: Address;
  feeAtomic: bigint;
  facilitatorUrl?: string;
};

type SettlementRecord = {
  mirrorTx: Hex;
  follower: Address;
  sourceAgent: Address;
  intentId: string;
  feeAtomic: string;
  feeUSDC: string;
  gatewayBatchId: string | null;
  gatewayTx: string | null;
  payer: string | null;
  network: "arc-testnet";
  rail: "circle-gateway-x402-batching";
  status: "settled";
  at: string;
  receiptBlockNumber: string;
  testnet: true;
};

type SettlementRequest = {
  mirrorTx?: string;
  follower?: string;
  sourceAgent?: string;
  intentId?: string | number;
};

type PaymentPayload = {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

const mirrorReceiptEvent = parseAbiItem(
  "event MirrorReceipt(uint256 indexed intentId, address indexed follower, address indexed sourceAgent, uint8 status, uint8 reason, uint256 usdcAmount, uint256 mirrorFeeUSDC, uint256 assetAmountOut)",
);

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");

  if (!req.method || req.method === "GET") {
    await handleGet(res);
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed, use GET or POST" });
    return;
  }

  await handlePost(req, res);
}

async function handleGet(res: VercelLikeResponse) {
  const kv = kvConfigFromEnv();
  const configured = settlementConfigFromEnv();
  const records = kv ? await loadSettlementIndex(kv).catch(() => []) : [];
  res.status(200).json({
    configured: Boolean(configured),
    kvConfigured: Boolean(kv),
    testnet: true,
    network: "arc-testnet",
    rail: "circle-gateway-x402-batching",
    feeAtomic: (configured?.feeAtomic ?? BigInt(process.env.GATEWAY_NANOSETTLEMENT_FEE_ATOMIC || DEFAULT_FEE_ATOMIC)).toString(),
    feeUSDC: formatUnits(configured?.feeAtomic ?? BigInt(process.env.GATEWAY_NANOSETTLEMENT_FEE_ATOMIC || DEFAULT_FEE_ATOMIC), 6),
    records,
    missing: missingSettlementEnv(),
  });
}

async function handlePost(req: VercelLikeRequest, res: VercelLikeResponse) {
  const gate = settlementConfigFromEnv();
  const kv = kvConfigFromEnv();
  if (!gate || !kv) {
    res.status(503).json({
      error: "Gateway nanosettlement not configured",
      configured: false,
      missing: [...missingSettlementEnv(), ...missingKvEnv()],
    });
    return;
  }

  let body: SettlementRequest;
  try {
    body = await readBody(req);
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }

  let target: Required<SettlementRequest> & { mirrorTx: Hex; follower: Address; sourceAgent: Address; intentId: string };
  try {
    target = normalizeSettlementRequest(body);
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error) });
    return;
  }

  let receiptBlockNumber: string;
  try {
    receiptBlockNumber = await assertCopiedMirrorReceipt(gate, target);
  } catch (error) {
    res.status(422).json({ error: sanitizeError(error), charged: false });
    return;
  }

  const existing = await kvGet<SettlementRecord>(kv, settlementRecordKey(target)).catch(() => null);
  if (existing) {
    res.status(200).json({ duplicate: true, settlement: existing });
    return;
  }

  const requirements = paymentRequirements(req, gate, target);
  const paymentSignature = readHeader(req, "payment-signature");
  if (!paymentSignature) {
    res.setHeader("PAYMENT-REQUIRED", encodeHeader({ x402Version: 2, resource: resource(req, target), accepts: [requirements] }));
    res.status(402).json({
      x402Version: 2,
      error: "Gateway payment required",
      accepts: [requirements],
      charged: false,
    });
    return;
  }

  let payload: PaymentPayload;
  try {
    payload = parsePaymentSignature(paymentSignature);
  } catch (error) {
    res.status(402).json({ error: sanitizeError(error), accepts: [requirements], charged: false });
    return;
  }

  try {
    const facilitator = new BatchFacilitatorClient(gate.facilitatorUrl ? { url: gate.facilitatorUrl } : undefined);
    const verifyResult = await facilitator.verify(payload, requirements);
    if (!verifyResult.isValid) {
      throw new Error(verifyResult.invalidReason || "Gateway payment verification failed");
    }

    const settleResult = await facilitator.settle(payload, requirements);
    if (!settleResult.success) {
      throw new Error(settleResult.errorReason || "Gateway settlement failed");
    }

    const gatewayTx = settleResult.transaction || null;
    const record: SettlementRecord = {
      mirrorTx: target.mirrorTx,
      follower: target.follower,
      sourceAgent: target.sourceAgent,
      intentId: target.intentId,
      feeAtomic: gate.feeAtomic.toString(),
      feeUSDC: formatUnits(gate.feeAtomic, 6),
      gatewayBatchId: gatewayTx,
      gatewayTx,
      payer: settleResult.payer || verifyResult.payer || null,
      network: "arc-testnet",
      rail: "circle-gateway-x402-batching",
      status: "settled",
      at: new Date().toISOString(),
      receiptBlockNumber,
      testnet: true,
    };

    await saveSettlement(kv, record);
    res.setHeader("PAYMENT-RESPONSE", encodeHeader({ success: true, transaction: gatewayTx, network: ARC_NETWORK, payer: record.payer }));
    res.status(200).json({ settlement: record });
  } catch (error) {
    res.status(402).json({ error: sanitizeError(error), accepts: [requirements], charged: false });
  }
}

function settlementConfigFromEnv(): SettlementConfig | null {
  const payToRaw = process.env.GATEWAY_SETTLEMENT_PAY_TO || process.env.X402_PAY_TO;
  const routerRaw = process.env.SHADOW_ROUTER;
  if (!payToRaw || !routerRaw || !isAddress(payToRaw) || !isAddress(routerRaw)) return null;
  const usdcRaw = process.env.GATEWAY_USDC || process.env.ARC_USDC || DEFAULT_USDC;
  const gatewayWalletRaw = process.env.GATEWAY_WALLET_ADDRESS || DEFAULT_GATEWAY_WALLET;
  if (!isAddress(usdcRaw) || !isAddress(gatewayWalletRaw)) return null;
  return {
    rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
    router: getAddress(routerRaw),
    usdc: getAddress(usdcRaw),
    payTo: getAddress(payToRaw),
    gatewayWallet: getAddress(gatewayWalletRaw),
    feeAtomic: BigInt(process.env.GATEWAY_NANOSETTLEMENT_FEE_ATOMIC || DEFAULT_FEE_ATOMIC),
    facilitatorUrl: process.env.GATEWAY_FACILITATOR_URL?.trim() || undefined,
  };
}

function missingSettlementEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.GATEWAY_SETTLEMENT_PAY_TO && !process.env.X402_PAY_TO) missing.push("GATEWAY_SETTLEMENT_PAY_TO");
  if (!process.env.SHADOW_ROUTER) missing.push("SHADOW_ROUTER");
  return missing;
}

function missingKvEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.KV_REST_API_URL) missing.push("KV_REST_API_URL");
  if (!process.env.KV_REST_API_TOKEN) missing.push("KV_REST_API_TOKEN");
  return missing;
}

function paymentRequirements(req: VercelLikeRequest, gate: SettlementConfig, target: { mirrorTx: Hex; follower: Address; intentId: string }) {
  return {
    scheme: "exact",
    network: ARC_NETWORK,
    asset: gate.usdc,
    amount: gate.feeAtomic.toString(),
    payTo: gate.payTo,
    maxTimeoutSeconds: 345600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: gate.gatewayWallet,
      receipt: {
        mirrorTx: target.mirrorTx,
        follower: target.follower,
        intentId: target.intentId,
      },
    },
  };
}

function resource(req: VercelLikeRequest, target: { mirrorTx: Hex; follower: Address; intentId: string }) {
  return {
    url: absoluteUrl(req),
    description: `Shadow copied mirror nanosettlement for intent ${target.intentId}`,
    mimeType: "application/json",
  };
}

async function assertCopiedMirrorReceipt(
  gate: SettlementConfig,
  target: { mirrorTx: Hex; follower: Address; sourceAgent: Address; intentId: string },
): Promise<string> {
  const client = createPublicClient({
    chain: defineChain({
      id: ARC_CHAIN_ID,
      name: "Arc Testnet",
      nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
      rpcUrls: { default: { http: [gate.rpcUrl] } },
    }),
    transport: http(gate.rpcUrl),
  });
  const txReceipt = await client.getTransactionReceipt({ hash: target.mirrorTx });
  const logs = parseEventLogs({
    abi: [mirrorReceiptEvent],
    eventName: "MirrorReceipt",
    logs: txReceipt.logs,
    strict: false,
  });
  const match = logs.find((log) => {
    const args = log.args;
    return (
      args.intentId?.toString() === target.intentId &&
      args.follower &&
      getAddress(args.follower) === target.follower &&
      args.sourceAgent &&
      getAddress(args.sourceAgent) === target.sourceAgent
    );
  });
  if (!match) throw new Error("MirrorReceipt not found in mirrorTx");
  if (Number(match.args.status ?? 1) !== 0) throw new Error("blocked mirrors are never charged");
  return txReceipt.blockNumber.toString();
}

function normalizeSettlementRequest(body: SettlementRequest) {
  const mirrorTx = body.mirrorTx;
  const follower = body.follower;
  const sourceAgent = body.sourceAgent;
  const intentId = body.intentId?.toString();
  if (!mirrorTx || !/^0x[a-fA-F0-9]{64}$/.test(mirrorTx)) throw new Error("mirrorTx must be a transaction hash");
  if (!follower || !isAddress(follower)) throw new Error("follower must be an address");
  if (!sourceAgent || !isAddress(sourceAgent)) throw new Error("sourceAgent must be an address");
  if (!intentId || !/^\d+$/.test(intentId)) throw new Error("intentId must be a decimal string");
  return {
    mirrorTx: mirrorTx as Hex,
    follower: getAddress(follower),
    sourceAgent: getAddress(sourceAgent),
    intentId,
  };
}

async function readBody(req: VercelLikeRequest): Promise<SettlementRequest> {
  if (req.body && typeof req.body === "object") return req.body as SettlementRequest;
  const readable = req as unknown as AsyncIterable<Buffer>;
  let raw = "";
  for await (const chunk of readable) raw += chunk.toString("utf8");
  return raw ? (JSON.parse(raw) as SettlementRequest) : {};
}

function parsePaymentSignature(header: string): PaymentPayload {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
  } catch {
    try {
      return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as PaymentPayload;
    } catch {
      throw new Error("invalid payment-signature encoding");
    }
  }
}

async function saveSettlement(kv: KVConfig, record: SettlementRecord) {
  const [existing] = await Promise.all([
    loadSettlementIndex(kv).catch(() => []),
    kvSet(kv, settlementRecordKey(record), record),
  ]);
  const next = [record, ...existing.filter((item) => settlementRecordKey(item) !== settlementRecordKey(record))].slice(0, SETTLEMENT_LIMIT);
  await kvSet(kv, SETTLEMENT_INDEX_KEY, next);
}

async function loadSettlementIndex(kv: KVConfig): Promise<SettlementRecord[]> {
  return (await kvGet<SettlementRecord[]>(kv, SETTLEMENT_INDEX_KEY)) || [];
}

function settlementRecordKey(record: { mirrorTx: string; follower: string; intentId: string }) {
  return `gateway:settlement:${record.mirrorTx.toLowerCase()}:${record.follower.toLowerCase()}:${record.intentId}`;
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

function readHeader(req: VercelLikeRequest, name: string): string | null {
  const headers = req.headers || {};
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(direct)) return direct[0] || null;
  return direct || null;
}

function absoluteUrl(req: VercelLikeRequest): string {
  const host = readHeader(req, "x-forwarded-host") || readHeader(req, "host") || "shadow-arc.vercel.app";
  const proto = readHeader(req, "x-forwarded-proto") || "https";
  return req.url?.startsWith("http") ? req.url : `${proto}://${host}${req.url || "/api/settlements"}`;
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function sanitizeError(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg
    .replace(/https?:\/\/[^\s"']+/gi, "[upstream]")
    .replace(/swrm_[a-z0-9]+/gi, "[redacted]")
    .replace(/Bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted]");
  msg = (msg.split("\n")[0] || "").slice(0, 180).trim();
  return msg || "Gateway settlement unavailable";
}
