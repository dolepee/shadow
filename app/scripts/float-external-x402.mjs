import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  parseAbi,
  recoverTypedDataAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Shadow Float: operator executes a builder's SIGNED spend intent.
//
// The builder signed an EIP-712 FloatSpendIntent (see float-builder-sign.mjs)
// and sent us { intent, signature }. We verify the signature recovers to the
// agent, then front the x402 payment and bind the spend with requestHash set to
// the exact EIP-712 digest the builder signed. Anyone can then recover the
// signer from the on-chain requestHash plus the published signature and confirm
// the action came from the builder, even though Shadow submitted the tx.
//
//   node app/scripts/float-external-x402.mjs path/to/intent.json

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || "0x5d64750e199bb27Cb03C3C523A630a3dB215435b");
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const FACILITATOR_KEY = normalizeKey(clean(env.FLOAT_FACILITATOR_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY || env.PRIVATE_KEY));
const PROVIDER_URL = clean(env.FLOAT_X402_PROVIDER_URL) || "https://shadow-arc.vercel.app/api/reasoning-x402";
const maxRuns = Number(clean(env.FLOAT_LOOP_MAX_RUNS) || "120");

if (!FACILITATOR_KEY) throw new Error("missing FLOAT_FACILITATOR_PRIVATE_KEY (the Shadow facilitator that fronts the x402 payment)");

const intentPath = process.argv[2];
if (!intentPath || !existsSync(intentPath)) {
  throw new Error("usage: node app/scripts/float-external-x402.mjs path/to/intent.json (the { intent, signature } the builder sent)");
}
const { intent, signature } = JSON.parse(readFileSync(intentPath, "utf8"));
if (!intent || !signature) throw new Error("intent file must contain { intent, signature }");

const facilitator = privateKeyToAccount(FACILITATOR_KEY);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const wallet = createWalletClient({ account: facilitator, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });

const floatAbi = parseAbi([
  "function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) view returns (bool allowed, uint8 reason)",
  "function recordX402Spend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash, bytes32 x402Hash, address facilitator) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);

// 1. Rebuild the exact typed data and verify the builder's signature.
const agent = getAddress(intent.agent);
const provider = getAddress(intent.provider);
const amount = BigInt(intent.amountUSDC);
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
  provider,
  endpointHash: intent.endpointHash,
  amountUSDC: amount,
  nonce: BigInt(intent.nonce),
  expiry: BigInt(intent.expiry),
  reason: intent.reason,
};

const recovered = await recoverTypedDataAddress({ domain, types, primaryType: "FloatSpendIntent", message, signature });
if (getAddress(recovered) !== agent) {
  throw new Error(`signature recovers to ${recovered}, not the agent ${agent}. Refusing to spend.`);
}
if (BigInt(Math.floor(Date.now() / 1000)) > BigInt(intent.expiry)) {
  throw new Error("intent has expired. Ask the builder to sign a fresh one.");
}

// requestHash IS the signed digest, so the on-chain receipt commits to exactly
// what the builder signed (and the DUPLICATE_REQUEST guard blocks replay).
const requestHash = hashTypedData({ domain, types, primaryType: "FloatSpendIntent", message });

console.log("Shadow Float signed external x402 spend");
console.log(`agent (signer) ${agent}`);
console.log(`provider       ${provider}`);
console.log(`amount         ${formatUnits(amount, 6)} USDC (Shadow fronts it; debt opens on the agent's line)`);
console.log(`requestHash    ${requestHash}  (= the EIP-712 digest the builder signed)`);
console.log(`signature      ${signature}`);

const already = await readFloat("receiptByRequestHash", [requestHash]);
if (already && already !== zeroHash()) throw new Error(`this signed intent was already spent (receipt ${already}).`);

const [allowed, reason] = await readFloat("previewSpend", [agent, provider, intent.endpointHash, amount, requestHash]);
if (!allowed) throw new Error(`the spend would be blocked (reason code ${reason}). Check the agent's line is ELIGIBLE and within limit.`);

const requirement = await fetchX402Requirement(PROVIDER_URL);
if (getAddress(requirement.payTo) !== provider) {
  throw new Error(`provider mismatch: intent says ${provider}, x402 endpoint pays ${requirement.payTo}.`);
}
if (requirement.asset && getAddress(requirement.asset) !== USDC) {
  throw new Error(`x402 asset mismatch: expected ${USDC}, got ${requirement.asset}`);
}

const facilitatorUsdc = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [facilitator.address] });
if (facilitatorUsdc < amount) {
  throw new Error(`facilitator needs ${formatUnits(amount, 6)} USDC to front, has ${formatUnits(facilitatorUsdc, 6)}`);
}

