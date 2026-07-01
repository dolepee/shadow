import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Opens or refreshes a Shadow Float V2 sponsored line from the sponsor's wallet.
//
// This is the smallest external-sponsor handoff:
//   1. sponsor approves the V2 Float contract for the reserve;
//   2. sponsor calls openSponsoredLine for the target agent;
//   3. if the same sponsor already owns the line, sponsor only refreshes the provider mandate.
//
// Required env:
//   SHADOW_FLOAT=0x...
//   FLOAT_SPONSOR_PRIVATE_KEY=0x...
//   FLOAT_AGENT=0x...
//
// Optional env:
//   ARC_RPC_URL=https://rpc.testnet.arc.network
//   FLOAT_PROVIDER=0x...
//   FLOAT_ENDPOINT_HASH=0x...
//   FLOAT_V2_LINE_ATOMIC=50000
//   FLOAT_V2_MAX_PER_REQUEST_ATOMIC=10000
//   FLOAT_V2_DAILY_LIMIT_ATOMIC=50000
//   FLOAT_V2_LINE_TTL=604800
//   FLOAT_V2_PROVIDER_TTL=604800
//   SPONSOR_LINE_DRY_RUN=1

const env = {
  ...readEnv(".env"),
  ...readEnv(".vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const LEGACY_FLOAT = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const FLOAT_RAW = clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT);
if (!FLOAT_RAW) throw new Error("set SHADOW_FLOAT to the deployed V2 ShadowFloat address");
const FLOAT = getAddress(FLOAT_RAW);
if (FLOAT === LEGACY_FLOAT && clean(env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to open a V2 sponsored line against the known V1 ShadowFloat address");
}

const SPONSOR_KEY = normalizeKey(clean(env.FLOAT_SPONSOR_PRIVATE_KEY || env.FLOAT_FUNDER_PRIVATE_KEY));
if (!SPONSOR_KEY) throw new Error("set FLOAT_SPONSOR_PRIVATE_KEY to the sponsor wallet key");

const AGENT_RAW = clean(env.FLOAT_AGENT || env.EXPECTED_AGENT);
if (!AGENT_RAW) throw new Error("set FLOAT_AGENT to the agent wallet receiving the sponsored line");
const AGENT = getAddress(AGENT_RAW);
const PROVIDER = getAddress(clean(env.FLOAT_PROVIDER || env.VITE_FLOAT_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937");
const ENDPOINT_HASH =
  clean(env.FLOAT_ENDPOINT_HASH || env.VITE_FLOAT_ENDPOINT_HASH) ||
  "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160";
if (!/^0x[0-9a-fA-F]{64}$/.test(ENDPOINT_HASH)) throw new Error("FLOAT_ENDPOINT_HASH must be bytes32");

const RESERVE = positiveAtomic(env.FLOAT_V2_LINE_ATOMIC, "50000", "FLOAT_V2_LINE_ATOMIC");
const MAX_PER_REQUEST = positiveAtomic(env.FLOAT_V2_MAX_PER_REQUEST_ATOMIC, "10000", "FLOAT_V2_MAX_PER_REQUEST_ATOMIC");
const DAILY_LIMIT = positiveAtomic(env.FLOAT_V2_DAILY_LIMIT_ATOMIC, RESERVE.toString(), "FLOAT_V2_DAILY_LIMIT_ATOMIC");
const LINE_TTL = positiveSeconds(env.FLOAT_V2_LINE_TTL, `${7 * 24 * 3600}`, "FLOAT_V2_LINE_TTL");
const PROVIDER_TTL = positiveSeconds(env.FLOAT_V2_PROVIDER_TTL, `${7 * 24 * 3600}`, "FLOAT_V2_PROVIDER_TTL");
const DRY_RUN = clean(env.SPONSOR_LINE_DRY_RUN) === "1";

if (MAX_PER_REQUEST > RESERVE) throw new Error("FLOAT_V2_MAX_PER_REQUEST_ATOMIC cannot exceed FLOAT_V2_LINE_ATOMIC");
if (DAILY_LIMIT > RESERVE) throw new Error("FLOAT_V2_DAILY_LIMIT_ATOMIC cannot exceed FLOAT_V2_LINE_ATOMIC");

const sponsor = privateKeyToAccount(SPONSOR_KEY);
const now = BigInt(Math.floor(Date.now() / 1000));
const lineExpiry = now + LINE_TTL;
const providerExpiry = now + PROVIDER_TTL;
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const wallet = createWalletClient({ account: sponsor, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });

const floatAbi = parseAbi([
  "function openSponsoredLine(address agent,uint256 reserveUSDC,bytes32 mandateId,uint64 lineExpiry,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 providerExpiry) returns (bytes32)",
  "function setSponsoredProviderMandate(address agent,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function autonomousLineScore(address agent) view returns (uint16 score,uint256 recommendedLimitUSDC,uint256 cappedLimitUSDC)",
  "function lineProviderMandates(address agent,address provider) view returns (bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
]);

console.log("Shadow Float V2 sponsor line");
console.log(`float    ${FLOAT}`);
console.log(`sponsor  ${sponsor.address}`);
console.log(`agent    ${AGENT}`);
console.log(`provider ${PROVIDER}`);
console.log(`reserve  ${formatUnits(RESERVE, 6)} USDC`);
console.log(`max req  ${formatUnits(MAX_PER_REQUEST, 6)} USDC`);
console.log(`daily    ${formatUnits(DAILY_LIMIT, 6)} USDC`);
if (DRY_RUN) console.log("dryRun   true");

const [balance, allowance, gas, existingSponsor, existingLine, scorePreview] = await Promise.all([
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [sponsor.address] }),
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [sponsor.address, FLOAT] }),
  publicClient.getBalance({ address: sponsor.address }),
  publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lineSponsors", args: [AGENT] }),
  publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lines", args: [AGENT] }),
  publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "autonomousLineScore", args: [AGENT] }),
]);

