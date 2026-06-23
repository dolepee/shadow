import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Shadow Float: external builder self-spend.
//
// YOUR agent pushes this transaction with YOUR key, so on-chain the `from` is
// you, not Shadow. The Float treasury fronts the USDC to the provider and opens
// debt on your line. You never pre-fund the spend; you only need a little Arc
// testnet gas to send the transaction. Repay whenever you like.
//
// Run on YOUR machine. Your private key never leaves it and is never shared.
//
//   BUILDER_PRIVATE_KEY=0x...  (the agent wallet you registered)
//   RATIONALE="one true sentence: what your agent uses the paid call for"
//   node app/scripts/float-builder-spend.mjs

const RPC = clean(process.env.ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const CHAIN_ID = 5_042_002;
const FLOAT = getAddress(clean(process.env.SHADOW_FLOAT) || "0xe926A9b44250a0aB12156988beAf90f5e9ac7d3D");
const PROVIDER = getAddress(clean(process.env.FLOAT_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937");
const ENDPOINT_HASH = clean(process.env.FLOAT_ENDPOINT_HASH) || "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160";
const AMOUNT = BigInt(clean(process.env.FLOAT_SPEND_ATOMIC) || "10000"); // 0.01 USDC (6 decimals)

const KEY = normalizeKey(clean(process.env.BUILDER_PRIVATE_KEY));
const RATIONALE = clean(process.env.RATIONALE) || "";

if (!KEY) throw new Error("set BUILDER_PRIVATE_KEY to your registered agent wallet's key (it stays on your machine)");
if (!RATIONALE) {
  throw new Error('set RATIONALE to one true sentence, e.g. RATIONALE="my research agent buys a market snapshot before it trades"');
}

const account = privateKeyToAccount(KEY);
const agent = account.address; // must equal your line's wallet

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const abi = parseAbi([
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) view returns (bool allowed, uint8 reason)",
  "function requestSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
]);

// requestHash commits to YOUR reasoning. The preimage is printed so anyone can
// re-hash it and confirm the on-chain commitment is your real rationale.
const preimage = JSON.stringify({
  v: 1,
  domain: "shadow-float:builder-request",
  agent,
  action: "BUILDER_PAY",
  provider: PROVIDER,
  amountUSDC: AMOUNT.toString(),
  rationale: RATIONALE,
  salt: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
});
const requestHash = keccak256(stringToBytes(preimage));

console.log("Shadow Float builder self-spend");
console.log(`agent (you)  ${agent}`);
console.log(`float        ${FLOAT}`);
console.log(`provider     ${PROVIDER}`);
console.log(`amount       ${formatUnits(AMOUNT, 6)} USDC (the treasury fronts it, opens debt on your line)`);
console.log(`requestHash  ${requestHash}`);

const line = await publicClient.readContract({ address: FLOAT, abi, functionName: "lines", args: [agent] });
if (getAddress(line[0]) !== agent) {
  throw new Error(`your Float line's wallet is ${line[0]}, not ${agent}. Run from the exact wallet you registered.`);
}

const [allowed, reason] = await publicClient.readContract({
  address: FLOAT,
  abi,
  functionName: "previewSpend",
  args: [agent, PROVIDER, ENDPOINT_HASH, AMOUNT, requestHash],
});
if (!allowed) {
  throw new Error(`the spend would be blocked (reason code ${reason}). Your line must be ELIGIBLE and the amount within your limit.`);
}

const gas = await publicClient.getBalance({ address: agent });
if (gas === 0n) {
  throw new Error("your wallet has no Arc testnet gas. Get a little native balance (ping qdee for a dust top-up), then re-run.");
}

console.log("\nsending requestSpend from YOUR wallet...");
const txHash = await wallet.writeContract({
  address: FLOAT,
  abi,
  functionName: "requestSpend",
  args: [agent, PROVIDER, ENDPOINT_HASH, AMOUNT, requestHash],
  account,
  chain,
});
const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (rcpt.status !== "success") throw new Error(`tx reverted: ${txHash}`);

console.log("\ndone. YOUR wallet pushed this spend.");
console.log(`tx           ${txHash}`);
console.log(`arcscan      https://testnet.arcscan.app/tx/${txHash}`);
console.log(`requestHash  ${requestHash}`);
console.log(`preimage     ${preimage}`);
console.log("\nVerify: the tx `from` is your wallet, not Shadow. Re-hash the preimage to match requestHash.");
console.log("Then cite this tx in your Lepton update.");

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
