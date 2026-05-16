import { encodePacked, keccak256, toHex } from "viem";

export type ReasoningPacket = {
  sourceAgent: `0x${string}`;
  sourceName: string;
  intentHash: `0x${string}`;
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

export type ReasoningInputs = {
  sourceAgent: `0x${string}`;
  sourceName: string;
  amountUSDC: bigint;
  minAmountOut: bigint;
  liveQuote: bigint;
  reserveUSDC: bigint;
  reserveAsset: bigint;
  riskLevel: number;
  decision: "publish" | "skip";
  rationale: string;
};

// Canonical hash of the reasoning packet: keccak256(packed(sourceAgent,
// amountUSDC, minAmountOut, liveQuote, riskLevel, sourceName, rationale)).
// Important: any field in the hash input is bound to the published intent.
// Date.now() is NOT part of the hash so the hash proves reasoning content.
export function computeIntentHash(inputs: ReasoningInputs): `0x${string}` {
  return keccak256(
    encodePacked(
      ["address", "uint256", "uint256", "uint256", "uint8", "string", "string"],
      [
        inputs.sourceAgent,
        inputs.amountUSDC,
        inputs.minAmountOut,
        inputs.liveQuote,
        inputs.riskLevel,
        inputs.sourceName,
        inputs.rationale,
      ],
    ),
  );
}

// Confidence: how much room the slippage bound has above the live quote, in bps.
// 9000 bps = lenient, ~10% slip allowed → low confidence.
// 9950 bps = tight, ~0.5% slip allowed → high confidence.
// Clamped to [0, 10000].
export function deriveConfidenceBps(
  liveQuote: bigint,
  minAmountOut: bigint,
): number {
  if (liveQuote === 0n) return 0;
  // ratio = minAmountOut / liveQuote, scaled to bps
  const ratioBps = Number((minAmountOut * 10_000n) / liveQuote);
  if (ratioBps >= 10_000) return 10_000;
  if (ratioBps <= 0) return 0;
  return ratioBps;
}

export function formatBigint6(value: bigint): string {
  return formatScaled(value, 6, 6);
}

export function formatBigint18(value: bigint): string {
  return formatScaled(value, 18, 6);
}

function formatScaled(value: bigint, decimals: number, fractionDigits: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, fractionDigits);
  const sign = negative ? "-" : "";
  return `${sign}${whole.toString()}.${fracStr}`;
}

export function buildPacket(inputs: ReasoningInputs): ReasoningPacket {
  const intentHash = computeIntentHash(inputs);
  const confidenceBps = deriveConfidenceBps(inputs.liveQuote, inputs.minAmountOut);
  return {
    sourceAgent: inputs.sourceAgent,
    sourceName: inputs.sourceName,
    intentHash,
    createdAt: Math.floor(Date.now() / 1000),
    amountUSDC: formatBigint6(inputs.amountUSDC),
    minAmountOut: formatBigint18(inputs.minAmountOut),
    liveQuote: formatBigint18(inputs.liveQuote),
    reserveUSDC: formatBigint6(inputs.reserveUSDC),
    reserveAsset: formatBigint18(inputs.reserveAsset),
    riskLevel: inputs.riskLevel,
    confidenceBps,
    decision: inputs.decision,
    rationale: inputs.rationale,
  };
}

type KVConfig = {
  url: string;
  token: string;
};

export function kvConfigFromEnv(): KVConfig | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

export async function putReasoning(
  kv: KVConfig,
  packet: ReasoningPacket,
): Promise<void> {
  const key = `reasoning:${packet.intentHash}`;
  const value = JSON.stringify(packet);
  // Upstash REST: POST {base}/set/{key} with bearer auth, body = raw value.
  // Keep the artifact for 30 days.
  const setRes = await fetch(`${kv.url}/set/${encodeURIComponent(key)}?EX=2592000`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${kv.token}`,
      "content-type": "application/json",
    },
    body: value,
  });
  if (!setRes.ok) {
    throw new Error(`kv set failed status=${setRes.status} body=${await setRes.text()}`);
  }
  // Pointer to the latest packet.
  const latestRes = await fetch(`${kv.url}/set/latestReasoningIntentHash`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${kv.token}`,
      "content-type": "application/json",
    },
    body: packet.intentHash,
  });
  if (!latestRes.ok) {
    throw new Error(`kv latest set failed status=${latestRes.status} body=${await latestRes.text()}`);
  }
}

// Helper: tag a packet's intentHash on its txHash so the UI can hop from the
// receipts feed to the matching reasoning packet later.
export async function bindIntentHashToTx(
  kv: KVConfig,
  txHash: `0x${string}`,
  intentHash: `0x${string}`,
): Promise<void> {
  const key = `tx:${txHash.toLowerCase()}:reasoning`;
  const res = await fetch(`${kv.url}/set/${encodeURIComponent(key)}?EX=2592000`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${kv.token}`,
      "content-type": "application/json",
    },
    body: intentHash,
  });
  if (!res.ok) {
    throw new Error(`kv tx-tag set failed status=${res.status} body=${await res.text()}`);
  }
}

// Silence unused warnings when imported in scripts that only call buildPacket.
export const _kvHelpers = { putReasoning, bindIntentHashToTx, kvConfigFromEnv, toHex };
