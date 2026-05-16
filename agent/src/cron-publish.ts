import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
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
  "function publishIntent((address asset, uint256 amountUSDC, uint256 minAmountOut, uint8 riskLevel, uint256 expiry, bytes32 intentHash) intent) returns (uint256)",
]);

const ammAbi = parseAbi([
  "function quoteUSDCForAsset(uint256 usdcAmountIn) view returns (uint256)",
]);

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const router = requiredEnv("SHADOW_ROUTER") as `0x${string}`;
  const arceth = requiredEnv("SHADOW_ARCETH") as `0x${string}`;
  const amm = requiredEnv("SHADOW_AMM") as `0x${string}`;
  const publisherKey = normalizeKey(requiredEnv("PUBLISHER_KEY"));
  const label = process.env.SOURCE_LABEL || "publisher";
  const amountStr = process.env.INTENT_AMOUNT_USDC || "0.05";
  const minBps = BigInt(process.env.INTENT_MIN_BPS || "10000");
  const riskLevel = Number(process.env.INTENT_RISK_LEVEL || "2");

  const account = privateKeyToAccount(publisherKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport });

  const amountUSDC = parseUnits(amountStr, 6);
  const liveQuote = (await publicClient.readContract({
    address: amm,
    abi: ammAbi,
    functionName: "quoteUSDCForAsset",
    args: [amountUSDC],
  })) as bigint;
  const minAmountOut = (liveQuote * minBps) / 10000n;

  const intentHash = keccak256(
    encodePacked(
      ["string", "address", "uint256"],
      [`shadow-cron-${label}`, account.address, BigInt(Date.now())],
    ),
  );

  console.log(`[${label}] source=${account.address}`);
  console.log(`[${label}] amount=${amountStr} USDC`);
  console.log(`[${label}] liveQuote=${formatUnits(liveQuote, 18)} ARCETH`);
  console.log(`[${label}] minAmountOut=${formatUnits(minAmountOut, 18)} ARCETH (bps=${minBps})`);
  console.log(`[${label}] riskLevel=${riskLevel}`);

  const tx = await walletClient.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "publishIntent",
    args: [
      {
        asset: arceth,
        amountUSDC,
        minAmountOut,
        riskLevel,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        intentHash,
      },
    ],
  });
  console.log(`[${label}] tx=${tx}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`[${label}] confirmed block=${receipt.blockNumber.toString()}`);
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
