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

// Shadow Float: owner grants a standard external builder line. Idempotent:
// skips any address that already has a line.
//
//   node app/scripts/float-grant-line.mjs 0xBuilder [0xBuilder...]

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const ZERO = "0x0000000000000000000000000000000000000000";
const CHAIN_ID = 5_042_002;
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || "0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const OWNER_KEY = normalizeKey(clean(env.FLOAT_ADMIN_PRIVATE_KEY || env.PRIVATE_KEY || env.FLOAT_OWNER_PRIVATE_KEY));
const LIMIT = BigInt(clean(env.FLOAT_EXTERNAL_LIMIT_ATOMIC) || "50000"); // 0.05 USDC
const SCORE = Number(clean(env.FLOAT_EXTERNAL_SCORE) || "8000");
const AUTO_FUND = clean(env.FLOAT_AUTO_FUND) === "1";

if (!OWNER_KEY) throw new Error("missing FLOAT_ADMIN_PRIVATE_KEY or PRIVATE_KEY (the ShadowFloat owner)");

const agents = process.argv
  .slice(2)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((a) => {
    if (!isAddress(a)) throw new Error(`invalid address: ${a}`);
    return getAddress(a);
  });
if (!agents.length) throw new Error("usage: node app/scripts/float-grant-line.mjs 0xBuilder [0xBuilder...]");

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
  "function grantFloat(address agent, address wallet, uint256 creditLimitUSDC, uint16 score, bytes32 mandateId) returns (bytes32)",
]);

const owner = await publicClient.readContract({ address: FLOAT, abi, functionName: "owner" });
console.log(`float ${FLOAT}`);
console.log(`owner ${owner} (you: ${account.address})`);
if (getAddress(owner) !== getAddress(account.address)) {
  throw new Error(`your key is not the owner, cannot grant. owner=${owner}`);
}

const planned = [];
for (const agent of agents) {
  const line = await publicClient.readContract({ address: FLOAT, abi, functionName: "lines", args: [agent] });
  if (String(line[0]).toLowerCase() !== ZERO) {
    console.log(`skip ${agent}: already has a line (limit ${formatUnits(line[2], 6)} USDC, status ${line[5]})`);
    continue;
  }
  planned.push(agent);
}

if (planned.length && AUTO_FUND) {
  const [balance, totalAvailable] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [FLOAT] }),
    publicClient.readContract({ address: FLOAT, abi, functionName: "totalAvailableCreditUSDC" }),
  ]);
  const requiredNewReserve = LIMIT * BigInt(planned.length);
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
    const approveRcpt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (approveRcpt.status !== "success") throw new Error(`USDC approve reverted: ${approveTx}`);
    const fundTx = await wallet.writeContract({
      address: FLOAT,
      abi,
      functionName: "fund",
      args: [shortfall],
      account,
      chain,
    });
    const fundRcpt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    if (fundRcpt.status !== "success") throw new Error(`Float fund reverted: ${fundTx}`);
    console.log(`funded Float treasury tx ${fundTx}`);
  } else {
    console.log(`treasury has enough free reserve (${formatUnits(freeReserve, 6)} USDC)`);
  }
}

for (const agent of planned) {
  const mandateId = keccak256(stringToBytes(`shadow-float-external-${agent.toLowerCase()}`));
  console.log(`granting ${agent} a ${formatUnits(LIMIT, 6)} USDC line...`);
  const tx = await wallet.writeContract({
    address: FLOAT,
    abi,
    functionName: "grantFloat",
    args: [agent, agent, LIMIT, SCORE, mandateId],
    account,
    chain,
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") throw new Error(`grant reverted: ${tx}`);
  console.log(`granted ${agent} tx ${tx}`);
}
console.log("done.");

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