if (balance < RESERVE) {
  throw new Error(`sponsor needs ${formatUnits(RESERVE, 6)} USDC reserve, has ${formatUnits(balance, 6)} USDC`);
}
if (gas === 0n) throw new Error("sponsor wallet has no native Arc gas");

const txs = {};
const existingSponsorAddress = getAddress(existingSponsor[0]);
const isExistingLine = existingSponsorAddress !== zeroAddress();
if (isExistingLine && existingSponsorAddress !== sponsor.address) {
  throw new Error(`agent already has a sponsored line from ${existingSponsorAddress}`);
}

if (DRY_RUN) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: true,
        action: isExistingLine ? "refresh_provider_mandate" : "open_sponsored_line",
        sponsor: sponsor.address,
        agent: AGENT,
        float: FLOAT,
        usdc: USDC,
        provider: PROVIDER,
        endpointHash: ENDPOINT_HASH,
        reserveUSDC: RESERVE.toString(),
        maxPerRequestUSDC: MAX_PER_REQUEST.toString(),
        dailyLimitUSDC: DAILY_LIMIT.toString(),
        sponsorUSDCBalance: balance.toString(),
        currentAllowance: allowance.toString(),
        existingLine: lineToJson(existingLine),
        currentAutonomousScoreView: scoreToJson(scorePreview),
        expectedOpeningLine: isExistingLine
          ? null
          : {
              score: 7500,
              recommendedLimitUSDC: "25000",
              cappedLimitUSDC: minUint(RESERVE, 25_000n).toString(),
              note: "openSponsoredLine applies the sponsored baseline label inside the transaction",
            },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!isExistingLine && allowance < RESERVE) {
  const approveTx = await wallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [FLOAT, RESERVE],
    account: sponsor,
    chain,
  });
  txs.approve = approveTx;
  await waitSuccess(approveTx, "approve sponsor reserve");
}

