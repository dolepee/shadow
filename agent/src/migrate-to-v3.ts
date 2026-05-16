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

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const routerAbi = parseAbi([
  "function depositUSDC(uint256 amountUSDC)",
  "function followSource(address sourceAgent, uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
  "function followerBalanceUSDC(address) view returns (uint256)",
  "function publishIntent((address asset, uint256 amountUSDC, uint256 minAmountOut, uint8 riskLevel, uint256 expiry, bytes32 intentHash) intent) returns (uint256)",
  "function nextIntentId() view returns (uint256)",
]);

const DEPOSIT_PER_FOLLOWER = parseUnits("0.6", 6); // 0.6 USDC into V3 router so followers cover spotlight intent (0.5) + mirror fee (0.0005)
const MAX_PER_INTENT = parseUnits("2", 6);
const DAILY_CAP = parseUnits("20", 6);
const SPOTLIGHT_AMOUNT_USDC = parseUnits("0.5", 6);
const SPOTLIGHT_MIN_OUT_ARCETH = parseUnits("0.034", 18);

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  const usdc = requiredEnv("ARC_USDC") as Address;
  const arceth = requiredEnv("SHADOW_ARCETH") as Address;
  const router = requiredEnv("SHADOW_ROUTER") as Address;

  const deployer = privateKeyToAccount(normalizeKey(requiredEnv("PRIVATE_KEY")));
  const cat = privateKeyToAccount(normalizeKey(requiredEnv("CAT_AGENT_PRIVATE_KEY")));
  const lobster = privateKeyToAccount(normalizeKey(requiredEnv("LOBSTER_AGENT_PRIVATE_KEY")));
  const otter = privateKeyToAccount(normalizeKey(requiredEnv("OTTER_AGENT_PRIVATE_KEY")));
  const followerAKey = normalizeKey(requiredEnv("FOLLOWER_A_PRIVATE_KEY"));
  const followerBKey = normalizeKey(requiredEnv("FOLLOWER_B_PRIVATE_KEY"));
  const followerA = privateKeyToAccount(followerAKey);
  const followerB = privateKeyToAccount(followerBKey);

  console.log(`router (V3)=${router}`);
  console.log(`sources: cat=${cat.address} lobster=${lobster.address} otter=${otter.address}`);
  console.log(`followers: A=${followerA.address} B=${followerB.address}`);

  await depositOnRouter(publicClient, transport, followerAKey, usdc, router, DEPOSIT_PER_FOLLOWER, "Follower A");
  await depositOnRouter(publicClient, transport, followerBKey, usdc, router, DEPOSIT_PER_FOLLOWER, "Follower B");

  for (const source of [cat.address, lobster.address, otter.address]) {
    await follow(publicClient, transport, followerAKey, router, source, arceth, 10000, `A → ${shortAddr(source)} (strict)`);
    await follow(publicClient, transport, followerBKey, router, source, arceth, 9000, `B → ${shortAddr(source)} (lenient)`);
  }

  console.log("\npublishing CatArb spotlight intent (split outcome) on V3...");
  const catWallet = createWalletClient({ account: cat, chain: arcTestnet, transport });
  const intentId = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "nextIntentId",
  });
  console.log(`  next intent id will be: ${intentId.toString()}`);

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const tx = await catWallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "publishIntent",
    args: [
      {
        asset: arceth,
        amountUSDC: SPOTLIGHT_AMOUNT_USDC,
        minAmountOut: SPOTLIGHT_MIN_OUT_ARCETH,
        riskLevel: 2,
        expiry,
        intentHash: `0x${"8".repeat(64)}` as `0x${string}`,
      },
    ],
  });
  console.log(`  publish tx=${tx}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`  confirmed block=${receipt.blockNumber.toString()} intentId=${intentId.toString()}`);

  console.log("\nDone. Update VITE_SHADOW_ROUTER, VITE_SHADOW_START_BLOCK, README, docs/ARC_LIVE.md, and GH SHADOW_ROUTER secret.");
}

async function depositOnRouter(
  publicClient: ReturnType<typeof createPublicClient>,
  transport: ReturnType<typeof http>,
  followerKey: `0x${string}`,
  usdc: Address,
  router: Address,
  amount: bigint,
  label: string,
) {
  const account = privateKeyToAccount(followerKey);
  const existing = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "followerBalanceUSDC",
    args: [account.address],
  });
  if (existing >= amount) {
    console.log(`[${label}] router balance already ${existing.toString()}, skipping deposit`);
    return;
  }
  const delta = amount - existing;

  const wallet = createWalletClient({ account, chain: arcTestnet, transport });
  console.log(`[${label}] existing=${existing.toString()} target=${amount.toString()} delta=${delta.toString()} USDC`);
  console.log(`[${label}] approving router for ${delta.toString()} USDC...`);
  const approveTx = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [router, delta],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  console.log(`[${label}] depositing ${delta.toString()} USDC...`);
  const depositTx = await wallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "depositUSDC",
    args: [delta],
    gas: 200_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log(`[${label}] deposit confirmed tx=${depositTx}`);
}

async function follow(
  publicClient: ReturnType<typeof createPublicClient>,
  transport: ReturnType<typeof http>,
  followerKey: `0x${string}`,
  router: Address,
  source: Address,
  arceth: Address,
  minBpsOut: number,
  label: string,
) {
  const account = privateKeyToAccount(followerKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });
  console.log(`\n[${label}] following...`);
  const tx = await wallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "followSource",
    args: [source, MAX_PER_INTENT, DAILY_CAP, arceth, 3, minBpsOut],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`[${label}] confirmed tx=${tx}`);
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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
