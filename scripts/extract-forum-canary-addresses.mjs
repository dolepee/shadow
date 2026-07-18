import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/extract-forum-canary-addresses.mjs <broadcast-run-json>");
  process.exit(1);
}

const run = JSON.parse(readFileSync(file, "utf8"));
const latestByName = new Map();

for (const tx of run.transactions ?? []) {
  if (!tx.contractName || !tx.contractAddress) continue;
  latestByName.set(tx.contractName, tx.contractAddress);
}

const required = ["MockAsset", "ShadowAMM", "SourceRegistry", "MirrorFeeSplitter", "CanaryMirrorRouter"];
for (const name of required) {
  if (!latestByName.has(name)) {
    throw new Error(`broadcast artifact is missing ${name}`);
  }
}

console.log(`FORUM_CANARY_ASSET=${latestByName.get("MockAsset")}`);
console.log(`FORUM_CANARY_AMM=${latestByName.get("ShadowAMM")}`);
console.log(`FORUM_CANARY_REGISTRY=${latestByName.get("SourceRegistry")}`);
console.log(`FORUM_CANARY_SPLITTER=${latestByName.get("MirrorFeeSplitter")}`);
console.log(`FORUM_CANARY_ROUTER=${latestByName.get("CanaryMirrorRouter")}`);