const x402 = await payProviderX402(PROVIDER_URL, provider, amount);
const bindTxHash = await recordX402Spend(agent, provider, intent.endpointHash, amount, requestHash, x402.txHash);

const run = {
  version: 1,
  id: `float-signed-${Date.now()}-${agent.slice(2, 8)}`,
  source: "external-signed",
  action: "SIGNED_X402_PAY",
  outcome: "PAID_BOUND",
  at: new Date().toISOString(),
  network: "arc-testnet",
  float: FLOAT,
  facilitator: facilitator.address,
  agent,
  requestHash,
  signature,
  intent,
  x402Hash: x402.txHash,
  bindTxHash,
  amountUSDC: amount.toString(),
};
await persistRun(run);

console.log("\ndone. The builder's signed intent was fronted and bound on-chain.");
console.log(`x402 settlement ${x402.txHash}`);
console.log(`bind tx         ${bindTxHash}`);
console.log(`verify          https://shadow-arc.vercel.app/api/float-verify?hash=${requestHash}`);
console.log(JSON.stringify(run, null, 2));

async function recordX402Spend(agent_, provider_, endpointHash_, amount_, requestHash_, x402Hash_) {
  console.log("binding recordX402Spend...");
  const txHash = await wallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "recordX402Spend",
    args: [agent_, provider_, endpointHash_, amount_, requestHash_, x402Hash_, facilitator.address],
    account: facilitator,
    chain,
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (rcpt.status !== "success") throw new Error(`recordX402Spend reverted: ${txHash}`);
  return txHash;
}

async function payProviderX402(url, payTo, value) {
  console.log(`fronting x402 payment ${formatUnits(value, 6)} USDC`);
  const timestamp = Math.floor(Date.now() / 1000);
  const msg = {
    from: facilitator.address,
    to: payTo,
    value,
    validAfter: BigInt(timestamp - 60),
    validBefore: BigInt(timestamp + 600),
    nonce: generatePrivateKey(),
  };
  const sig = await facilitator.signTypedData({
    domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: msg,
  });
  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "arc-testnet",
    payload: {
      from: facilitator.address,
      to: payTo,
      value: value.toString(),
      validAfter: msg.validAfter.toString(),
      validBefore: msg.validBefore.toString(),
      nonce: msg.nonce,
      signature: sig,
    },
  };
  const response = await fetch(url, { headers: { "X-PAYMENT": Buffer.from(JSON.stringify(payload)).toString("base64url") } });
  const text = await response.text();
  if (!response.ok) throw new Error(`x402 provider returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  const paymentResponse = response.headers.get("x-payment-response");
  if (!paymentResponse) throw new Error("x402 provider did not return X-PAYMENT-RESPONSE");
  const settled = JSON.parse(Buffer.from(paymentResponse, "base64url").toString("utf8"));
  if (!settled.txHash || !/^0x[a-fA-F0-9]{64}$/.test(settled.txHash)) throw new Error(`invalid x402 settlement hash: ${settled.txHash}`);
  console.log(`x402 tx ${settled.txHash}`);
  return { txHash: settled.txHash };
}

async function fetchX402Requirement(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (response.status !== 402) throw new Error(`expected x402 HTTP 402 from provider, got ${response.status}`);
  const requirement = body.accepts?.[0];
  if (!requirement?.payTo || !isAddress(requirement.payTo)) throw new Error("x402 provider did not return a valid payTo");
  return requirement;
}

function readFloat(functionName, args) {
  return publicClient.readContract({ address: FLOAT, abi: floatAbi, functionName, args });
}

async function persistRun(run) {
  const url = clean(env.KV_REST_API_URL);
  const token = clean(env.KV_REST_API_TOKEN);
  if (!url || !token) {
    console.log("kv not configured; run printed only");
    return;
  }
  const base = url.replace(/\/$/, "");
  const current = await kvGet(base, token, "float:loop:runs");
  const history = Array.isArray(current) ? current : [];
  const next = history.concat([run]).slice(-maxRuns);
  await kvSet(base, token, "float:loop:latest", run);
  await kvSet(base, token, "float:loop:runs", next);
}

async function kvGet(base, token, key) {
  const response = await fetch(`${base}/get/${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const json = await response.json();
  if (json.result === null || json.result === undefined) return null;
  try {
    return JSON.parse(json.result);
  } catch {
    return json.result;
  }
}

async function kvSet(base, token, key, value) {
  const response = await fetch(`${base}/set/${encodeURIComponent(key)}?EX=2592000`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`kv set failed ${response.status}`);
}

function zeroHash() {
  return "0x0000000000000000000000000000000000000000000000000000000000000000";
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
