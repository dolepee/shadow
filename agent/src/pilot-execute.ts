// End-to-end Pilot execution from CLI: fetches a plan from /api/pilot,
// then runs the same attest -> approve -> deposit -> followSource loop the
// browser executes. Use to validate the production flow without a wallet UI.
//
//   PILOT_FOLLOWER_KEY=0x... npm run agent:pilot-execute -- --execute
//
// Defaults to dry-run (prints the plan and the txs it would send).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

loadEnvFile();

const PILOT_API = process.env.PILOT_API || "https://shadow-two-opal.vercel.app/api/pilot";
const STATE_API = process.env.STATE_API || "https://shadow-two-opal.vercel.app/api/state";
const EXPLORER = "https://explorer.testnet.arc-node.thecanteenapp.com";
const EXECUTE = process.argv.includes("--execute");

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [requiredEnv("ARC_RPC_URL")] } },
});

const routerAbi = parseAbi([
  "function depositUSDC(uint256 amount)",
  "function followSource(address source, uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
  "function followerBalanceUSDC(address) view returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const attestorAbi = parseAbi([
  "function attest(bytes32 decisionHash, uint256 totalUSDC, uint8 sliceCount, uint16 confidenceBps, bytes32 modelHash)",
]);

type Preset = "conservative" | "balanced" | "aggressive";

const PRESETS: Record<Preset, { maxAmountPerIntent: string; dailyCap: string; maxRiskLevel: number; minBpsOut: number }> = {
  conservative: { maxAmountPerIntent: "0.2", dailyCap: "1", maxRiskLevel: 1, minBpsOut: 10000 },
  balanced: { maxAmountPerIntent: "0.5", dailyCap: "3", maxRiskLevel: 2, minBpsOut: 9500 },
  aggressive: { maxAmountPerIntent: "1", dailyCap: "5", maxRiskLevel: 3, minBpsOut: 9000 },
};

type PilotSlice = {
  sourceAddress: Address;
  name: string;
  weightBps: number;
  preset: Preset;
  amountUSDC: string;
  reason: string;
};

type PilotPlan = {
  model: string;
  fellBack: boolean;
  fellBackReason?: string;
  headline: string;
  confidenceBps: number;
  rationale: string;
  watchSignals: string[];
  allocation: PilotSlice[];
  generatedAt: number;
  decisionHash: Hex;
};

type StateSource = {
  address: Address;
  name: string;
  intentsPublished: number;
  copyCount: number;
  blockCount: number;
  copyRateBps: number;
  routedUSDC: string;
  mirrorFeesUSDC: string;
  closedCount: number;
  realizedPnlAvgBps: number | null;
};

await main();

