import { getAddress, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Shadow Float: external builder signs a spend intent.
//
// Your agent signs an EIP-712 FloatSpendIntent. No gas, no transaction, no USDC
// leaves your wallet. You send the printed JSON to Shadow. Shadow fronts the
// USDC, pays the x402 provider, and records the spend with your signed intent
// bound on-chain, so anyone can recover your signature and confirm the action
// came from you. Run on YOUR machine; your key never leaves it.
//
//   BUILDER_PRIVATE_KEY=0x... \
//   EXPECTED_AGENT=0x... \
//   RATIONALE="one true sentence: what your agent uses the paid call for" \
//   node app/scripts/float-builder-sign.mjs

const CHAIN_ID = 5_042_002;
const FLOAT = getAddress(clean(process.env.SHADOW_FLOAT) || "0xe926A9b44250a0aB12156988beAf90f5e9ac7d3D");
const PROVIDER = getAddress(clean(process.env.FLOAT_PROVIDER) || "0x8ddf06fE8985988d3e0883F945E891BD57084937");
const ENDPOINT_HASH = clean(process.env.FLOAT_ENDPOINT_HASH) || "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160";
const AMOUNT = BigInt(clean(process.env.FLOAT_SPEND_ATOMIC) || "10000"); // 0.01 USDC (6 decimals)
const TTL_SECONDS = BigInt(clean(process.env.FLOAT_INTENT_TTL) || `${7 * 24 * 3600}`);

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

const domain = { name: "ShadowFloat", version: "1", chainId: CHAIN_ID, verifyingContract: FLOAT };
const types = {
  FloatSpendIntent: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "reason", type: "string" },
  ],
};
const message = {
  agent,
  provider: PROVIDER,
  endpointHash: ENDPOINT_HASH,
  amountUSDC: AMOUNT,
  nonce: BigInt(Date.now()),
  expiry: BigInt(Math.floor(Date.now() / 1000)) + TTL_SECONDS,
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
    nonce: message.nonce.toString(),
    expiry: message.expiry.toString(),
    reason: REASON,
    float: FLOAT,
    chainId: CHAIN_ID,
  },
  signature,
  digest,
};

console.log(JSON.stringify(output, null, 2));
console.error("\nSigned. No transaction was sent and no funds moved. Send the JSON above to qdee.");
console.error(`digest (will be the on-chain requestHash): ${digest}`);

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
