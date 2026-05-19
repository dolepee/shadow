// Headless follower agent. Proves Shadow runs end to end with no browser:
// fund + approve + deposit + followSource + watch receipts + closePosition.
//
// Usage:
//   pnpm --dir agent headless-follower
// Env:
//   HEADLESS_FOLLOWER_PRIVATE_KEY  optional; if unset a fresh EOA is generated
//   ARC_RPC_URL, ARC_USDC, SHADOW_ROUTER, PRIVATE_KEY  required (.env)
//   HEADLESS_SOURCE   optional, defaults to CatArb mainnet address
//   HEADLESS_WATCH_SECONDS  optional, defaults to 600 (10 min, one cron window)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseAbiItem,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

loadEnvFile();

const CAT_ARB_DEFAULT: Address = "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8";

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
  "function followSource(address source, uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
  "function followerBalanceUSDC(address) view returns (uint256)",
  "function closePosition(uint256 intentId)",
]);

const receiptEvent = parseAbiItem(
  "event MirrorReceipt(uint256 indexed intentId, address indexed follower, address indexed sourceAgent, uint8 status, uint8 reason, uint256 usdcAmount, uint256 mirrorFeeUSDC, uint256 assetAmountOut)",
);

const positionClosedEvent = parseAbiItem(
  "event PositionClosed(uint256 indexed intentId, address indexed follower, address indexed sourceAgent, uint256 usdcIn, uint256 usdcOut, int256 pnlBps)",
);

const STATUS = ["COPIED", "BLOCKED"] as const;
const REASONS = [
  "NONE",
  "NOT_FOLLOWING",
  "INSUFFICIENT_BALANCE",
  "AMOUNT_TOO_HIGH",
  "DAILY_CAP_EXCEEDED",
  "ASSET_NOT_ALLOWED",
  "UNSUPPORTED_AMM_ASSET",
  "RISK_TOO_HIGH",
  "INTENT_EXPIRED",
  "SLIPPAGE_TOO_TIGHT",
] as const;

const FUND_USDC = parseUnits("0.2", 6);
const DEPOSIT_USDC = parseUnits("0.15", 6);
const MAX_PER_INTENT = parseUnits("0.02", 6);
const DAILY_CAP = parseUnits("0.15", 6);
const MIN_BPS_OUT = 9300;
const MAX_RISK_LEVEL = 2;
const ASSET = requiredEnv("SHADOW_ARCETH") as Address;
const SOURCE = (process.env.HEADLESS_SOURCE as Address | undefined) || CAT_ARB_DEFAULT;
const WATCH_SECONDS = Number(process.env.HEADLESS_WATCH_SECONDS || 600);

await main();

