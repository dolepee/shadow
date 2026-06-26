import { createPublicClient, defineChain, getAddress, hashTypedData, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Shadow Float: external builder signs a spend intent.
//
// Your agent signs an EIP-712 FloatSpendIntent. No gas, no transaction, no USDC
// leaves your wallet. On V2, a sponsor or relayer can submit the signed intent
// and the contract verifies signer, nonce, expiry, executor, provider, endpoint,
// amount, and max debt before paying the provider directly or reimbursing an
// operator-assisted x402 settlement. Run on YOUR machine; your key never leaves it.
//
//   BUILDER_PRIVATE_KEY=0x... \
//   EXPECTED_AGENT=0x... \
//   RATIONALE="one true sentence: what your agent uses the paid call for" \
//   node app/scripts/float-builder-sign.mjs

const CHAIN_ID = 5_042_002;
const LEGACY_FLOAT = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const FLOAT_RAW = clean(process.env.SHADOW_FLOAT);
if (!FLOAT_RAW) throw new Error("set SHADOW_FLOAT to the deployed V2 ShadowFloat address before signing");
const FLOAT = getAddress(FLOAT_RAW);
if (FLOAT === LEGACY_FLOAT && clean(process.env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to sign against the known V1 ShadowFloat address; set SHADOW_FLOAT to V2 or ALLOW_LEGACY_FLOAT=1");
}
const PROVIDER = getAddress(clean(process.env.FLOAT_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937");
const ENDPOINT_HASH = clean(process.env.FLOAT_ENDPOINT_HASH) || "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160";
const AMOUNT = BigInt(clean(process.env.FLOAT_SPEND_ATOMIC) || "10000"); // 0.01 USDC (6 decimals)
const TTL_SECONDS = BigInt(clean(process.env.FLOAT_INTENT_TTL) || `${7 * 24 * 3600}`);
const EXECUTOR = clean(process.env.FLOAT_INTENT_EXECUTOR);
const RPC = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";

const KEY = normalizeKey(clean(process.env.BUILDER_PRIVATE_KEY));
const EXPECTED_AGENT = clean(process.env.EXPECTED_AGENT);
const REASON = clean(process.env.RATIONALE) || "";
if (!KEY) throw new Error("set BUILDER_PRIVATE_KEY to your registered agent wallet's key (it stays on your machine)");
if (!REASON) {
  throw new Error('set RATIONALE to one true sentence, e.g. RATIONALE="my research agent buys a market snapshot before it trades"');
}

const account = privateKeyToAccount(KEY);
const agent = account.address;
if (EXPECTED_AGENT && getAddress(EXPECTED_AGENT) !== agent) {
  throw new Error(`BUILDER_PRIVATE_KEY resolves to ${agent}, but qdee registered ${getAddress(EXPECTED_AGENT)}. Use the key for the registered agent wallet or ask qdee to register a different address.`);
}
const MAX_DEBT = await resolveMaxDebt(agent);
if (MAX_DEBT < AMOUNT) throw new Error("FLOAT_MAX_DEBT_ATOMIC must be >= FLOAT_SPEND_ATOMIC");

const domain = { name: "ShadowFloat", version: "1", chainId: CHAIN_ID, verifyingContract: FLOAT };
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
  agent,
  provider: PROVIDER,
  endpointHash: ENDPOINT_HASH,
  amountUSDC: AMOUNT,
  maxDebtUSDC: MAX_DEBT,
  nonce: BigInt(Date.now()),
  expiry: BigInt(Math.floor(Date.now() / 1000)) + TTL_SECONDS,
  executor: EXECUTOR ? getAddress(EXECUTOR) : "0x0000000000000000000000000000000000000000",
  reason: REASON,
};

const signature = await account.signTypedData({ domain, types, primaryType: "FloatSpendIntent", message });
const digest = hashTypedData({ domain, types, primaryType: "FloatSpendIntent", message });

// The digest is what Shadow sets as the on-chain requestHash, so this signature
// is verifiable against the on-chain receipt.
const output = {
  intent: {
    agent,
    provider: PROVIDER,
    endpointHash: ENDPOINT_HASH,
    amountUSDC: AMOUNT.toString(),
    maxDebtUSDC: MAX_DEBT.toString(),
    nonce: message.nonce.toString(),
    expiry: message.expiry.toString(),
    executor: message.executor,
    reason: REASON,
    float: FLOAT,
    chainId: CHAIN_ID,
  },
  signature,
  digest,
};

console.log(JSON.stringify(output, null, 2));
console.error("\nSigned. No transaction was sent and no funds moved. Send the JSON above to the Float sponsor/relayer.");
console.error(`digest (will be the on-chain requestHash): ${digest}`);

async function resolveMaxDebt(agentAddress) {
  const explicit = clean(process.env.FLOAT_MAX_DEBT_ATOMIC);
  if (explicit) return BigInt(explicit);

  const chain = defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [RPC] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 2 }) });
  const floatAbi = parseAbi([
    "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  ]);

  try {
    const line = await publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName: "lines", args: [agentAddress] });
    const activeDebtUSDC = line[4];
    return activeDebtUSDC + (AMOUNT * 110n) / 100n;
  } catch (error) {
    throw new Error(
      `could not read active debt for ${agentAddress}; set FLOAT_MAX_DEBT_ATOMIC explicitly. ${error?.shortMessage || error?.message || error}`,
    );
  }
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
