import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
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
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || "0x5d64750e199bb27Cb03C3C523A630a3dB215435b");
const OWNER_KEY = normalizeKey(clean(env.FLOAT_FACILITATOR_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY || env.PRIVATE_KEY));
const LIMIT = BigInt(clean(env.FLOAT_EXTERNAL_LIMIT_ATOMIC) || "50000"); // 0.05 USDC
const SCORE = Number(clean(env.FLOAT_EXTERNAL_SCORE) || "8000");

if (!OWNER_KEY) throw new Error("missing FLOAT_FACILITATOR_PRIVATE_KEY (the ShadowFloat owner)");

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
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function grantFloat(address agent, address wallet, uint256 creditLimitUSDC, uint16 score, bytes32 mandateId) returns (bytes32)",
]);

const owner = await publicClient.readContract({ address: FLOAT, abi, functionName: "owner" });
console.log(`float ${FLOAT}`);
console.log(`owner ${owner} (you: ${account.address})`);
if (getAddress(owner) !== getAddress(account.address)) {
  throw new Error(`your key is not the owner, cannot grant. owner=${owner}`);
}

for (const agent of agents) {
  const line = await publicClient.readContract({ address: FLOAT, abi, functionName: "lines", args: [agent] });
  if (String(line[0]).toLowerCase() !== ZERO) {
    console.log(`skip ${agent}: already has a line (limit ${formatUnits(line[2], 6)} USDC, status ${line[5]})`);
    continue;
  }
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
