import { existsSync, readFileSync } from "node:fs";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const env = {
  ...readVercelEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const baseUrl = (env.SHADOW_APP_URL || "https://shadow-arc.vercel.app").replace(/\/$/, "");
const payerKey = env.GATEWAY_PAYER_PRIVATE_KEY || env.BUYER_PRIVATE_KEY;
const limit = Number(env.GATEWAY_SETTLEMENT_LIMIT || "5");

const stateRes = await fetch(`${baseUrl}/api/state?force=1`);
if (!stateRes.ok) throw new Error(`/api/state failed: ${stateRes.status}`);
const state = await stateRes.json();
const receipts = (state.receipts || [])
  .filter((item) => item.status === "copied" && !item.gatewaySettlement)
  .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 5);

if (receipts.length === 0) {
  console.log("No unsettled copied receipt found.");
  process.exit(0);
}

const bodies = receipts.map((receipt) => ({
  mirrorTx: receipt.transactionHash,
  follower: receipt.follower,
  sourceAgent: receipt.sourceAgent,
  intentId: receipt.intentId,
}));

console.log(`selected ${bodies.length} copied receipt(s):`);
console.log(JSON.stringify(bodies, null, 2));

if (!payerKey) {
  console.log("dry run only: set GATEWAY_PAYER_PRIVATE_KEY with a Gateway-funded Arc testnet wallet to settle.");
  process.exit(0);
}

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: normalizePrivateKey(payerKey),
  rpcUrl: env.ARC_RPC_URL || env.VITE_ARC_RPC_URL,
});

for (const body of bodies) {
  const result = await client.pay(`${baseUrl}/api/settlements`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });

  console.log("Gateway settlement result:");
  console.log(JSON.stringify(result, stringifyBigInt, 2));
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

function stringifyBigInt(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