async function main() {
  const router = requiredEnv("SHADOW_ROUTER") as Address;
  const usdc = requiredEnv("ARC_USDC") as Address;
  const arceth = requiredEnv("SHADOW_ARCETH") as Address;
  const attestor = (process.env.SHADOW_PILOT_ATTESTOR || "") as Address | "";

  const followerKey = normalizeKey(
    process.env.PILOT_FOLLOWER_KEY || requiredEnv("PRIVATE_KEY"),
  );
  const follower = privateKeyToAccount(followerKey);

  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(requiredEnv("ARC_RPC_URL")) });
  const wallet = createWalletClient({ account: follower, chain: arcTestnet, transport: http(requiredEnv("ARC_RPC_URL")) });

  console.log("=".repeat(60));
  console.log("Shadow Pilot end-to-end test");
  console.log("=".repeat(60));
  console.log(`follower:  ${follower.address}`);
  console.log(`router:    ${router}`);
  console.log(`usdc:      ${usdc}`);
  console.log(`attestor:  ${attestor || "(unset)"}`);
  console.log(`mode:      ${EXECUTE ? "EXECUTE" : "DRY RUN (pass --execute to send txs)"}`);
  console.log();

  const sources = await fetchSources();
  console.log(`Loaded ${sources.length} source agents from ${STATE_API}`);
  for (const s of sources) {
    const pnl = s.realizedPnlAvgBps == null ? "n/a" : `${s.realizedPnlAvgBps.toFixed(1)} bps`;
    console.log(`  · ${s.name} (${shortAddr(s.address)}) copyRate=${(s.copyRateBps / 100).toFixed(0)}% closes=${s.closedCount} pnl=${pnl}`);
  }
  console.log();

  const amountUSDC = process.env.PILOT_AMOUNT || "0.6";
  const risk = (process.env.PILOT_RISK || "balanced") as "low" | "balanced" | "high";
  console.log(`Asking pilot for ${amountUSDC} USDC @ ${risk} risk...`);
  const plan = await fetchPlan(amountUSDC, risk, sources);
  console.log();
  console.log(`Headline:   ${plan.headline}`);
  console.log(`Model:      ${plan.model}${plan.fellBack ? ` (fallback: ${plan.fellBackReason})` : ""}`);
  console.log(`Confidence: ${(plan.confidenceBps / 100).toFixed(0)}%`);
  console.log(`Slices:     ${plan.allocation.length}`);
  for (const slice of plan.allocation) {
    console.log(`  · ${slice.name} ${slice.amountUSDC} USDC @ ${slice.preset} (${(slice.weightBps / 100).toFixed(0)}%)`);
  }
  console.log(`DecisionHash: ${plan.decisionHash}`);
  console.log();

  const totalDeposit = plan.allocation.reduce(
    (sum, slice) => sum + parseUnits(slice.amountUSDC || "0", 6),
    0n,
  );
  console.log(`Total to deposit: ${formatUnits(totalDeposit, 6)} USDC`);

  const balance = await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [follower.address],
  });
  console.log(`Follower USDC:   ${formatUnits(balance, 6)} USDC`);
  if (balance < totalDeposit) {
    console.log();
    console.log(`ERROR: follower has ${formatUnits(balance, 6)} USDC but needs ${formatUnits(totalDeposit, 6)} USDC`);
    process.exit(2);
  }
  console.log();

  if (!EXECUTE) {
    console.log("Dry run complete. Pass --execute to send the txs.");
    return;
  }

  if (attestor) {
    console.log("[1/4] attest decision...");
    const decisionHash = normalizeBytes32(plan.decisionHash);
    const modelHash = keccak256(stringToBytes(plan.model));
    const attestTx = await wallet.writeContract({
      address: attestor,
      abi: attestorAbi,
      functionName: "attest",
      args: [decisionHash, totalDeposit, plan.allocation.length, plan.confidenceBps, modelHash],
    });
    console.log(`        tx ${attestTx}`);
    console.log(`        ${EXPLORER}/tx/${attestTx}`);
    await publicClient.waitForTransactionReceipt({ hash: attestTx });
    console.log("        confirmed");
  } else {
    console.log("[1/4] attest skipped (SHADOW_PILOT_ATTESTOR unset)");
  }
  console.log();

  console.log(`[2/4] approve ${formatUnits(totalDeposit, 6)} USDC to router...`);
  const approveTx = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [router, totalDeposit],
  });
  console.log(`        tx ${approveTx}`);
  console.log(`        ${EXPLORER}/tx/${approveTx}`);
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log("        confirmed");
  console.log();

  console.log(`[3/4] deposit ${formatUnits(totalDeposit, 6)} USDC...`);
  const depositTx = await wallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "depositUSDC",
    args: [totalDeposit],
  });
  console.log(`        tx ${depositTx}`);
  console.log(`        ${EXPLORER}/tx/${depositTx}`);
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log("        confirmed");
  console.log();

  console.log(`[4/4] follow ${plan.allocation.length} source(s)...`);
  for (let i = 0; i < plan.allocation.length; i++) {
    const slice = plan.allocation[i];
    const preset = PRESETS[slice.preset];
    console.log(`        (${i + 1}/${plan.allocation.length}) follow ${slice.name} as ${slice.preset}`);
    const followTx = await wallet.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "followSource",
      args: [
        slice.sourceAddress,
        parseUnits(preset.maxAmountPerIntent, 6),
        parseUnits(preset.dailyCap, 6),
        arceth,
        preset.maxRiskLevel,
        preset.minBpsOut,
      ],
    });
    console.log(`        tx ${followTx}`);
    console.log(`        ${EXPLORER}/tx/${followTx}`);
    await publicClient.waitForTransactionReceipt({ hash: followTx });
    console.log("        confirmed");
  }
  console.log();

  const idleAfter = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "followerBalanceUSDC",
    args: [follower.address],
  });
  console.log("=".repeat(60));
  console.log(`Pilot plan executed. Idle USDC on router: ${formatUnits(idleAfter, 6)} USDC`);
  console.log("=".repeat(60));
}

async function fetchSources(): Promise<StateSource[]> {
  const res = await fetch(STATE_API, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`state API ${res.status}`);
  const json = (await res.json()) as { sources?: Array<Record<string, unknown>> };
  if (!Array.isArray(json.sources)) throw new Error("state API: missing sources");
  return json.sources.map((s) => ({
    address: String(s.address) as Address,
    name: String(s.name || "source"),
    intentsPublished: Number(s.intentsPublished || 0),
    copyCount: Number(s.copyCount || 0),
    blockCount: Number(s.blockCount || 0),
    copyRateBps: Number(s.copyRateBps || 0),
    routedUSDC: String(s.routedUSDC || "0"),
    mirrorFeesUSDC: String(s.mirrorFeesUSDC || "0"),
    closedCount: Number(s.closedCount || 0),
    realizedPnlAvgBps: s.realizedPnlAvgBps == null ? null : Number(s.realizedPnlAvgBps),
  }));
}

async function fetchPlan(
  amountUSDC: string,
  risk: "low" | "balanced" | "high",
  sources: StateSource[],
): Promise<PilotPlan> {
  const res = await fetch(PILOT_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUSDC, risk, sources }),
  });
  if (!res.ok) throw new Error(`pilot API ${res.status}: ${await res.text()}`);
  return (await res.json()) as PilotPlan;
}

function normalizeKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function normalizeBytes32(hex: string): Hex {
  let v = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (v.length > 64) v = v.slice(0, 64);
  if (v.length < 64) v = v.padStart(64, "0");
  return `0x${v}` as Hex;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
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
    // optional
  }
}
