// Settle recent Float Desk PAY cycle amounts through Circle Gateway batching.
//
// This is an additive settlement-layer proof over recorded Desk activity. It is
// not the V2 provider payment path and it must not be counted as external
// traction. Dry-run by default; set GATEWAY_DESK_LIVE=1 for the real Gateway
// x402 payments.
import { existsSync, readFileSync } from "node:fs";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { formatUnits } from "viem";

const env = {
  ...readEnvFile("../.env"),
  ...readEnvFile(".env"),
  ...readEnvFile("../.vercel/.env.production.local"),
  ...readEnvFile(".vercel/.env.production.local"),
  ...process.env,
};

const LIVE = clean(env.GATEWAY_DESK_LIVE) === "1";
const baseUrl = (clean(env.SHADOW_APP_URL) || "https://shadow-arc.vercel.app").replace(/\/$/, "");
const limit = boundedInt(clean(env.GATEWAY_DESK_LIMIT), 1, 8, 3);
const payerKey = clean(env.GATEWAY_PAYER_PRIVATE_KEY) || clean(env.CAT_AGENT_PRIVATE_KEY) || clean(env.BUYER_PRIVATE_KEY);
const rpcUrl = clean(env.ARC_RPC_URL) || clean(env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";

const desk = await getJson(`${baseUrl}/api/float?mode=desk&limit=20&gatewayTs=${Date.now()}`);
const existing = await getJson(`${baseUrl}/api/settlements`).catch(() => ({ deskRecords: [] }));
const settledSpendTxs = new Set((existing.deskRecords || []).map((record) => String(record.spendTx || "").toLowerCase()));
const selected = selectDeskRows(desk.entries || [], settledSpendTxs, limit);

if (!selected.length) {
  console.log("No unsettled Float Desk PAY cycles found.");
  process.exit(0);
}

const totalAtomic = selected.reduce((sum, row) => sum + BigInt(row.amountUSDC), 0n);
const batch = {
  mode: LIVE ? "live" : "dry-run",
  baseUrl,
  rows: selected,
  totalAtomic: totalAtomic.toString(),
  totalUSDC: formatUnits(totalAtomic, 6),
  existingSettlements: existing.deskRecords?.length || 0,
  endpoint: `${baseUrl}/api/settlements`,
};

console.log("Float Desk Gateway settlement selection:");
console.log(JSON.stringify(batch, null, 2));

if (!LIVE) {
  console.log("\ndry run only: set GATEWAY_DESK_LIVE=1 and a Gateway-funded payer key to settle.");
  process.exit(0);
}

if (!payerKey) {
  throw new Error("missing GATEWAY_PAYER_PRIVATE_KEY or CAT_AGENT_PRIVATE_KEY");
}

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: normalizePrivateKey(payerKey),
  rpcUrl,
});

const balances = await client.getBalances();
console.log(
  `payer ${client.address} wallet=${balances.wallet.formatted} USDC gateway=${balances.gateway.formattedAvailable} USDC totalToSettle=${formatUnits(totalAtomic, 6)} USDC`,
);

if (balances.gateway.available < totalAtomic) {
  throw new Error(
    `insufficient Gateway balance: have ${balances.gateway.formattedAvailable} USDC, need ${formatUnits(totalAtomic, 6)} USDC. Deposit first; this script will not auto-deposit during freeze week.`,
  );
}

const results = [];
for (const row of selected) {
  try {
    // Do not pass an explicit content-type header. GatewayClient sets it, and a
    // duplicate lowercase header makes Circle reject the payment body.
    const result = await client.pay(`${baseUrl}/api/settlements`, {
      method: "POST",
      body: JSON.stringify(row),
    });
    results.push({
      cycle: row.cycle,
      spendTx: row.spendTx,
      amountUSDC: row.amountUSDC,
      gatewayTransaction: result.transaction,
      status: result.status,
      data: result.data,
    });
    console.log(`settled ${row.cycle} via Gateway transaction ${result.transaction || "n/a"}`);
  } catch (error) {
    console.error(`Gateway Desk settlement failed for ${row.cycle}: ${sanitizeError(error)}`);
    process.exitCode = 1;
    break;
  }
}

console.log("\nGateway Desk settlement results:");
console.log(JSON.stringify({ ok: process.exitCode !== 1, results }, stringifyBigInt, 2));

function selectDeskRows(entries, settled, maxRows) {
  return entries
    .filter((entry) => entry?.decision?.action === "PAY" && entry?.txs?.spend?.txHash && entry?.txs?.spend?.requestHash)
    .filter((entry) => !settled.has(entry.txs.spend.txHash.toLowerCase()))
    .slice(0, maxRows)
    .map((entry) => ({
      cycle: String(entry.cycle),
      spendTx: String(entry.txs.spend.txHash),
      settleTx: entry.txs?.settle?.txHash ? String(entry.txs.settle.txHash) : undefined,
      requestHash: String(entry.txs.spend.requestHash),
      amountUSDC: String(entry.txs.spend.amountUSDC || entry.decision?.amountAtomic || "0"),
      provider: String(entry.txs.spend.provider || entry.decision?.provider || "unknown"),
    }))
    .filter((row) => BigInt(row.amountUSDC) > 0n);
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json();
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "").replace(/\\n/g, "").trim()];
      }),
  );
}

function clean(value) {
  const cleaned = value?.replace(/\\n/g, "").trim();
  return cleaned || undefined;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function boundedInt(value, min, max, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sanitizeError(error) {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg
    .replace(/https?:\/\/[^\s"']+/gi, "[upstream]")
    .replace(/swrm_[a-z0-9]+/gi, "[redacted]")
    .replace(/croo_sk_[a-z0-9]+/gi, "[redacted]")
    .replace(/Bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted]");
  return (msg.split("\n")[0] || "").slice(0, 220).trim();
}

function stringifyBigInt(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
