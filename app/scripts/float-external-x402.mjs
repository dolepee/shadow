import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  parseAbi,
  parseAbiItem,
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
//   node app/scripts/float-external-x402.mjs --verify-only path/to/intent.json
//   FLOAT_SIGNED_INTENT_JSON='{"intent":...,"signature":"0x..."}' node app/scripts/float-external-x402.mjs --verify-only

const env = {
  ...readEnv("/home/qdee/shadow/.env"),
  ...readEnv("/home/qdee/shadow/.vercel/.env.production.local"),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const RPC = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
const FLOAT = getAddress(clean(env.SHADOW_FLOAT || env.VITE_SHADOW_FLOAT) || "0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057");
const USDC = getAddress(clean(env.ARC_USDC || env.VITE_ARC_USDC) || "0x3600000000000000000000000000000000000000");
const FACILITATOR_KEY = normalizeKey(clean(env.FLOAT_FACILITATOR_PRIVATE_KEY || env.CAT_AGENT_PRIVATE_KEY || env.PRIVATE_KEY));
const PROVIDER_URL = clean(env.FLOAT_X402_PROVIDER_URL) || "https://shadow-arc.vercel.app/api/reasoning-x402";
const BIND_MODE = clean(env.FLOAT_BIND_MODE) || "legacy-v1";
const maxRuns = Number(clean(env.FLOAT_LOOP_MAX_RUNS) || "120");
const args = process.argv.slice(2);
const VERIFY_ONLY = args.includes("--verify-only");
const intentPath = args.find((arg) => arg !== "--verify-only");

if (!VERIFY_ONLY && !FACILITATOR_KEY) {
  throw new Error("missing FLOAT_FACILITATOR_PRIVATE_KEY (the Shadow facilitator that fronts the x402 payment)");
}

const { intent, signature, digest } = readSignedIntent(intentPath);
if (!intent || !signature) throw new Error("intent file must contain { intent, signature }");

const facilitator = FACILITATOR_KEY ? privateKeyToAccount(FACILITATOR_KEY) : null;
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });
const wallet = facilitator
  ? createWalletClient({ account: facilitator, chain, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) })
  : null;

