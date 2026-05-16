import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

loadEnvFile();

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [requiredEnv("ARC_RPC_URL")] } },
});

const routerAbi = parseAbi([
  "function followSource(address sourceAgent, uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
]);

type FollowConfig = {
  label: string;
  followerKey: `0x${string}`;
  sourceAgent: Address;
  maxAmountPerIntent: bigint;
  dailyCap: bigint;
  allowedAsset: Address;
  maxRiskLevel: number;
  minBpsOut: number;
};

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const router = requiredEnv("SHADOW_ROUTER") as Address;
  const arceth = requiredEnv("SHADOW_ARCETH") as Address;

  const lobster = privateKeyToAccount(normalizeKey(requiredEnv("LOBSTER_AGENT_PRIVATE_KEY")));
  const followerAKey = normalizeKey(requiredEnv("FOLLOWER_A_PRIVATE_KEY"));
  const followerBKey = normalizeKey(requiredEnv("FOLLOWER_B_PRIVATE_KEY"));

  const configs: FollowConfig[] = [
    {
      label: "A → LobsterRisk (strict)",
      followerKey: followerAKey,
      sourceAgent: lobster.address,
      maxAmountPerIntent: parseUnits("2", 6),
      dailyCap: parseUnits("20", 6),
      allowedAsset: arceth,
      maxRiskLevel: 3,
      minBpsOut: 10000,
    },
    {
      label: "B → LobsterRisk (lenient)",
      followerKey: followerBKey,
      sourceAgent: lobster.address,
      maxAmountPerIntent: parseUnits("2", 6),
      dailyCap: parseUnits("20", 6),
      allowedAsset: arceth,
      maxRiskLevel: 3,
      minBpsOut: 9000,
    },
  ];

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  for (const cfg of configs) {
    const account = privateKeyToAccount(cfg.followerKey);
    const walletClient = createWalletClient({ account, chain: arcTestnet, transport });
    console.log(`\n[${cfg.label}] follower=${account.address} source=${cfg.sourceAgent}`);
    const tx = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "followSource",
      args: [
        cfg.sourceAgent,
        cfg.maxAmountPerIntent,
        cfg.dailyCap,
        cfg.allowedAsset,
        cfg.maxRiskLevel,
        cfg.minBpsOut,
      ],
    });
    console.log(`[${cfg.label}] tx=${tx}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[${cfg.label}] confirmed block=${receipt.blockNumber.toString()}`);
  }
}

function normalizeKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`error: missing env ${name}`);
    process.exit(2);
  }
  return value;
}

function loadEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../.env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional if env is already exported
  }
}
