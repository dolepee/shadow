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
  "function followerBalanceUSDC(address) view returns (uint256)",
]);

const TARGET = parseUnits("0.6", 6);

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const usdc = requiredEnv("ARC_USDC") as Address;
  const router = requiredEnv("SHADOW_ROUTER") as Address;
  const followerBKey = normalizeKey(requiredEnv("FOLLOWER_B_PRIVATE_KEY"));
  const deployerKey = normalizeKey(requiredEnv("PRIVATE_KEY"));
  const account = privateKeyToAccount(followerBKey);
  const deployer = privateKeyToAccount(deployerKey);

  const existing = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "followerBalanceUSDC",
    args: [account.address],
  });
  if (existing >= TARGET) {
    console.log(`Follower B router balance already ${existing.toString()}, nothing to do`);
    return;
  }
  const delta = TARGET - existing;

  const walletUsdc = await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`Follower B wallet USDC=${walletUsdc.toString()}, needs delta=${delta.toString()} for router`);
  if (walletUsdc < delta) {
    const fundNeeded = delta - walletUsdc + parseUnits("0.05", 6); // small gas buffer
    console.log(`funding from deployer ${deployer.address}: ${fundNeeded.toString()} USDC...`);
    const deployerWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport });
    const transferTx = await deployerWallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [account.address, fundNeeded],
      gas: 200_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: transferTx });
    console.log(`transfer tx=${transferTx}`);
  }

  const wallet = createWalletClient({ account, chain: arcTestnet, transport });
  console.log(`Follower B router existing=${existing.toString()} target=${TARGET.toString()} delta=${delta.toString()}`);

  const approveTx = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [router, delta],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log(`approve tx=${approveTx}`);

  const depositTx = await wallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "depositUSDC",
    args: [delta],
    gas: 200_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log(`deposit tx=${depositTx}`);
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
