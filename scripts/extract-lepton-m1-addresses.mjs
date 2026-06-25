import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const out = process.argv[3];

if (!file) {
  console.error("usage: node scripts/extract-lepton-m1-addresses.mjs <broadcast-run-json> [output-json]");
  process.exit(1);
}

const run = JSON.parse(readFileSync(file, "utf8"));
const creates = (run.transactions ?? [])
  .filter((tx) => tx.transactionType === "CREATE")
  .map((tx) => ({ name: tx.contractName, address: tx.contractAddress, txHash: tx.hash }));

const expected = [
  "MandateRegistry",
  "MandateAttestor",
  "BondedMandateEnforcer",
  "MandateVaultSink",
  "V4StyleArcAdapter",
  "MandateVaultSink",
  "MorphoStyleVaultAdapter",
];

for (const [index, name] of expected.entries()) {
  const deployment = creates[index];
  if (!deployment || deployment.name !== name || !isAddress(deployment.address)) {
    console.error(`unexpected M1 deployment sequence at #${index}: expected ${name}, got ${deployment?.name || "missing"}`);
    process.exit(1);
  }
}

const result = {
  LEPTON_REGISTRY: creates[0].address,
  LEPTON_ATTESTOR: creates[1].address,
  LEPTON_ENFORCER: creates[2].address,
  LEPTON_V4_VAULT_SINK: creates[3].address,
  LEPTON_V4_STYLE_ADAPTER: creates[4].address,
  LEPTON_MORPHO_VAULT_SINK: creates[5].address,
  LEPTON_MORPHO_ADAPTER: creates[6].address,
  deployTxs: {
    mandateRegistry: creates[0].txHash,
    mandateAttestor: creates[1].txHash,
    bondedEnforcer: creates[2].txHash,
    v4VaultSink: creates[3].txHash,
    v4StyleAdapter: creates[4].txHash,
    morphoVaultSink: creates[5].txHash,
    morphoStyleVaultAdapter: creates[6].txHash,
  },
};

for (const [key, value] of Object.entries(result)) {
  if (typeof value === "string") console.log(`${key}=${value}`);
}

if (out) {
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || "");
}
