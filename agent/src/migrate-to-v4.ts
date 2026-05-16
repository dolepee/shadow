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
]);

const DEPOSIT_PER_FOLLOWER = parseUnits("0.6", 6); // 0.6 USDC covers spotlight intent (0.5) + mirror fee
const MAX_PER_INTENT = parseUnits("2", 6);
const DAILY_CAP = parseUnits("20", 6);
const GAS_BUFFER = parseUnits("0.05", 6);

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  const usdc = requiredEnv("ARC_USDC") as Address;
  const arceth = requiredEnv("SHADOW_ARCETH") as Address;
  const router = requiredEnv("SHADOW_ROUTER") as Address;

  const deployerKey = normalizeKey(requiredEnv("PRIVATE_KEY"));
  const deployer = privateKeyToAccount(deployerKey);
  const cat = privateKeyToAccount(normalizeKey(requiredEnv("CAT_AGENT_PRIVATE_KEY")));
  const lobster = privateKeyToAccount(normalizeKey(requiredEnv("LOBSTER_AGENT_PRIVATE_KEY")));
  const otter = privateKeyToAccount(normalizeKey(requiredEnv("OTTER_AGENT_PRIVATE_KEY")));
  const followerAKey = normalizeKey(requiredEnv("FOLLOWER_A_PRIVATE_KEY"));
  const followerBKey = normalizeKey(requiredEnv("FOLLOWER_B_PRIVATE_KEY"));

  console.log(`router (V4)=${router}`);
  console.log(`sources: cat=${cat.address} lobster=${lobster.address} otter=${otter.address}`);

  await topupAndDeposit(publicClient, transport, deployerKey, followerAKey, usdc, router, "Follower A");
  await topupAndDeposit(publicClient, transport, deployerKey, followerBKey, usdc, router, "Follower B");

  for (const source of [cat.address, lobster.address, otter.address]) {
    await follow(publicClient, transport, followerAKey, router, source, arceth, 10000, `A → ${short(source)} (strict)`);
    await follow(publicClient, transport, followerBKey, router, source, arceth, 9000, `B → ${short(source)} (lenient)`);
  }

  console.log("\nDone. Update VITE_SHADOW_ROUTER, VITE_SHADOW_AMM, VITE_SHADOW_START_BLOCK on Vercel + GH secrets.");
}

async function topupAndDeposit(
  publicClient: ReturnType<typeof createPublicClient>,
  transport: ReturnType<typeof http>,
  deployerKey: `0x${string}`,
  followerKey: `0x${string}`,
  usdc: Address,
  router: Address,
  label: string,
) {
  const follower = privateKeyToAccount(followerKey);
  const deployer = privateKeyToAccount(deployerKey);

  const existing = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "followerBalanceUSDC",
    args: [follower.address],
  });
  if (existing >= DEPOSIT_PER_FOLLOWER) {
    console.log(`[${label}] router balance already ${existing} >= target, skipping`);
    return;
  }
  const delta = DEPOSIT_PER_FOLLOWER - existing;

  const walletUsdc = await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [follower.address],
  });

  if (walletUsdc < delta) {
    const fundNeeded = delta - walletUsdc + GAS_BUFFER;
    console.log(`[${label}] wallet USDC=${walletUsdc}, funding ${fundNeeded} from deployer ${deployer.address}`);
    const deployerWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport });
    const tx = await deployerWallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [follower.address, fundNeeded],
      gas: 200_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[${label}] transfer tx=${tx}`);
  }

  const wallet = createWalletClient({ account: follower, chain: arcTestnet, transport });
  console.log(`[${label}] approving ${delta} USDC to router...`);
  const approveTx = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [router, delta],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  console.log(`[${label}] depositing ${delta} USDC...`);
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

function short(addr: string): string {
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
    // .env is optional
  }
}