async function main() {
  const transport = http(requiredEnv("ARC_RPC_URL"));
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const usdc = requiredEnv("ARC_USDC") as Address;
  const router = requiredEnv("SHADOW_ROUTER") as Address;

  const followerKey = (process.env.HEADLESS_FOLLOWER_PRIVATE_KEY as Hex | undefined) || generatePrivateKey();
  const account = privateKeyToAccount(followerKey);
  const followerWallet = createWalletClient({ account, chain: arcTestnet, transport });

  log(`agent EOA: ${account.address}`);
  if (!process.env.HEADLESS_FOLLOWER_PRIVATE_KEY) {
    log(`HEADLESS_FOLLOWER_PRIVATE_KEY=${followerKey}   (export to reuse this agent)`);
  }

  const routerBalance = await publicClient.readContract({
    address: router, abi: routerAbi, functionName: "followerBalanceUSDC", args: [account.address],
  });
  log(`router balance: ${formatUnits(routerBalance, 6)} USDC`);

  if (routerBalance === 0n) {
    const walletUsdc = await publicClient.readContract({
      address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
    });
    if (walletUsdc < FUND_USDC) {
      const delta = FUND_USDC - walletUsdc;
      const deployerKey = process.env.PRIVATE_KEY;
      if (!deployerKey) {
        log(`agent EOA balance ${formatUnits(walletUsdc, 6)} USDC < required ${formatUnits(FUND_USDC, 6)} USDC.`);
        log(`set PRIVATE_KEY to auto-fund from deployer, OR transfer ${formatUnits(delta, 6)} USDC to ${account.address} manually then re-run.`);
        process.exit(2);
      }
      const deployer = privateKeyToAccount(normalizeKey(deployerKey));
      const deployerWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport });
      log(`fund: deployer transfer ${formatUnits(delta, 6)} USDC -> agent`);
      const tx = await deployerWallet.writeContract({
        address: usdc, abi: erc20Abi, functionName: "transfer", args: [account.address, delta], gas: 200_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      log(`fund tx: ${tx}`);
    }
    log(`approve: ${formatUnits(DEPOSIT_USDC, 6)} USDC -> router`);
    const approveTx = await followerWallet.writeContract({
      address: usdc, abi: erc20Abi, functionName: "approve", args: [router, DEPOSIT_USDC],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    log(`approve tx: ${approveTx}`);

    log(`deposit: ${formatUnits(DEPOSIT_USDC, 6)} USDC into router`);
    const depositTx = await followerWallet.writeContract({
      address: router, abi: routerAbi, functionName: "depositUSDC", args: [DEPOSIT_USDC], gas: 200_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    log(`deposit tx: ${depositTx}`);

    log(`followSource: source=${SOURCE} maxPerIntent=${formatUnits(MAX_PER_INTENT, 6)} cap=${formatUnits(DAILY_CAP, 6)} minBpsOut=${MIN_BPS_OUT}`);
    const followTx = await followerWallet.writeContract({
      address: router, abi: routerAbi, functionName: "followSource",
      args: [SOURCE, MAX_PER_INTENT, DAILY_CAP, ASSET, MAX_RISK_LEVEL, MIN_BPS_OUT], gas: 300_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: followTx });
    log(`followSource tx: ${followTx}`);
  } else {
    log(`agent already onboarded, skipping fund + approve + deposit + followSource`);
  }

  log(`watching MirrorReceipt for follower=${account.address} for ${WATCH_SECONDS}s ...`);
  const startBlock = await publicClient.getBlockNumber();
  const deadline = Date.now() + WATCH_SECONDS * 1000;
  const copiedIntentIds: bigint[] = [];

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 12_000));
    const head = await publicClient.getBlockNumber();
    const logs = await publicClient.getLogs({
      address: router,
      event: receiptEvent,
      args: { follower: account.address },
      fromBlock: startBlock,
      toBlock: head,
    });
    for (const ev of logs) {
      const { intentId, sourceAgent, status, reason, usdcAmount, mirrorFeeUSDC, assetAmountOut } = ev.args as {
        intentId: bigint; sourceAgent: Address; status: number; reason: number; usdcAmount: bigint; mirrorFeeUSDC: bigint; assetAmountOut: bigint;
      };
      const tag = `intent=${intentId} status=${STATUS[status]} reason=${REASONS[reason] || reason}`;
      const numbers = `usdc=${formatUnits(usdcAmount, 6)} fee=${formatUnits(mirrorFeeUSDC, 6)} assetOut=${formatUnits(assetAmountOut, 18)}`;
      log(`receipt: ${tag} ${numbers} from=${sourceAgent} tx=${ev.transactionHash}`);
      if (STATUS[status] === "COPIED" && !copiedIntentIds.includes(intentId)) {
        copiedIntentIds.push(intentId);
      }
    }
    if (copiedIntentIds.length > 0) break;
  }

  if (copiedIntentIds.length === 0) {
    log("no COPIED receipts in window; exiting without closePosition. The follow remains active onchain.");
    return;
  }

  for (const intentId of copiedIntentIds) {
    log(`closePosition(${intentId}) ...`);
    try {
      const closeTx = await followerWallet.writeContract({
        address: router, abi: routerAbi, functionName: "closePosition", args: [intentId], gas: 500_000n,
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash: closeTx });
      const closedLogs = await publicClient.getLogs({
        address: router, event: positionClosedEvent,
        args: { intentId, follower: account.address },
        fromBlock: rcpt.blockNumber, toBlock: rcpt.blockNumber,
      });
      const closed = closedLogs[0]?.args as { usdcIn: bigint; usdcOut: bigint; pnlBps: bigint } | undefined;
      if (closed) {
        log(`PositionClosed intent=${intentId} usdcIn=${formatUnits(closed.usdcIn, 6)} usdcOut=${formatUnits(closed.usdcOut, 6)} pnlBps=${closed.pnlBps.toString()} tx=${closeTx}`);
      } else {
        log(`close tx=${closeTx} (no PositionClosed log decoded)`);
      }
    } catch (e: any) {
      log(`closePosition(${intentId}) failed: ${e.shortMessage || e.message}`);
    }
  }
}

function log(line: string) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function normalizeKey(value: string): Hex {
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
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
