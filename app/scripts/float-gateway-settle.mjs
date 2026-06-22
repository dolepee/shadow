// Add 1 of the Float differentiator stack: settle Float's take-rate fee through
// Circle Gateway as a batched sub-cent nanopayment, the Lepton headline rail.
//
// Float fronts real USDC to a provider on each allowed x402 spend. This script
// reads the live float totals, computes the protocol take-rate fee on settled
// float volume, and routes it through the proven Gateway client as a nanopayment.
// Modeled on gateway-settle-receipts.mjs (same client, same Arc testnet config,
// same gotchas). Dry-run by default; set GATEWAY_PAYER_PRIVATE_KEY (a Gateway-
// funded Arc testnet wallet) to actually settle.
import { existsSync, readFileSync } from "node:fs";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const env = {
  ...readVercelEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const baseUrl = (env.SHADOW_APP_URL || "https://shadow-arc.vercel.app").replace(/\/$/, "");
const payerKey = env.GATEWAY_PAYER_PRIVATE_KEY || env.BUYER_PRIVATE_KEY;
// Take-rate on settled float volume, in basis points. Kept small so the fee is a
// true nanopayment: 50 bps of a 0.001 USDC spend is 0.0000005 USDC.
const feeBps = Number(env.FLOAT_FEE_BPS || "50");
// Live settle target. A small float-fee route mirrors /api/settlements; until it
// exists the script stays a dry-run and prints the computed nanopayment batch.
const settleUrl = env.FLOAT_SETTLE_URL || `${baseUrl}/api/float-settle`;

const res = await fetch(`${baseUrl}/api/float`);
if (!res.ok) throw new Error(`/api/float failed: ${res.status}`);
const float = await res.json();

// totalProviderPaidUSDC is raw USDC (6dp): the float-fronted volume the fee is on.
const volumeAtomic = BigInt(float.totalProviderPaidUSDC || "0");
const feeAtomic = (volumeAtomic * BigInt(Math.round(feeBps))) / 10000n;

const batch = {
  kind: "float-fee",
  floatContract: float.float,
  settledVolumeUSDC: formatUsdc(volumeAtomic),
  feeBps,
  feeAtomic: feeAtomic.toString(),
  feeUSDC: formatUsdc(feeAtomic),
  receiptCount: float.receiptCount,
  asOf: new Date().toISOString(),
};

console.log("Float Gateway nanopayment batch:");
console.log(JSON.stringify(batch, null, 2));

if (feeAtomic === 0n) {
  console.log("No accrued float fee yet (zero settled volume). Nothing to batch.");
  process.exit(0);
}

if (!payerKey) {
  console.log("dry run only: set GATEWAY_PAYER_PRIVATE_KEY (a Gateway-funded Arc testnet wallet) to settle the fee via Gateway.");
  process.exit(0);
}

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: normalizePrivateKey(payerKey),
  rpcUrl: env.ARC_RPC_URL || env.VITE_ARC_RPC_URL,
});

try {
  // No explicit content-type: the Gateway client already sets Content-Type, and a
  // lowercase duplicate makes the platform reject the body.
  const result = await client.pay(settleUrl, {
    method: "POST",
    body: JSON.stringify(batch),
  });
  console.log("Gateway nanopayment settled:");
  console.log(JSON.stringify(result, stringifyBigInt, 2));
} catch (error) {
  // Never fake a settlement: a failed Gateway batch is reported, not swallowed.
  console.error(`Gateway settle failed: ${error.message}`);
  process.exit(1);
}

function readVercelEnv(path) {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, "utf8").split("\n");
  return Object.fromEntries(
    lines
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "").trim()];
      }),
  );
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function formatUsdc(atomic) {
  return (Number(atomic) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 7 });
}

function stringifyBigInt(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
