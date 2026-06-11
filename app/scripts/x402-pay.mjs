// Live x402 payer: signs an Arc testnet USDC EIP-3009 authorization with the
// cat agent key and calls the gated reasoning endpoint.
import { readFileSync } from "node:fs";
import { createPublicClient, http, defineChain, erc20Abi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const envFile = readFileSync("/home/qdee/shadow/.vercel/.env.production.local", "utf8");
const env = Object.fromEntries(
  envFile.split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "").trim()];
  }),
);

const RPC = env.ARC_RPC_URL || env.VITE_ARC_RPC_URL;
const KEY = env.CAT_AGENT_PRIVATE_KEY;
if (!RPC || !KEY) throw new Error("missing rpc or key in env file");

const USDC = "0x3600000000000000000000000000000000000000";
const PAY_TO = "0x8ddf06fE8985988d3e0883F945E891BD57084937";
const CHAIN_ID = 5_042_002;
const VALUE = 1000n;

const chain = defineChain({
  id: CHAIN_ID,
  name: "arc-testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
const client = createPublicClient({ chain, transport: http(RPC) });

const [usdcBal, gasBal] = await Promise.all([
  client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  client.getBalance({ address: account.address }),
]);
console.log(`payer ${account.address} usdc=${usdcBal} gas=${gasBal}`);
if (usdcBal < VALUE) throw new Error("payer has no USDC");

const now = Math.floor(Date.now() / 1000);
const message = {
  from: account.address,
  to: PAY_TO,
  value: VALUE,
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + 600),
  nonce: generatePrivateKey(), // random 32 bytes
};
const signature = await account.signTypedData({
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
  message,
});

const payload = {
  x402Version: 1,
  scheme: "exact",
  network: "arc-testnet",
  payload: {
    from: account.address,
    to: PAY_TO,
    value: VALUE.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce: message.nonce,
    signature,
  },
};
const header = Buffer.from(JSON.stringify(payload)).toString("base64url");

const res = await fetch("https://shadow-arc.vercel.app/api/reasoning-x402", {
  headers: { "X-PAYMENT": header },
});
console.log("HTTP", res.status);
const paymentResponse = res.headers.get("x-payment-response");
if (paymentResponse) {
  console.log("X-PAYMENT-RESPONSE:", Buffer.from(paymentResponse, "base64url").toString("utf8"));
}
const body = await res.text();
console.log(body.slice(0, 700));
