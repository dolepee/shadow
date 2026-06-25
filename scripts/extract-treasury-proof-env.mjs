import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const out = process.argv[3];

if (!file) {
  console.error("usage: node scripts/extract-treasury-proof-env.mjs <treasury-proof-json> [output-env]");
  process.exit(1);
}

const proof = JSON.parse(readFileSync(file, "utf8"));
const env = {
  TREASURY_VERIFY_CREATE_MANDATE_TX: proof.txs?.createMandate,
  TREASURY_VERIFY_ALLOWED_TX: proof.txs?.allowedAllocation,
  TREASURY_VERIFY_BLOCKED_TX: proof.txs?.blockedAllocation,
  TREASURY_VERIFY_X402_SETTLEMENT_TX: proof.txs?.x402Settlement,
  TREASURY_VERIFY_FLOAT_BIND_TX: proof.txs?.floatBind,
  TREASURY_VERIFY_ALLOWED_ACTION_HASH: proof.actionHashes?.allowed,
  TREASURY_VERIFY_BLOCKED_ACTION_HASH: proof.actionHashes?.blocked,
  TREASURY_VERIFY_FLOAT_REQUEST_HASH: proof.requestHash,
  TREASURY_VERIFY_ALLOWED_AMOUNT_ATOMIC: proof.amountsAtomic?.vaultAllowedUSDC,
  TREASURY_VERIFY_BLOCKED_AMOUNT_ATOMIC: proof.amountsAtomic?.vaultBlockedUSDC,
  TREASURY_VERIFY_X402_AMOUNT_ATOMIC: proof.amountsAtomic?.x402PaidUSDC,
  TREASURY_VERIFY_FEE_ATOMIC: proof.amountsAtomic?.floatFeeDeltaUSDC,
};

const lines = [];
for (const [key, value] of Object.entries(env)) {
  if (!value) {
    console.error(`missing ${key} in ${file}`);
    process.exit(1);
  }
  lines.push(`${key}=${value}`);
}

const text = `${lines.join("\n")}\n`;
process.stdout.write(text);
if (out) writeFileSync(out, text);
