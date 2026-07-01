import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  hashTypedData,
  http,
  parseAbi,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Prepares or records a provider-signed delivery receipt for a V2 direct spend.
//
// Prepare typed data for a provider to sign:
//   FLOAT_DELIVERY_PREPARE=1 FLOAT_REQUEST_HASH=0x... FLOAT_AGENT=0x... \
//   FLOAT_PROVIDER=0x... FLOAT_ENDPOINT_HASH=0x... FLOAT_AMOUNT_ATOMIC=1000 \
//   FLOAT_RESPONSE_HASH=0x... node app/scripts/float-v2-provider-delivery.mjs
//
// Submit a returned provider signature:
//   FLOAT_EXECUTOR_PRIVATE_KEY=0x... \
//   node app/scripts/float-v2-provider-delivery.mjs provider-delivery.json

const env = {
  ...readEnv(".env"),
  ...readEnv(".vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const LEGACY_FLOAT = getAddress("0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT || env.FLOAT_CONTRACT));
if (!FLOAT) throw new Error("set SHADOW_FLOAT to the deployed V2 ShadowFloat address");
if (FLOAT === LEGACY_FLOAT && clean(env.ALLOW_LEGACY_FLOAT) !== "1") {
  throw new Error("refusing to use the known V1 ShadowFloat address; set SHADOW_FLOAT to V2");
}

const domain = { name: "ShadowFloat", version: "1", chainId: CHAIN_ID, verifyingContract: FLOAT };
const types = {
  ProviderDeliveryReceipt: [
    { name: "requestHash", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "responseHash", type: "bytes32" },
    { name: "deliveredAt", type: "uint256" },
  ],
};

if (clean(env.FLOAT_DELIVERY_PREPARE) === "1") {
  const delivery = normalizeDelivery({
    requestHash: env.FLOAT_REQUEST_HASH,
    agent: env.FLOAT_AGENT,
    provider: env.FLOAT_PROVIDER,
    endpointHash: env.FLOAT_ENDPOINT_HASH,
    amountUSDC: env.FLOAT_AMOUNT_ATOMIC || env.FLOAT_AMOUNT_USDC,
    responseHash: env.FLOAT_RESPONSE_HASH,
    deliveredAt: env.FLOAT_DELIVERED_AT || `${Math.floor(Date.now() / 1000)}`,
  });
  const digest = hashTypedData({ domain, types, primaryType: "ProviderDeliveryReceipt", message: delivery });
  console.log(
    JSON.stringify(
      {
        purpose: "Provider signs this EIP-712 receipt to confirm delivery for the exact paid request.",
        typedData: {
          domain,
          types,
          primaryType: "ProviderDeliveryReceipt",
          message: stringifyDelivery(delivery),
        },
        delivery: stringifyDelivery(delivery),
        digest,
        expectedReturn: { delivery: stringifyDelivery(delivery), signature: "0x...", digest },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const payloadPath = clean(process.argv[2] || env.FLOAT_DELIVERY_PATH);
if (!payloadPath) {
  throw new Error("usage: FLOAT_DELIVERY_PREPARE=1 ... node app/scripts/float-v2-provider-delivery.mjs OR node app/scripts/float-v2-provider-delivery.mjs provider-delivery.json");
}

const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
const delivery = normalizeDelivery(payload.delivery);
const signature = clean(payload.signature);
if (!signature) throw new Error("provider delivery JSON is missing signature");

const digest = hashTypedData({ domain, types, primaryType: "ProviderDeliveryReceipt", message: delivery });
if (clean(payload.digest) && clean(payload.digest).toLowerCase() !== digest.toLowerCase()) {
  throw new Error(`delivery digest mismatch: payload ${clean(payload.digest)}, recomputed ${digest}`);
}
const recovered = await recoverTypedDataAddress({ domain, types, primaryType: "ProviderDeliveryReceipt", message: delivery, signature });
if (getAddress(recovered) !== delivery.provider) {
  throw new Error(`provider signature recovers ${recovered}, expected ${delivery.provider}`);
}

const key = normalizeKey(
  clean(env.FLOAT_EXECUTOR_PRIVATE_KEY || env.FLOAT_SPONSOR_PRIVATE_KEY || env.FLOAT_FUNDER_PRIVATE_KEY || env.PRIVATE_KEY || env.FLOAT_ADMIN_PRIVATE_KEY),
);
if (!key) throw new Error("set FLOAT_EXECUTOR_PRIVATE_KEY to submit recordProviderDelivery");

const account = privateKeyToAccount(key);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const floatAbi = parseAbi([
  "function recordProviderDelivery((bytes32 requestHash,address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 responseHash,uint256 deliveredAt) delivery, bytes signature) returns (bytes32)",
  "function providerDeliveryByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);

const existing = await publicClient.readContract({
  address: FLOAT,
  abi: floatAbi,
  functionName: "providerDeliveryByRequestHash",
  args: [delivery.requestHash],
});
if (!isZeroHash(existing)) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        alreadyRecorded: true,
        requestHash: delivery.requestHash,
        deliveryHash: existing,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const txHash = await wallet.writeContract({
  address: FLOAT,
  abi: floatAbi,
  functionName: "recordProviderDelivery",
  args: [delivery, signature],
  account,
  chain,
});
console.error(`recordProviderDelivery: ${txHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
if (receipt.status !== "success") throw new Error(`recordProviderDelivery reverted: ${txHash}`);
const recorded = await publicClient.readContract({
  address: FLOAT,
  abi: floatAbi,
  functionName: "providerDeliveryByRequestHash",
  args: [delivery.requestHash],
});

const ok = recorded.toLowerCase() === digest.toLowerCase();
console.log(
  JSON.stringify(
    {
      ok,
      txHash,
      arcscan: `https://testnet.arcscan.app/tx/${txHash}`,
      requestHash: delivery.requestHash,
      deliveryHash: recorded,
      digest,
      provider: delivery.provider,
    },
    null,
    2,
  ),
);
if (!ok) process.exit(1);

function normalizeDelivery(raw) {
  if (!raw) throw new Error("missing delivery object");
  const requestHash = clean(raw.requestHash);
  const endpointHash = clean(raw.endpointHash);
  const responseHash = clean(raw.responseHash);
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestHash || "")) throw new Error("delivery.requestHash must be bytes32");
  if (!/^0x[0-9a-fA-F]{64}$/.test(endpointHash || "")) throw new Error("delivery.endpointHash must be bytes32");
  if (!/^0x[0-9a-fA-F]{64}$/.test(responseHash || "")) throw new Error("delivery.responseHash must be bytes32");
  return {
    requestHash,
    agent: getAddress(raw.agent),
    provider: getAddress(raw.provider),
    endpointHash,
    amountUSDC: BigInt(raw.amountUSDC),
    responseHash,
    deliveredAt: BigInt(raw.deliveredAt),
  };
}

function stringifyDelivery(delivery) {
  return {
    requestHash: delivery.requestHash,
    agent: delivery.agent,
    provider: delivery.provider,
    endpointHash: delivery.endpointHash,
    amountUSDC: delivery.amountUSDC.toString(),
    responseHash: delivery.responseHash,
    deliveredAt: delivery.deliveredAt.toString(),
  };
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

function isZeroHash(value) {
  return String(value || "").toLowerCase() === "0x0000000000000000000000000000000000000000000000000000000000000000";
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
