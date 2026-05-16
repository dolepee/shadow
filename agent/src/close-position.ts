import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
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
  "function nextIntentId() view returns (uint256)",
  "function positions(uint256 intentId, address follower) view returns (uint256 usdcIn, uint256 assetAmount, address sourceAgent, bool closed)",
  "function closePosition(uint256 intentId) returns (uint256 usdcOut, int256 pnlBps)",
]);

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const router = requiredEnv("SHADOW_ROUTER") as Address;
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  const closeLimit = Number(process.env.CLOSE_LIMIT || "2");
  const scanLimit = Number(process.env.CLOSE_SCAN_LIMIT || "30");
  const followerKeys = [
    ["Follower A", process.env.FOLLOWER_A_PRIVATE_KEY],
    ["Follower B", process.env.FOLLOWER_B_PRIVATE_KEY],
  ] as const;

  const nextIntentId = (await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "nextIntentId",
  })) as bigint;

  let closed = 0;
  for (const [label, rawKey] of followerKeys) {
    if (!rawKey) {
      console.log(`[${label}] skip: missing private key`);
      continue;
    }
    if (closed >= closeLimit) break;

    const account = privateKeyToAccount(normalizeKey(rawKey));
    const wallet = createWalletClient({ account, chain: arcTestnet, transport });
    console.log(`[${label}] scanning open positions for ${account.address}`);

    const minIntent = nextIntentId > BigInt(scanLimit) ? nextIntentId - BigInt(scanLimit) : 1n;
    for (let intentId = nextIntentId - 1n; intentId >= minIntent; intentId--) {
      if (closed >= closeLimit) break;

      const position = (await publicClient.readContract({
        address: router,
        abi: routerAbi,
        functionName: "positions",
        args: [intentId, account.address],
      })) as readonly [bigint, bigint, Address, boolean];

      const [usdcIn, assetAmount, sourceAgent, isClosed] = position;
      if (assetAmount === 0n || isClosed) continue;

      console.log(
        `[${label}] closing intent=${intentId.toString()} source=${sourceAgent} usdcIn=${formatUnits(usdcIn, 6)} asset=${formatUnits(assetAmount, 18)}`,
      );
      const tx = await wallet.writeContract({
        address: router,
        abi: routerAbi,
        functionName: "closePosition",
        args: [intentId],
        gas: 500_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`[${label}] closed intent=${intentId.toString()} tx=${tx} block=${receipt.blockNumber.toString()}`);
      closed++;
    }
  }

  if (closed === 0) {
    console.log("no open copied positions found");
  } else {
    console.log(`closed ${closed} position(s)`);
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
