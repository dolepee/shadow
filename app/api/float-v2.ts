import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hash,
} from "viem";

export const config = { maxDuration: 20 };

const ARC_CHAIN_ID = 5_042_002;
const ARC_RPC_URL = process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network";
const FLOAT_V2_CONTRACT = "0x20dcA96B0C487D94De885c726c956ffaF38b12C2" as Address;
const FLOAT_V2_DEPLOY_BLOCK = 48_837_320n;
const LOG_CHUNK_SIZE = BigInt(process.env.FLOAT_V2_LOG_CHUNK_SIZE || "9000");

type VercelLikeRequest = {
  method?: string;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

type TrackedAgent = {
  label: string;
  agent: Address;
  spendTx?: Hash;
  repayTx?: Hash;
};

type AgentStats = TrackedAgent & {
  signedIntents: number;
  providerPaidCount: number;
  repaidCount: number;
  blockedCount: number;
  providerPaidUSDC: bigint;
  repaidUSDC: bigint;
  blockedUSDC: bigint;
  latestTxHash?: Hash;
};

const TRACKED_EXTERNAL_AGENTS: readonly TrackedAgent[] = [
  { label: "Forum", agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770" },
  { label: "CitePay", agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" },
  {
    label: "Crux",
    agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092",
    spendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d",
    repayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368",
  },
  { label: "Argus", agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC" },
  { label: "Argus Beta", agent: "0x7d4897489bfc663b90baaf5b0803d18ae0ca817c" },
  { label: "Argus Gamma", agent: "0x43e0630025fd0339be1fa04d3d75daf355f50c89" },
  {
    label: "Obol",
    agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3",
    spendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a",
  },
  { label: "Driplet", agent: "0x7dF8C7ab755A62a5ea3356372Ad875d8C88084BF" },
] as const;

const STATUS_NAMES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"] as const;

const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] }, public: { http: [ARC_RPC_URL] } },
});

const floatV2Abi = parseAbi([
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function totalSponsoredReserveUSDC() view returns (uint256)",
]);

const intentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);

const receiptEvent = parseAbiItem(
  "event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)",
);

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  try {
    const client = createPublicClient({
      chain: arcTestnet,
      transport: http(ARC_RPC_URL),
    });
    const latestBlock = await client.getBlockNumber();
    const stats = new Map<string, AgentStats>();

    for (const entry of TRACKED_EXTERNAL_AGENTS) {
      const agent = getAddress(entry.agent);
      stats.set(agent.toLowerCase(), {
        ...entry,
        agent,
        signedIntents: 0,
        providerPaidCount: 0,
        repaidCount: 0,
        blockedCount: 0,
        providerPaidUSDC: 0n,
        repaidUSDC: 0n,
        blockedUSDC: 0n,
      });
    }

    const logWarnings = await enrichStatsFromLogs(client, stats, latestBlock);
    const [treasuryBalance, totalAvailableCredit, totalSponsoredReserve] = await Promise.all([
      client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "treasuryBalanceUSDC" }),
      client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "totalAvailableCreditUSDC" }),
      client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "totalSponsoredReserveUSDC" }),
    ]);

    const agents = await Promise.all(
      [...stats.values()].map(async (entry) => {
        const [line, sponsorLine] = await Promise.all([
          client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lines", args: [entry.agent] }),
          client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lineSponsors", args: [entry.agent] }),
        ]);
        const status = Number(line[5]);
        return {
          label: entry.label,
          category: "external",
          agent: entry.agent,
          wallet: line[0],
          score: Number(line[1]),
          creditLimitUSDC: line[2].toString(),
          availableCreditUSDC: line[3].toString(),
          activeDebtUSDC: line[4].toString(),
          status,
          statusName: STATUS_NAMES[status] || "UNKNOWN",
          sponsor: sponsorLine[0],
          sponsorReserveUSDC: sponsorLine[1].toString(),
          signedIntents: entry.signedIntents,
          providerPaidCount: entry.providerPaidCount,
          repaidCount: entry.repaidCount,
          blockedCount: entry.blockedCount,
          providerPaidUSDC: entry.providerPaidUSDC.toString(),
          repaidUSDC: entry.repaidUSDC.toString(),
          blockedUSDC: entry.blockedUSDC.toString(),
          spendTx: entry.spendTx,
          repayTx: entry.repayTx,
          latestTxHash: entry.latestTxHash,
        };
      }),
    );

    const visibleAgents = agents.sort((a, b) => {
      const aDebt = BigInt(a.activeDebtUSDC) > 0n ? 1 : 0;
      const bDebt = BigInt(b.activeDebtUSDC) > 0n ? 1 : 0;
      if (a.statusName === "REPAID" && b.statusName !== "REPAID") return -1;
      if (b.statusName === "REPAID" && a.statusName !== "REPAID") return 1;
      if (aDebt !== bDebt) return bDebt - aDebt;
      return a.label.localeCompare(b.label);
    });

    const summary = {
      registeredExternalLines: visibleAgents.filter((agent) => BigInt(agent.sponsorReserveUSDC) > 0n).length,
      signedIntents: visibleAgents.reduce((sum, agent) => sum + agent.signedIntents, 0),
      paidSpends: visibleAgents.reduce((sum, agent) => sum + agent.providerPaidCount, 0),
      repaidLifecycles: visibleAgents.filter((agent) => BigInt(agent.repaidUSDC) > 0n && BigInt(agent.activeDebtUSDC) === 0n).length,
      openDebtAgents: visibleAgents.filter((agent) => BigInt(agent.activeDebtUSDC) > 0n).length,
      providerPaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.providerPaidUSDC), 0n).toString(),
      repaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.repaidUSDC), 0n).toString(),
      activeDebtUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.activeDebtUSDC), 0n).toString(),
      blockedUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.blockedUSDC), 0n).toString(),
    };

    res.status(200).json({
      ok: true,
      mode: "shadow-float-v2-activity",
      checkedAt: new Date().toISOString(),
      chainId: ARC_CHAIN_ID,
      float: FLOAT_V2_CONTRACT,
      latestBlock: latestBlock.toString(),
      treasuryBalanceUSDC: treasuryBalance.toString(),
      totalAvailableCreditUSDC: totalAvailableCredit.toString(),
      totalSponsoredReserveUSDC: totalSponsoredReserve.toString(),
      summary,
      agents: visibleAgents,
      selfTestAgents: [],
      logFetch: {
        fromBlock: FLOAT_V2_DEPLOY_BLOCK.toString(),
        toBlock: latestBlock.toString(),
        complete: logWarnings.length === 0,
        warnings: logWarnings,
      },
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ ok: false, mode: "shadow-float-v2-activity", error: sanitizeError(error) });
  }
}

