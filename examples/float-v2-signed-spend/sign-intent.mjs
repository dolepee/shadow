import { createPublicClient, defineChain, getAddress, hashTypedData, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 5_042_002;
const SHADOW_FLOAT_V2 = getAddress("0x20dcA96B0C487D94De885c726c956ffaF38b12C2");
const SHADOW_FLOAT_V1 = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const ARC_RPC_URL = clean(process.env.ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const PROVIDER = getAddress(clean(process.env.FLOAT_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937");
const ENDPOINT_HASH = clean(process.env.FLOAT_ENDPOINT_HASH) || "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160";
const AMOUNT_USDC = BigInt(clean(process.env.FLOAT_AMOUNT_ATOMIC) || "10000");
const TTL_SECONDS = BigInt(clean(process.env.FLOAT_INTENT_TTL_SECONDS) || `${60 * 60}`);
const EXECUTOR = clean(process.env.FLOAT_EXECUTOR);
const REASON = clean(process.env.FLOAT_REASON) || "Example agent uses Shadow Float V2 for an approved paid provider request.";
const EXPECTED_AGENT = clean(process.env.EXPECTED_AGENT);
const KEY = normalizeKey(clean(process.env.BUILDER_PRIVATE_KEY));

if (!KEY) throw new Error("set BUILDER_PRIVATE_KEY to the local key for the registered agent wallet");
if (AMOUNT_USDC <= 0n) throw new Error("FLOAT_AMOUNT_ATOMIC must be greater than zero");

const float = getAddress(clean(process.env.SHADOW_FLOAT) || SHADOW_FLOAT_V2);
if (float === SHADOW_FLOAT_V1 && clean(process.env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to sign against ShadowFloat V1; set SHADOW_FLOAT to V2");
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
const floatAbi = parseAbi([
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
]);

const line = await publicClient.readContract({ address: float, abi: floatAbi, functionName: "lines", args: [account.address] });
const activeDebtUSDC = line[4];
const maxDebtUSDC = activeDebtUSDC + (AMOUNT_USDC * 110n) / 100n;
const now = Math.floor(Date.now() / 1000);

const domain = {
  name: "ShadowFloat",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: float,
};
const types = {
  FloatSpendIntent: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "maxDebtUSDC", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "reason", type: "string" },
  ],
};
const message = {
  agent: account.address,
  provider: PROVIDER,
  endpointHash: ENDPOINT_HASH,
  amountUSDC: AMOUNT_USDC,
  maxDebtUSDC,
  nonce: BigInt(Date.now()),
  expiry: BigInt(now) + TTL_SECONDS,
  executor: EXECUTOR ? getAddress(EXECUTOR) : "0x0000000000000000000000000000000000000000",
  reason: REASON,
};

const signature = await account.signTypedData({ domain, types, primaryType: "FloatSpendIntent", message });
const digest = hashTypedData({ domain, types, primaryType: "FloatSpendIntent", message });

console.log(JSON.stringify({
  intent: {
    ...message,
    amountUSDC: message.amountUSDC.toString(),
    maxDebtUSDC: message.maxDebtUSDC.toString(),
    nonce: message.nonce.toString(),
    expiry: message.expiry.toString(),
    float,
    chainId: CHAIN_ID,
  },
  signature,
  digest,
}, null, 2));

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