const floatAbi = parseAbi([
  "function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash) view returns (bool allowed, uint8 reason)",
  "function recordX402Spend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash, bytes32 x402Hash, address facilitator) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function recordSignedX402Spend((address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,uint256 nonce,uint256 expiry,string reason) intent, bytes32 x402Hash, address facilitator, bytes signature) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);

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
if (digest && digest.toLowerCase() !== requestHash.toLowerCase()) {
  throw new Error(`digest mismatch: JSON digest ${digest}, recomputed requestHash ${requestHash}`);
}

console.log("Shadow Float signed external x402 spend");
console.log(`mode           ${VERIFY_ONLY ? "verify-only" : "bind"}`);
console.log(`bind mode      ${BIND_MODE}`);
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

if (VERIFY_ONLY) {
  console.log("\nverify-only passed. No x402 payment was made and no Float bind was submitted.");
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "verify-only",
        agent,
        provider,
        amountUSDC: amount.toString(),
        requestHash,
        signerMatchesAgent: true,
        digestMatchesRequestHash: !digest || digest.toLowerCase() === requestHash.toLowerCase(),
        previewAllowed: true,
        providerMatchesIntent: true,
        assetMatchesArcUSDC: true,
        verifyUrl: `https://shadow-arc.vercel.app/api/float-tools?action=verify&hash=${requestHash}`,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const facilitatorUsdc = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [facilitator.address] });
if (facilitatorUsdc < amount) {
  throw new Error(`facilitator needs ${formatUnits(amount, 6)} USDC to front, has ${formatUnits(facilitatorUsdc, 6)}`);
}

const x402 = await payProviderX402(PROVIDER_URL, provider, amount);
const bindTxHash = await recordFloatBind(agent, provider, intent.endpointHash, amount, requestHash, x402.txHash);

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
console.log(`verify          https://shadow-arc.vercel.app/api/float-tools?action=verify&hash=${requestHash}`);
console.log(JSON.stringify(run, null, 2));

async function recordFloatBind(agent_, provider_, endpointHash_, amount_, requestHash_, x402Hash_) {
  if (BIND_MODE === "signed-v2") {
    return recordSignedX402Spend(agent_, provider_, endpointHash_, amount_, requestHash_, x402Hash_);
  }
  if (BIND_MODE !== "legacy-v1") {
    throw new Error(`unknown FLOAT_BIND_MODE ${BIND_MODE}; expected legacy-v1 or signed-v2`);
  }
  return recordX402Spend(agent_, provider_, endpointHash_, amount_, requestHash_, x402Hash_);
}

async function recordX402Spend(agent_, provider_, endpointHash_, amount_, requestHash_, x402Hash_) {
  console.log("binding legacy recordX402Spend...");
  const duplicateCheck = await readFloat("receiptByRequestHash", [requestHash_]);
  if (duplicateCheck && duplicateCheck !== zeroHash()) {
    throw new Error(`intent was consumed before bind; refusing to persist x402 as bound (receipt ${duplicateCheck})`);
  }
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
  assertX402BoundReceipt(rcpt, { requestHash: requestHash_, x402Hash: x402Hash_, provider: provider_, amount: amount_ });
  const boundReceipt = await readFloat("receiptByRequestHash", [requestHash_]);
  if (!boundReceipt || boundReceipt === zeroHash()) {
    throw new Error(`recordX402Spend succeeded but receiptByRequestHash stayed empty: ${txHash}`);
  }
  return txHash;
}

async function recordSignedX402Spend(agent_, provider_, endpointHash_, amount_, requestHash_, x402Hash_) {
  console.log("binding signed-v2 recordSignedX402Spend...");
  const duplicateCheck = await readFloat("receiptByRequestHash", [requestHash_]);
  if (duplicateCheck && duplicateCheck !== zeroHash()) {
    throw new Error(`intent was consumed before bind; refusing to persist x402 as bound (receipt ${duplicateCheck})`);
  }
  const signedIntent = {
    agent: agent_,
    provider: provider_,
    endpointHash: endpointHash_,
    amountUSDC: amount_,
    nonce: BigInt(intent.nonce),
    expiry: BigInt(intent.expiry),
    reason: intent.reason,
  };
  const txHash = await wallet.writeContract({
    address: FLOAT,
    abi: floatAbi,
    functionName: "recordSignedX402Spend",
    args: [signedIntent, x402Hash_, facilitator.address, signature],
    account: facilitator,
    chain,
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (rcpt.status !== "success") throw new Error(`recordSignedX402Spend reverted: ${txHash}`);
  assertX402BoundReceipt(rcpt, { requestHash: requestHash_, x402Hash: x402Hash_, provider: provider_, amount: amount_ });
  const boundReceipt = await readFloat("receiptByRequestHash", [requestHash_]);
  if (!boundReceipt || boundReceipt === zeroHash()) {
    throw new Error(`recordSignedX402Spend succeeded but receiptByRequestHash stayed empty: ${txHash}`);
  }
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
  await assertX402SettlementTx(settled.txHash, { from: facilitator.address, to: payTo, amount: value });
  console.log(`x402 tx ${settled.txHash}`);
  return { txHash: settled.txHash };
}

async function assertX402SettlementTx(txHash, expected) {
  const [tx, receipt] = await Promise.all([
    publicClient.getTransaction({ hash: txHash }),
    publicClient.getTransactionReceipt({ hash: txHash }),
  ]);
  if (receipt.status !== "success") throw new Error(`x402 settlement tx failed: ${txHash}`);
  if (!tx.to || getAddress(tx.to) !== USDC) throw new Error(`x402 settlement tx did not call USDC: ${txHash}`);
  const matched = receipt.logs.some((log) => {
    if (getAddress(log.address) !== USDC) return false;
    const decoded = decodeLog(transferEvent, log);
    return Boolean(
      decoded &&
        getAddress(decoded.args.from) === getAddress(expected.from) &&
        getAddress(decoded.args.to) === getAddress(expected.to) &&
        decoded.args.value === expected.amount,
    );
  });
  if (!matched) {
    throw new Error(`x402 settlement tx did not transfer ${expected.amount} USDC from ${expected.from} to ${expected.to}: ${txHash}`);
  }
}

function assertX402BoundReceipt(receipt, expected) {
  const matched = receipt.logs.some((log) => {
    if (getAddress(log.address) !== FLOAT) return false;
    const decoded = decodeLog(x402PaymentBoundEvent, log);
    return Boolean(
      decoded &&
        decoded.args.requestHash?.toLowerCase() === expected.requestHash.toLowerCase() &&
        decoded.args.x402Hash?.toLowerCase() === expected.x402Hash.toLowerCase() &&
        getAddress(decoded.args.provider) === getAddress(expected.provider) &&
        decoded.args.amountUSDC === expected.amount &&
        getAddress(decoded.args.facilitator) === facilitator.address,
    );
  });
  if (!matched) throw new Error(`bind tx did not emit expected X402PaymentBound event: ${receipt.transactionHash}`);
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
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

function readSignedIntent(path) {
  const inline = clean(env.FLOAT_SIGNED_INTENT_JSON);
  if (inline) return JSON.parse(inline);
  if (path === "-") return JSON.parse(readFileSync(0, "utf8"));
  if (!path || !existsSync(path)) {
    throw new Error(
      "usage: node app/scripts/float-external-x402.mjs [--verify-only] path/to/intent.json (or set FLOAT_SIGNED_INTENT_JSON)",
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
