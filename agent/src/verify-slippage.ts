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
  parseAbiItem,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

loadEnvFile();

const FOLLOWER_A = "0x495cb55E288E9105E3b3080F2A7323F870538695" as const;
const FOLLOWER_B = "0x7A3FFC0294f21E040b2bEa3e5Aad33cA08B33AcD" as const;
const FOLLOWER_A_MIN_BPS = 10000n;
const FOLLOWER_B_MIN_BPS = 9000n;
const BPS = 10000n;
const MIRROR_FEE_BPS = 10n;

const STATUS_LABEL = ["COPIED", "BLOCKED"];
const REASON_LABEL = [
  "none",
  "not following",
  "insufficient balance",
  "amount too high",
  "daily cap exceeded",
  "asset not allowed",
  "unsupported AMM asset",
  "risk too high",
  "intent expired",
  "slippage too tight",
];

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: {
    default: { http: [requiredEnv("ARC_RPC_URL")] },
  },
});

const routerAbi = parseAbi([
  "function publishIntent((address asset, uint256 amountUSDC, uint256 minAmountOut, uint8 riskLevel, uint256 expiry, bytes32 intentHash) intent) returns (uint256)",
  "function followerBalanceUSDC(address) view returns (uint256)",
  "function getPolicy(address follower, address sourceAgent) view returns (uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut, uint256 spentToday, uint64 day, bool active)",
]);

const ammAbi = parseAbi([
  "function quoteUSDCForAsset(uint256 usdcAmountIn) view returns (uint256)",
]);

