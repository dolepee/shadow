import { decodeEventLog, getAddress, parseAbiItem } from "viem";
import { FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE } from "../floatV2Config.js";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export const intentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);

export async function findBoundDirectProviderPayment({
  publicClient,
  float,
  usdc,
  intent,
  requestHash,
  fromBlock,
  chunkSize = FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE,
}) {
  const latestBlock = await publicClient.getBlockNumber();
  let toBlock = latestBlock;

  while (toBlock >= fromBlock) {
    const candidateFromBlock = toBlock >= chunkSize - 1n ? toBlock - chunkSize + 1n : 0n;
    const chunkFromBlock = candidateFromBlock > fromBlock ? candidateFromBlock : fromBlock;
    const logs = await publicClient.getLogs({
      address: float,
      event: intentConsumedEvent,
      args: { agent: intent.agent, nonce: intent.nonce },
      fromBlock: chunkFromBlock,
      toBlock,
      strict: true,
    });
    const consumed = logs.find(
      (log) => String(log.args?.requestHash || "").toLowerCase() === requestHash.toLowerCase(),
    );
    if (consumed) {
      if (!consumed.transactionHash) {
        throw new Error("bound Float intent log is missing its transaction hash");
      }
      const receipt = await publicClient.getTransactionReceipt({ hash: consumed.transactionHash });
      return {
        txHash: consumed.transactionHash,
        providerPaidExactAmount: Boolean(
          findExactDirectProviderTransfer({
            logs: receipt.logs,
            float,
            usdc,
            provider: intent.provider,
            amountUSDC: intent.amountUSDC,
          }),
        ),
      };
    }
    if (chunkFromBlock === fromBlock) break;
    toBlock = chunkFromBlock - 1n;
  }

  throw new Error("unable to recover the transaction that consumed this bound Float intent");
}

export function findExactDirectProviderTransfer({ logs, float, usdc, provider, amountUSDC }) {
  const normalizedFloat = getAddress(float);
  const normalizedUsdc = getAddress(usdc);
  const normalizedProvider = getAddress(provider);
  return logs.find((log) => {
    if (getAddress(log.address) !== normalizedUsdc) return false;
    const decoded = decodeLog(transferEvent, log);
    return Boolean(
      decoded
        && getAddress(decoded.args.from) === normalizedFloat
        && getAddress(decoded.args.to) === normalizedProvider
        && decoded.args.value === amountUSDC,
    );
  });
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}
