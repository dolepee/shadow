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

// Shadow Float: external builder repay. Closes the loop you opened with
// float-builder-spend.mjs. YOUR wallet repays YOUR line's debt, so onchain the
// sender is you. You need the small debt amount in testnet USDC plus a little
// gas. Run on YOUR machine; your key never leaves it.
//
//   SHADOW_FLOAT=0x... \
//   EXPECTED_AGENT=0x... \
//   BUILDER_PRIVATE_KEY=0x... \
//   node app/scripts/float-builder-repay.mjs

const RPC = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const CHAIN_ID = 5_042_002;
const LEGACY_FLOAT = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const FLOAT_RAW = clean(process.env.SHADOW_FLOAT);
if (!FLOAT_RAW) throw new Error("set SHADOW_FLOAT to the deployed V2 ShadowFloat address before repaying");
const FLOAT = getAddress(FLOAT_RAW);
if (FLOAT === LEGACY_FLOAT && clean(process.env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to repay against the known V1 ShadowFloat address; set SHADOW_FLOAT to V2 or ALLOW_LEGACY_FLOAT=1");
}
const USDC = getAddress(clean(process.env.ARC_USDC) || "0x3600000000000000000000000000000000000000");

const KEY = normalizeKey(clean(process.env.BUILDER_PRIVATE_KEY));
if (!KEY) throw new Error("set BUILDER_PRIVATE_KEY to your registered agent wallet's key (it stays on your machine)");
const EXPECTED_AGENT = clean(process.env.EXPECTED_AGENT);

const account = privateKeyToAccount(KEY);
const agent = account.address;
if (EXPECTED_AGENT && getAddress(EXPECTED_AGENT) !== agent) {
  throw new Error(`BUILDER_PRIVATE_KEY resolves to ${agent}, but expected ${getAddress(EXPECTED_AGENT)}`);
}
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const floatAbi = parseAbi([
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function repay(address agent, uint256 amountUSDC, bytes32 requestHash) returns (bytes32)",
]);
const ercAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const line = await publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lines", args: [agent] });
const debt = line[4];
console.log("Shadow Float builder repay");
console.log(`agent (you) ${agent}`);
console.log(`active debt ${formatUnits(debt, 6)} USDC`);
if (debt === 0n) {
  console.log("nothing to repay.");
  process.exit(0);
}

const bal = await publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "balanceOf", args: [agent] });
if (bal < debt) {
  throw new Error(
    `you need ${formatUnits(debt, 6)} USDC to repay, have ${formatUnits(bal, 6)}. Get a little testnet USDC (ping qdee), then re-run.`,
  );
}

const allowance = await publicClient.readContract({ address: USDC, abi: ercAbi, functionName: "allowance", args: [agent, FLOAT] });
if (allowance < debt) {
  console.log("approving USDC...");
  const approveTx = await wallet.writeContract({ address: USDC, abi: ercAbi, functionName: "approve", args: [FLOAT, debt], account, chain });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log(`approve tx ${approveTx}`);
}

const requestHash = keccak256(
  stringToBytes(
    JSON.stringify({
      v: 1,
      domain: "shadow-float:builder-repay",
      agent,
      amountUSDC: debt.toString(),
      salt: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    }),
  ),
);

console.log("repaying from YOUR wallet...");
const txHash = await wallet.writeContract({
  address: FLOAT,
  abi: floatAbi,
  functionName: "repay",
  args: [agent, debt, requestHash],
  account,
  chain,
});
const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (rcpt.status !== "success") throw new Error(`tx reverted: ${txHash}`);

console.log("\ndone. YOUR wallet repaid the line, full borrow-spend-repay loop closed.");
console.log(`tx          ${txHash}`);
console.log(`arcscan     https://testnet.arcscan.app/tx/${txHash}`);

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
