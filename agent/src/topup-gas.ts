import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

loadEnvFile();

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [requiredEnv("ARC_RPC_URL")] } },
});

// Target native USDC balance per publishing agent. cron-publish uses gas≈800k
// at 24 gwei → ~0.0192 USDC per tx, so 0.3 USDC buys ~15 cron ticks.
const TARGET_NATIVE = parseUnits("0.3", 18);

await main();

async function main() {
  const transport = http(requiredEnv("ARC_RPC_URL"));
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const deployer = privateKeyToAccount(normalizeKey(requiredEnv("PRIVATE_KEY")));
  const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport });

  const targets: Array<{ name: string; envKey: string }> = [
    { name: "cat", envKey: "CAT_AGENT_PRIVATE_KEY" },
    { name: "lobster", envKey: "LOBSTER_AGENT_PRIVATE_KEY" },
    { name: "otter", envKey: "OTTER_AGENT_PRIVATE_KEY" },
    { name: "follower-a", envKey: "FOLLOWER_A_PRIVATE_KEY" },
    { name: "follower-b", envKey: "FOLLOWER_B_PRIVATE_KEY" },
  ];

  const deployerBalance = await publicClient.getBalance({ address: deployer.address });
  console.log(`deployer ${deployer.address} native=${formatUnits(deployerBalance, 18)} USDC`);

  for (const t of targets) {
    const raw = process.env[t.envKey];
    if (!raw) {
      console.log(`[${t.name}] skip: missing ${t.envKey}`);
      continue;
    }
    const addr = privateKeyToAccount(normalizeKey(raw)).address;
    const current = await publicClient.getBalance({ address: addr });
    if (current >= TARGET_NATIVE) {
      console.log(`[${t.name}] ${addr} native=${formatUnits(current, 18)} USDC, at/above target ${formatUnits(TARGET_NATIVE, 18)}, skipping`);
      continue;
    }
    const delta = TARGET_NATIVE - current;
    console.log(`[${t.name}] ${addr} native=${formatUnits(current, 18)} USDC, topping up by ${formatUnits(delta, 18)} USDC...`);
    const tx = await wallet.sendTransaction({
      to: addr,
      value: delta,
      gas: 100_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    const after = await publicClient.getBalance({ address: addr });
    console.log(`[${t.name}] tx=${tx} block=${receipt.blockNumber} native=${formatUnits(after, 18)} USDC`);
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
    // optional
  }
}