if (isExistingLine) {
  const mandateTx = await writeFloat("setSponsoredProviderMandate", [
    AGENT,
    PROVIDER,
    ENDPOINT_HASH,
    MAX_PER_REQUEST,
    DAILY_LIMIT,
    providerExpiry,
    true,
  ]);
  txs.setSponsoredProviderMandate = mandateTx;
} else {
  const mandateId = randomHash(`external-sponsor-${sponsor.address}-${AGENT}`);
  const openTx = await writeFloat("openSponsoredLine", [
    AGENT,
    RESERVE,
    mandateId,
    lineExpiry,
    PROVIDER,
    ENDPOINT_HASH,
    MAX_PER_REQUEST,
    DAILY_LIMIT,
    providerExpiry,
  ]);
  txs.openSponsoredLine = openTx;
}

const [lineAfter, sponsorAfter, mandateAfter, scoreAfter] = await Promise.all([
  publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lines", args: [AGENT] }),
  publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lineSponsors", args: [AGENT] }),
  publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lineProviderMandates", args: [AGENT, PROVIDER] }),
  publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "autonomousLineScore", args: [AGENT] }),
]);

const ok =
  getAddress(sponsorAfter[0]) === sponsor.address &&
  sponsorAfter[1] === RESERVE &&
  getAddress(lineAfter[0]) === AGENT &&
  mandateAfter[0].toLowerCase() === ENDPOINT_HASH.toLowerCase() &&
  mandateAfter[1] === MAX_PER_REQUEST &&
  mandateAfter[2] === DAILY_LIMIT &&
  Boolean(mandateAfter[4]);

console.log(
  JSON.stringify(
    {
      ok,
      action: isExistingLine ? "refresh_provider_mandate" : "open_sponsored_line",
      float: FLOAT,
      usdc: USDC,
      sponsor: sponsor.address,
      agent: AGENT,
      provider: PROVIDER,
      endpointHash: ENDPOINT_HASH,
      txs,
      sponsorLine: {
        sponsor: sponsorAfter[0],
        reserveUSDC: sponsorAfter[1].toString(),
      },
      line: lineToJson(lineAfter),
      providerMandate: {
        endpointHash: mandateAfter[0],
        maxPerRequestUSDC: mandateAfter[1].toString(),
        dailyLimitUSDC: mandateAfter[2].toString(),
        expiry: mandateAfter[3].toString(),
        active: mandateAfter[4],
      },
      autonomousScore: scoreToJson(scoreAfter),
    },
    null,
    2,
  ),
);
if (!ok) process.exit(1);

async function writeFloat(functionName, args) {
  const txHash = await wallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName,
    args,
    account: sponsor,
    chain,
  });
  await waitSuccess(txHash, functionName);
  return txHash;
}

async function waitSuccess(txHash, label) {
  console.error(`${label}: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${txHash}`);
  return receipt;
}

function lineToJson(line) {
  return {
    wallet: line[0],
    score: line[1],
    creditLimitUSDC: line[2].toString(),
    availableCreditUSDC: line[3].toString(),
    activeDebtUSDC: line[4].toString(),
    status: line[5],
    lastReview: line[6].toString(),
    mandateId: line[7],
    day: line[8].toString(),
    spentTodayUSDC: line[9].toString(),
  };
}

function scoreToJson(score) {
  return {
    score: score[0],
    recommendedLimitUSDC: score[1].toString(),
    cappedLimitUSDC: score[2].toString(),
  };
}

function randomHash(seed) {
  return `0x${Buffer.from(`${seed}-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function positiveAtomic(value, fallback, label) {
  const parsed = BigInt(clean(value) || fallback);
  if (parsed <= 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function positiveSeconds(value, fallback, label) {
  const parsed = BigInt(clean(value) || fallback);
  if (parsed <= 0n || parsed > 10n * 365n * 24n * 3600n) throw new Error(`${label} is outside the safe range`);
  return parsed;
}

function minUint(a, b) {
  return a < b ? a : b;
}

function readEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
      }),
  );
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}

function zeroAddress() {
  return "0x0000000000000000000000000000000000000000";
}
