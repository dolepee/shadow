import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, getAddress, http, keccak256, parseAbi, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 5_042_002;
const SHADOW_FLOAT_V2 = getAddress("0x20dcA96B0C487D94De885c726c956ffaF38b12C2");
const SHADOW_FLOAT_V1 = getAddress("0xf305647ba0ff7f1e2d4bE5f37F2EF9f930531057");
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const ARC_RPC_URL = clean(process.env.ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const KEY = normalizeKey(clean(process.env.BUILDER_PRIVATE_KEY));
const EXPECTED_AGENT = clean(process.env.EXPECTED_AGENT);

if (!KEY) throw new Error("set BUILDER_PRIVATE_KEY to the local key for the registered agent wallet");

const float = getAddress(clean(process.env.SHADOW_FLOAT) || SHADOW_FLOAT_V2);
if (float === SHADOW_FLOAT_V1 && clean(process.env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to repay against ShadowFloat V1; set SHADOW_FLOAT to V2");
}

const account = privateKeyToAccount(KEY);
if (EXPECTED_AGENT && getAddress(EXPECTED_AGENT) !== account.address) {
  throw new Error(`BUILDER_PRIVATE_KEY resolves to ${account.address}, expected ${getAddress(EXPECTED_AGENT)}`);
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
});
const publicClient = createPublicClient({ chain, transport: http(ARC_RPC_URL, { timeout: 30_000, retryCount: 2 }) });
const wallet = createWalletClient({ account, chain, transport: http(ARC_RPC_URL, { timeout: 30_000, retryCount: 2 }) });
const floatAbi = parseAbi([
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function repay(address agent,uint256 amountUSDC,bytes32 requestHash) returns (bytes32)",
]);

const line = await publicClient.readContract({ address: float, abi: floatAbi, functionName: "lines", args: [account.address] });
const activeDebtUSDC = line[4];
console.log(`agent: ${account.address}`);
console.log(`active debt: ${formatUnits(activeDebtUSDC, 6)} USDC`);

if (activeDebtUSDC === 0n) {
  console.log("nothing to repay");
  process.exit(0);
}

const balance = await publicClient.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (balance < activeDebtUSDC) {
  throw new Error(`insufficient Arc USDC: need ${formatUnits(activeDebtUSDC, 6)}, have ${formatUnits(balance, 6)}`);
}

const allowance = await publicClient.readContract({
  address: ARC_USDC,
  abi: erc20Abi,
  functionName: "allowance",
  args: [account.address, float],
});
if (allowance < activeDebtUSDC) {
  const approveTx = await wallet.writeContract({
    address: ARC_USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [float, activeDebtUSDC],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log(`approve: https://testnet.arcscan.app/tx/${approveTx}`);
}

const requestHash = keccak256(stringToBytes(JSON.stringify({
  v: 1,
  domain: "shadow-float:example-repay",
  agent: account.address,
  amountUSDC: activeDebtUSDC.toString(),
  salt: `${Date.now()}`,
})));
const repayTx = await wallet.writeContract({
  address: float,
  abi: floatAbi,
  functionName: "repay",
  args: [account.address, activeDebtUSDC, requestHash],
  account,
  chain,
});
await publicClient.waitForTransactionReceipt({ hash: repayTx });
console.log(`repay: https://testnet.arcscan.app/tx/${repayTx}`);

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
