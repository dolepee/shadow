import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Revoke stale no-debt Float lines and grant replacement invited lines through
// the deterministic v0 score path.
//
//   REVOKE_AGENTS="0xOld" GRANT_AGENTS="0xNew" node app/scripts/float-reassign-line.mjs

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const ZERO = "0x0000000000000000000000000000000000000000";
const CHAIN_ID = 5_042_002;
const INVITED_LABEL = 2;
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || "0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const OWNER_KEY = normalizeKey(clean(env.FLOAT_ADMIN_PRIVATE_KEY || env.PRIVATE_KEY || env.FLOAT_OWNER_PRIVATE_KEY));
const AUTO_FUND = clean(env.FLOAT_AUTO_FUND) === "1";
const revokeAgents = parseAgents(clean(env.REVOKE_AGENTS));
const grantAgents = parseAgents(clean(env.GRANT_AGENTS));

if (!OWNER_KEY) throw new Error("missing FLOAT_ADMIN_PRIVATE_KEY or PRIVATE_KEY (the ShadowFloat owner)");
if (!revokeAgents.length && !grantAgents.length) throw new Error("set REVOKE_AGENTS and/or GRANT_AGENTS");

const account = privateKeyToAccount(OWNER_KEY);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const abi = parseAbi([
  "function owner() view returns (address)",
  "function fund(uint256 amountUSDC)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function recommendedLimitUSDC(uint16 score) view returns (uint256)",
  "function deterministicScore(uint8 label, uint16 paidBound, uint16 signedExternalPaid, uint16 repaid, uint16 blocked, uint16 denied, uint16 errorCount) view returns (uint16)",
  "function revoke(address agent, bytes32 requestHash) returns (bytes32)",
  "function grantFloatFromScore(address agent, address wallet, uint8 label, uint16 paidBound, uint16 signedExternalPaid, uint16 repaid, uint16 blocked, uint16 denied, uint16 errorCount, bytes32 mandateId, uint64 expiry) returns (bytes32)",
]);

const owner = getAddress(await publicClient.readContract({ address: FLOAT, abi, functionName: "owner" }));
console.log(`float ${FLOAT}`);
console.log(`owner ${owner} (you: ${account.address})`);
if (owner !== getAddress(account.address)) throw new Error(`your key is not the owner, cannot reassign. owner=${owner}`);

for (const agent of revokeAgents) {
  const line = await readLine(agent);
  if (line.wallet === ZERO || line.status === 4) {
    console.log(`skip revoke ${agent}: already absent/revoked`);
    continue;
  }
  if (line.activeDebtUSDC > 0n) {
    throw new Error(`refusing to revoke ${agent}: active debt ${formatUnits(line.activeDebtUSDC, 6)} USDC`);
  }
  const requestHash = keccak256(stringToBytes(`shadow-float-revoke-${agent.toLowerCase()}-${Date.now()}`));
  console.log(`revoking stale line ${agent}...`);
  const tx = await wallet.writeContract({
    address: FLOAT,
    abi,
    functionName: "revoke",
    args: [agent, requestHash],
    account,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`revoke reverted: ${tx}`);
  console.log(`revoked ${agent} tx ${tx}`);
}

const plannedGrants = [];
for (const agent of grantAgents) {
  const line = await readLine(agent);
  if (line.wallet !== ZERO && line.status !== 4) {
    console.log(`skip grant ${agent}: already has a live line (limit ${formatUnits(line.creditLimitUSDC, 6)} USDC, status ${line.status})`);
    continue;
  }
  plannedGrants.push(agent);
}

if (plannedGrants.length && AUTO_FUND) {
  const score = await deterministicInvitedScore();
  const recommendedLimit = await publicClient.readContract({
    address: FLOAT,
    abi,
    functionName: "recommendedLimitUSDC",
    args: [score],
  });
  const [balance, totalAvailable] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [FLOAT] }),
    publicClient.readContract({ address: FLOAT, abi, functionName: "totalAvailableCreditUSDC" }),
  ]);
  const requiredNewReserve = recommendedLimit * BigInt(plannedGrants.length);
  const freeReserve = balance > totalAvailable ? balance - totalAvailable : 0n;
  if (freeReserve < requiredNewReserve) {
    const shortfall = requiredNewReserve - freeReserve;
    const ownerBalance = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (ownerBalance < shortfall) {
      throw new Error(`owner needs ${formatUnits(shortfall, 6)} USDC to reserve new lines, has ${formatUnits(ownerBalance, 6)}`);
    }
    console.log(`funding Float treasury reserve shortfall ${formatUnits(shortfall, 6)} USDC...`);
    const approveTx = await wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [FLOAT, shortfall],
      account,
      chain,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (approveReceipt.status !== "success") throw new Error(`USDC approve reverted: ${approveTx}`);
    const fundTx = await wallet.writeContract({
      address: FLOAT,
      abi,
      functionName: "fund",
      args: [shortfall],
      account,
      chain,
    });
    const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    if (fundReceipt.status !== "success") throw new Error(`Float fund reverted: ${fundTx}`);
    console.log(`funded Float treasury tx ${fundTx}`);
  } else {
    console.log(`treasury has enough free reserve (${formatUnits(freeReserve, 6)} USDC)`);
  }
}

for (const agent of plannedGrants) {
  const mandateId = keccak256(stringToBytes(`shadow-float-external-${agent.toLowerCase()}`));
  console.log(`granting deterministic invited line to ${agent}...`);
  const tx = await wallet.writeContract({
    address: FLOAT,
    abi,
    functionName: "grantFloatFromScore",
    args: [agent, agent, INVITED_LABEL, 0, 0, 0, 0, 0, 0, mandateId, 0n],
    account,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`grant reverted: ${tx}`);
  const line = await readLine(agent);
  console.log(`granted ${agent} tx ${tx} score ${line.score} limit ${formatUnits(line.creditLimitUSDC, 6)} USDC`);
}

console.log("done.");

async function readLine(agent) {
  const line = await publicClient.readContract({ address: FLOAT, abi, functionName: "lines", args: [agent] });
  return {
    wallet: getAddress(line[0]),
    score: Number(line[1]),
    creditLimitUSDC: line[2],
    availableCreditUSDC: line[3],
    activeDebtUSDC: line[4],
    status: Number(line[5]),
  };
}

async function deterministicInvitedScore() {
  return await publicClient.readContract({
    address: FLOAT,
    abi,
    functionName: "deterministicScore",
    args: [INVITED_LABEL, 0, 0, 0, 0, 0, 0],
  });
}

function parseAgents(value) {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!isAddress(item)) throw new Error(`invalid address: ${item}`);
      return getAddress(item);
    });
}

function readEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "").trim()];
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