const mirrorReceiptEvent = parseAbiItem(
  "event MirrorReceipt(uint256 indexed intentId, address indexed follower, address indexed sourceAgent, uint8 status, uint8 reason, uint256 usdcAmount, uint256 mirrorFeeUSDC, uint256 assetAmountOut)",
);

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const router = requiredEnv("SHADOW_ROUTER") as `0x${string}`;
  const arceth = requiredEnv("SHADOW_ARCETH") as `0x${string}`;
  const amm = requiredEnv("SHADOW_AMM") as `0x${string}`;
  const key = normalizeKey(requiredEnv("CAT_AGENT_PRIVATE_KEY"));

  const account = privateKeyToAccount(key);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport });

  const [balanceA, balanceB, policyA, policyB] = await Promise.all([
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "followerBalanceUSDC", args: [FOLLOWER_A] }),
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "followerBalanceUSDC", args: [FOLLOWER_B] }),
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "getPolicy", args: [FOLLOWER_A, account.address] }),
    publicClient.readContract({ address: router, abi: routerAbi, functionName: "getPolicy", args: [FOLLOWER_B, account.address] }),
  ]);

  if (!policyA[7] || !policyB[7]) {
    fail(`One or both followers are not following ${account.address}. Run the seed script first.`);
  }
  if (policyA[4] !== Number(FOLLOWER_A_MIN_BPS) || policyB[4] !== Number(FOLLOWER_B_MIN_BPS)) {
    fail(
      `Unexpected follower minBpsOut. Got A=${policyA[4]} B=${policyB[4]}, expected A=${FOLLOWER_A_MIN_BPS} B=${FOLLOWER_B_MIN_BPS}.`,
    );
  }

  const remainingA = policyA[1] > policyA[5] ? policyA[1] - policyA[5] : 0n;
  const remainingB = policyB[1] > policyB[5] ? policyB[1] - policyB[5] : 0n;

  // The router debits amountUSDC + 10bps fee, so the largest affordable amount is
  // floor(balance * BPS / (BPS + MIRROR_FEE_BPS)). Compute per follower and take the min.
  const affordableA = (balanceA * BPS) / (BPS + MIRROR_FEE_BPS);
  const affordableB = (balanceB * BPS) / (BPS + MIRROR_FEE_BPS);
  const cap = bigMin([policyA[0], policyB[0], affordableA, affordableB, remainingA, remainingB]);

  if (cap === 0n) {
    fail(
      `No headroom: balanceA=${formatUSDC(balanceA)} balanceB=${formatUSDC(balanceB)} dailyRemainA=${formatUSDC(remainingA)} dailyRemainB=${formatUSDC(remainingB)}.`,
    );
  }

  const targetAmount = parseUnits("0.1", 6);
  const amountUSDC = cap > targetAmount ? targetAmount : cap;
  const liveQuote = (await publicClient.readContract({
    address: amm,
    abi: ammAbi,
    functionName: "quoteUSDCForAsset",
    args: [amountUSDC],
  })) as bigint;
  const minAmountOut = (liveQuote * 105n) / 100n;
  const scaledMinA = (minAmountOut * FOLLOWER_A_MIN_BPS) / BPS;
  const scaledMinB = (minAmountOut * FOLLOWER_B_MIN_BPS) / BPS;

  if (scaledMinA <= liveQuote) fail(`Math drift: scaledMinA=${scaledMinA} <= liveQuote=${liveQuote}.`);
  if (scaledMinB > liveQuote) fail(`Math drift: scaledMinB=${scaledMinB} > liveQuote=${liveQuote}.`);

  console.log("");
  console.log("== Verify Slippage =========================================");
  console.log(`Source (CatArb):       ${account.address}`);
  console.log(`amountUSDC:            ${formatUSDC(amountUSDC)} USDC`);
  console.log(`live AMM quote:        ${formatAsset(liveQuote)} ARCETH`);
  console.log(`intent.minAmountOut:   ${formatAsset(minAmountOut)} ARCETH`);
  console.log(`Follower A 10000 bps:  scaled min ${formatAsset(scaledMinA)} ARCETH  (above quote, expect BLOCKED)`);
  console.log(`Follower B  9000 bps:  scaled min ${formatAsset(scaledMinB)} ARCETH  (below quote, expect COPIED)`);
  console.log("============================================================");

  const intentHash = keccak256(
    encodePacked(["string", "uint256"], ["shadow-verify-slippage", BigInt(Date.now())]),
  );

  console.log("\npublishing intent...");
  const tx = await walletClient.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "publishIntent",
    args: [
      {
        asset: arceth,
        amountUSDC,
        minAmountOut,
        riskLevel: 2,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        intentHash,
      },
    ],
  });
  console.log(`tx: ${tx}`);

  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`confirmed in block ${txReceipt.blockNumber.toString()}`);

  const receipts = await publicClient.getLogs({
    address: router,
    event: mirrorReceiptEvent,
    blockHash: txReceipt.blockHash,
  });
  const intentReceipts = receipts.filter(
    (log) => log.transactionHash === tx,
  );

  const aLog = intentReceipts.find(
    (log) => (log.args.follower ?? "").toLowerCase() === FOLLOWER_A.toLowerCase(),
  );
  const bLog = intentReceipts.find(
    (log) => (log.args.follower ?? "").toLowerCase() === FOLLOWER_B.toLowerCase(),
  );

  if (!aLog || !bLog) fail("Did not find a MirrorReceipt for both followers.");

  console.log("\n== Mirror Receipts =========================================");
  printReceipt("Follower A (strict, 10000 bps)", aLog);
  printReceipt("Follower B (lenient, 9000 bps)", bLog);
  console.log("============================================================");

  const aOk =
    Number(aLog.args.status) === 1 && Number(aLog.args.reason) === 9;
  const bOk = Number(bLog.args.status) === 0;

  if (aOk && bOk) {
    console.log("\n[PASS] Same source intent, two outcomes from follower minBpsOut alone.");
    process.exit(0);
  }
  console.log(
    `\n[FAIL] Expected A=BLOCKED+slippage_too_tight, B=COPIED. Got A=${STATUS_LABEL[Number(aLog.args.status)]}+${REASON_LABEL[Number(aLog.args.reason)]}, B=${STATUS_LABEL[Number(bLog.args.status)]}+${REASON_LABEL[Number(bLog.args.reason)]}.`,
  );
  process.exit(1);
}

function printReceipt(label: string, log: { args: Record<string, unknown> }) {
  const status = Number(log.args.status);
  const reason = Number(log.args.reason);
  console.log(`${label}`);
  console.log(`  status:        ${STATUS_LABEL[status]}`);
  console.log(`  reason:        ${REASON_LABEL[reason]}`);
  console.log(`  usdcAmount:    ${formatUSDC(log.args.usdcAmount as bigint)} USDC`);
  console.log(`  mirrorFee:     ${formatUSDC(log.args.mirrorFeeUSDC as bigint)} USDC`);
  console.log(`  assetOut:      ${formatAsset(log.args.assetAmountOut as bigint)} ARCETH`);
}

function bigMin(values: bigint[]): bigint {
  return values.reduce((min, v) => (v < min ? v : min));
}

function formatUSDC(value: bigint): string {
  return Number(formatUnits(value, 6)).toFixed(6);
}

function formatAsset(value: bigint): string {
  return Number(formatUnits(value, 18)).toFixed(6);
}

function normalizeKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    fail(`Missing env: ${name}. Source .env at the repo root before running.`);
  }
  return value;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
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
