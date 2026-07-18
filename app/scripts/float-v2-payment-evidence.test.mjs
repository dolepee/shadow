import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import {
  findBoundDirectProviderPayment,
  findExactDirectProviderTransfer,
} from "./float-v2-payment-evidence.mjs";

const float = "0x1111111111111111111111111111111111111111";
const usdc = "0x2222222222222222222222222222222222222222";
const provider = "0x3333333333333333333333333333333333333333";
const facilitator = "0x4444444444444444444444444444444444444444";
const agent = "0x5555555555555555555555555555555555555555";
const requestHash = `0x${"66".repeat(32)}`;
const txHash = `0x${"77".repeat(32)}`;
const amountUSDC = 1_000n;
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

test("recovers direct provider payment from the original consumed-intent transaction", async () => {
  const receipt = { logs: [transferLog(float, provider, amountUSDC)] };
  const calls = [];
  const publicClient = {
    getBlockNumber: async () => 52_490_000n,
    getLogs: async (args) => {
      calls.push(args);
      return [{ args: { requestHash }, transactionHash: txHash }];
    },
    getTransactionReceipt: async ({ hash }) => {
      assert.equal(hash, txHash);
      return receipt;
    },
  };

  const evidence = await findBoundDirectProviderPayment({
    publicClient,
    float,
    usdc,
    intent: { agent, provider, nonce: 9n, amountUSDC },
    requestHash,
    fromBlock: 52_480_794n,
  });

  assert.equal(evidence.txHash, txHash);
  assert.equal(evidence.providerPaidExactAmount, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { agent, nonce: 9n });
});

test("rejects an x402-style facilitator reimbursement as direct provider payment", async () => {
  const receipt = { logs: [transferLog(float, facilitator, amountUSDC)] };
  const publicClient = {
    getBlockNumber: async () => 52_490_000n,
    getLogs: async () => [{ args: { requestHash }, transactionHash: txHash }],
    getTransactionReceipt: async () => receipt,
  };

  const evidence = await findBoundDirectProviderPayment({
    publicClient,
    float,
    usdc,
    intent: { agent, provider, nonce: 9n, amountUSDC },
    requestHash,
    fromBlock: 52_480_794n,
  });

  assert.equal(evidence.providerPaidExactAmount, false);
  assert.equal(
    findExactDirectProviderTransfer({ logs: receipt.logs, float, usdc, provider, amountUSDC }),
    undefined,
  );
});

function transferLog(from, to, value) {
  return {
    address: usdc,
    topics: encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}
