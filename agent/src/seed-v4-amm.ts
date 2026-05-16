import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  formatUnits,
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
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const ammAbi = parseAbi([
  "function addLiquidity(uint256 usdcAmount, uint256 assetAmount)",
  "function reserveUSDC() view returns (uint256)",
  "function reserveAsset() view returns (uint256)",
  "function owner() view returns (address)",
]);

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  const usdc = requiredEnv("ARC_USDC") as Address;
  const arceth = requiredEnv("SHADOW_ARCETH") as Address;
  const amm = requiredEnv("SHADOW_AMM_V4") as Address;
  const seedUsdc = BigInt(requiredEnv("SEED_USDC_AMOUNT"));
  const seedArceth = BigInt(requiredEnv("SEED_ARCETH_AMOUNT"));

  const deployer = privateKeyToAccount(normalizeKey(requiredEnv("PRIVATE_KEY")));
  const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport });

  const [owner, reserveU, reserveA, walletUsdc, walletEth] = await Promise.all([
    publicClient.readContract({ address: amm, abi: ammAbi, functionName: "owner" }),
    publicClient.readContract({ address: amm, abi: ammAbi, functionName: "reserveUSDC" }),
    publicClient.readContract({ address: amm, abi: ammAbi, functionName: "reserveAsset" }),
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
    publicClient.readContract({ address: arceth, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
  ]);

  console.log(`AMM=${amm} owner=${owner}`);
  console.log(`current reserves USDC=${formatUnits(reserveU, 6)} ARCETH=${formatUnits(reserveA, 18)}`);
  console.log(`deployer balances USDC=${formatUnits(walletUsdc, 6)} ARCETH=${formatUnits(walletEth, 18)}`);
  console.log(`seed USDC=${formatUnits(seedUsdc, 6)} ARCETH=${formatUnits(seedArceth, 18)}`);

  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`AMM owner ${owner} != deployer ${deployer.address}`);
  }
  if (reserveU > 0n || reserveA > 0n) {
    console.log("AMM already has liquidity, exiting");
    return;
  }
  if (walletUsdc < seedUsdc) throw new Error(`deployer USDC ${walletUsdc} < seed ${seedUsdc}`);
  if (walletEth < seedArceth) throw new Error(`deployer ARCETH ${walletEth} < seed ${seedArceth}`);

  // 1. Approve USDC (precompile). 200_000 gas avoids isBlocklisted StackUnderflow.
  console.log("approving USDC...");
  const approveUsdcTx = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [amm, seedUsdc],
    gas: 200_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveUsdcTx });
  console.log(`approve USDC tx=${approveUsdcTx}`);

  // 2. Approve ARCETH (normal token)
  console.log("approving ARCETH...");
  const approveEthTx = await wallet.writeContract({
    address: arceth,
    abi: erc20Abi,
    functionName: "approve",
    args: [amm, seedArceth],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveEthTx });
  console.log(`approve ARCETH tx=${approveEthTx}`);

  // 3. addLiquidity: triggers USDC.transferFrom which hits the precompile.
  //    500_000 gas covers both transferFrom calls + AMM bookkeeping.
  console.log("adding liquidity...");
  const liqTx = await wallet.writeContract({
    address: amm,
    abi: ammAbi,
    functionName: "addLiquidity",
    args: [seedUsdc, seedArceth],
    gas: 500_000n,
  });
  const liqReceipt = await publicClient.waitForTransactionReceipt({ hash: liqTx });
  console.log(`addLiquidity tx=${liqTx} block=${liqReceipt.blockNumber} status=${liqReceipt.status}`);

  const [ru2, ra2] = await Promise.all([
    publicClient.readContract({ address: amm, abi: ammAbi, functionName: "reserveUSDC" }),
    publicClient.readContract({ address: amm, abi: ammAbi, functionName: "reserveAsset" }),
  ]);
  console.log(`final reserves USDC=${formatUnits(ru2, 6)} ARCETH=${formatUnits(ra2, 18)}`);
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
