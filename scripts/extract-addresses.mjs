import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/extract-addresses.mjs <broadcast-run-json>");
  process.exit(1);
}

const run = JSON.parse(readFileSync(file, "utf8"));
const deployments = [];
const seen = new Set();

for (const tx of run.transactions ?? []) {
  if (!tx.contractName || !tx.contractAddress) continue;
  const key = `${tx.contractName}:${tx.contractAddress.toLowerCase()}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deployments.push({ name: tx.contractName, address: tx.contractAddress });
}

const latestByName = new Map();
for (const deployment of deployments) {
  latestByName.set(deployment.name, deployment.address);
}

const mockAssets = deployments.filter((deployment) => deployment.name === "MockAsset");
const shadowAmm = latestByName.get("ShadowAMM");
const shadowRegistry = latestByName.get("SourceRegistry");
const shadowRouter = latestByName.get("MirrorRouter");
const arcDeploy = file.includes("DeployShadowArc");

if (mockAssets.length > 0) {
  if (arcDeploy) {
    console.log(`SHADOW_ARCETH=${mockAssets[0].address}`);
  } else {
    console.log(`SHADOW_USDC=${mockAssets[0].address}`);
    if (mockAssets[1]) console.log(`SHADOW_ARCETH=${mockAssets[1].address}`);
  }
}
if (shadowAmm) console.log(`SHADOW_AMM=${shadowAmm}`);
if (shadowRegistry) console.log(`SHADOW_REGISTRY=${shadowRegistry}`);
if (shadowRouter) console.log(`SHADOW_ROUTER=${shadowRouter}`);

console.log("");
console.log("# Raw contract names");
for (const [name, address] of latestByName) {
  console.log(`${name}=${address}`);
}