async function enrichStatsFromLogs(client: any, stats: Map<string, AgentStats>, latestBlock: bigint) {
  const warnings: string[] = [];
  for (let start = FLOAT_V2_DEPLOY_BLOCK; start <= latestBlock; start += LOG_CHUNK_SIZE) {
    const end = start + LOG_CHUNK_SIZE - 1n > latestBlock ? latestBlock : start + LOG_CHUNK_SIZE - 1n;
    try {
      const logs = await client.getLogs({ address: FLOAT_V2_CONTRACT, fromBlock: start, toBlock: end });
      for (const log of logs) {
        const intent = decodeLog(log, intentConsumedEvent);
        if (intent) {
          const stat = stats.get(String(intent.args.agent).toLowerCase());
          if (stat) {
            stat.signedIntents += 1;
            stat.latestTxHash = log.transactionHash;
          }
          continue;
        }
        const receipt = decodeLog(log, receiptEvent);
        if (!receipt) continue;
        const stat = stats.get(String(receipt.args.agent).toLowerCase());
        if (!stat) continue;
        const receiptType = Number(receipt.args.receiptType);
        const amount = toBigInt(receipt.args.amountUSDC);
        if (receiptType === 3) {
          stat.blockedCount += 1;
          stat.blockedUSDC += amount;
          stat.latestTxHash = log.transactionHash;
        }
        if (receiptType === 4) {
          stat.providerPaidCount += 1;
          stat.providerPaidUSDC += amount;
          stat.latestTxHash = log.transactionHash;
        }
        if (receiptType === 6) {
          stat.repaidCount += 1;
          stat.repaidUSDC += amount;
          stat.latestTxHash = log.transactionHash;
        }
      }
    } catch (error) {
      warnings.push(`logs ${start.toString()}-${end.toString()}: ${sanitizeError(error)}`);
    }
  }
  return warnings;
}

function decodeLog(log: { data: `0x${string}`; topics: readonly `0x${string}`[] }, item: ReturnType<typeof parseAbiItem>) {
  try {
    return decodeEventLog({ abi: [item] as any, data: log.data, topics: log.topics as any }) as unknown as {
      args: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return BigInt(value);
  return 0n;
}
