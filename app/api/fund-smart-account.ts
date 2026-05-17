import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  getAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

export const config = { maxDuration: 30 };

const COOLDOWN_SECONDS = 600;
const FUND_AMOUNT_USDC = parseUnits("0.05", 6);

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

type Body = { address?: string };
type KVConfig = { url: string; token: string };

type VercelLikeResponse = {
  setHeader: (k: string, v: string) => void;
  status: (s: number) => { json: (b: unknown) => void };
};

type VercelLikeRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method not allowed, use POST" });
    return;
  }

  const body = parseBody(req.body);
  if (!body.address || !isAddress(body.address)) {
    res.status(400).json({ error: "address required (EVM hex)" });
    return;
  }
  const recipient = getAddress(body.address) as Address;

  const kv = kvConfigFromEnv();
  if (kv) {
    const cooldownKey = `shadow:fund:${recipient.toLowerCase()}`;
    const seen = await kvGet<{ at: number; tx: string }>(kv, cooldownKey).catch(() => null);
    if (seen) {
      res.status(200).json({
        funded: false,
        cached: true,
        cooldownSeconds: COOLDOWN_SECONDS,
        previousTx: seen.tx,
        message: "Address was funded recently; smart account should already hold ≥ 0.05 USDC.",
      });
      return;
    }
  }

  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const usdc = (process.env.ARC_USDC ||
    process.env.VITE_ARC_USDC ||
    "0x3600000000000000000000000000000000000000") as Address;
  const rawKey =
    process.env.PRIVATE_KEY ||
    process.env.CAT_AGENT_PRIVATE_KEY ||
    "";
  if (!rawKey) {
    res.status(500).json({
      error: "No funder private key configured (PRIVATE_KEY or CAT_AGENT_PRIVATE_KEY).",
    });
    return;
  }
  const account = privateKeyToAccount(normalizeKey(rawKey));

  const arcTestnet = defineChain({
    id: 5_042_002,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });

  try {
    const balanceBefore = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [recipient],
    });

    if (balanceBefore >= FUND_AMOUNT_USDC) {
      res.status(200).json({
        funded: false,
        skipped: true,
        balanceUSDC: balanceBefore.toString(),
        message: "Smart account already has ≥ 0.05 USDC.",
      });
      return;
    }

    const delta = FUND_AMOUNT_USDC - balanceBefore;
    const tx = await wallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, delta],
      gas: 200_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });

    if (kv) {
      const cooldownKey = `shadow:fund:${recipient.toLowerCase()}`;
      await kvSet(kv, cooldownKey, { at: Date.now(), tx }, COOLDOWN_SECONDS).catch(() => undefined);
    }

    res.status(200).json({
      funded: true,
      tx,
      amountUSDC: delta.toString(),
      recipient,
    });
  } catch (err: any) {
    res.status(500).json({
      error: err?.shortMessage || err?.message || "fund failed",
    });
  }
}

function parseBody(raw: unknown): Body {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Body;
    } catch {
      return {};
    }
  }
  return raw as Body;
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
  if (!res.ok) throw new Error(`kv get failed status=${res.status}`);
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
  if (!res.ok) throw new Error(`kv set failed status=${res.status}`);
}

function normalizeKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}
