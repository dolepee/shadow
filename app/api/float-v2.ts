import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";

export const config = { maxDuration: 20 };

const CHAIN_ID = 5_042_002;
const DEFAULT_RPC = "https://rpc.testnet.arc.network";
const DEFAULT_FLOAT = "0x20dcA96B0C487D94De885c726c956ffaF38b12C2";
const DEPLOY_BLOCK = 48_837_320n;
const LOG_CHUNK_SIZE = 9_000n;

type TrackedExternalAgent = {
  label: string;
  agent: Address;
  spendTx?: `0x${string}`;
  repayTx?: `0x${string}`;
};

const TRACKED_EXTERNAL_AGENTS: readonly TrackedExternalAgent[] = [
  {
    label: "Forum",
    agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770",
  },
  {
    label: "CitePay",
    agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
  },
  {
    label: "Crux",
    agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092",
    spendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d",
    repayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368",
  },
  {
    label: "Argus",
    agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC",
  },
  {
    label: "Obol",
    agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3",
    spendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a",
  },
  {
    label: "Driplet",
    agent: "0x7dF8C7ab755A62a5ea3356372Ad875d8C88084BF",
  },
] as const;

type VercelLikeRequest = {
  method?: string;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

type AgentStats = {
  label: string;
  agent: Address;
  category: "external" | "self-test";
  spendTx?: `0x${string}`;
  repayTx?: `0x${string}`;
  signedIntents: number;
  providerPaidCount: number;
  repaidCount: number;
  blockedCount: number;
  providerPaidUSDC: bigint;
  repaidUSDC: bigint;
  blockedUSDC: bigint;
  latestTxHash?: `0x${string}`;
};

const statusNames = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"] as const;
const floatAbi = parseAbi([
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
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");

  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  try {
    const result = await readFloatV2();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      mode: "shadow-float-v2-activity",
      checkedAt: new Date().toISOString(),
      error: sanitize(error),
    });
  }
}

async function readFloatV2() {
  const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || DEFAULT_RPC;
  const FLOAT = getAddress(clean(process.env.SHADOW_FLOAT_V2 || process.env.VITE_SHADOW_FLOAT_V2) || DEFAULT_FLOAT);
  const startBlock = BigInt(clean(process.env.FLOAT_V2_START_BLOCK) || DEPLOY_BLOCK.toString());
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }) });
  const latestBlock = await client.getBlockNumber();
  const [intentLogs, receiptLogs, treasuryBalance, totalAvailableCredit, totalSponsoredReserve] = await Promise.all([
    getChunkedLogs(client, {
      address: FLOAT,
      event: intentConsumedEvent,
      fromBlock: startBlock,
      toBlock: latestBlock,
    }),
    getChunkedLogs(client, {
      address: FLOAT,
      event: receiptEvent,
      fromBlock: startBlock,
      toBlock: latestBlock,
    }),
    client.readContract({ address: FLOAT, abi: floatAbi, functionName: "treasuryBalanceUSDC" }),
    client.readContract({ address: FLOAT, abi: floatAbi, functionName: "totalAvailableCreditUSDC" }),
    client.readContract({ address: FLOAT, abi: floatAbi, functionName: "totalSponsoredReserveUSDC" }),
  ]);

  const tracked = new Map<string, (typeof TRACKED_EXTERNAL_AGENTS)[number]>();
  for (const entry of TRACKED_EXTERNAL_AGENTS) {
    tracked.set(getAddress(entry.agent).toLowerCase(), entry);
  }

  const statsByAgent = new Map<string, AgentStats>();
  const ensureStats = (agent: Address): AgentStats => {
    const normalized = getAddress(agent);
    const key = normalized.toLowerCase();
    const trackedEntry = tracked.get(key);
    const existing = statsByAgent.get(key);
    if (existing) return existing;
    const stats: AgentStats = {
      label: trackedEntry?.label || "V2 proof agent",
      agent: normalized,
      category: trackedEntry ? "external" : "self-test",
      spendTx: asHash(trackedEntry?.spendTx),
      repayTx: asHash(trackedEntry?.repayTx),
      signedIntents: 0,
      providerPaidCount: 0,
      repaidCount: 0,
      blockedCount: 0,
      providerPaidUSDC: 0n,
      repaidUSDC: 0n,
      blockedUSDC: 0n,
    };
    statsByAgent.set(key, stats);
    return stats;
  };

  for (const entry of TRACKED_EXTERNAL_AGENTS) {
    ensureStats(getAddress(entry.agent));
  }

  for (const log of intentLogs) {
    const agent = getAddress(String((log as any).args.agent));
    const stats = ensureStats(agent);
    stats.signedIntents += 1;
    stats.latestTxHash = (log as any).transactionHash;
  }

  for (const log of receiptLogs) {
    const args = (log as any).args;
    const agent = getAddress(String(args.agent));
    const stats = ensureStats(agent);
    const receiptType = Number(args.receiptType);
    const amount = BigInt(args.amountUSDC || 0);
    if (receiptType === 3) {
      stats.blockedCount += 1;
      stats.blockedUSDC += amount;
      stats.latestTxHash = (log as any).transactionHash;
    }
    if (receiptType === 4) {
      stats.providerPaidCount += 1;
      stats.providerPaidUSDC += amount;
      stats.latestTxHash = (log as any).transactionHash;
    }
    if (receiptType === 6) {
      stats.repaidCount += 1;
      stats.repaidUSDC += amount;
      stats.latestTxHash = (log as any).transactionHash;
    }
  }

  const agents = await Promise.all(
    [...statsByAgent.values()].map(async (stats) => {
      const [line, sponsorLine] = await Promise.all([
        client.readContract({ address: FLOAT, abi: floatAbi, functionName: "lines", args: [stats.agent] }),
        client.readContract({ address: FLOAT, abi: floatAbi, functionName: "lineSponsors", args: [stats.agent] }),
      ]);
      const status = Number(line[5]);
      return {
        label: stats.label,
        category: stats.category,
        agent: stats.agent,
        wallet: line[0],
        score: Number(line[1]),
        creditLimitUSDC: line[2].toString(),
        availableCreditUSDC: line[3].toString(),
        activeDebtUSDC: line[4].toString(),
        status,
        statusName: statusNames[status] || "UNKNOWN",
        sponsor: sponsorLine[0],
        sponsorReserveUSDC: sponsorLine[1].toString(),
        signedIntents: stats.signedIntents,
        providerPaidCount: stats.providerPaidCount,
        repaidCount: stats.repaidCount,
        blockedCount: stats.blockedCount,
        providerPaidUSDC: stats.providerPaidUSDC.toString(),
        repaidUSDC: stats.repaidUSDC.toString(),
        blockedUSDC: stats.blockedUSDC.toString(),
        spendTx: stats.spendTx,
        repayTx: stats.repayTx,
        latestTxHash: stats.latestTxHash,
      };
    }),
  );

  const visibleAgents = agents
    .filter((agent) => agent.category === "external")
    .sort((a, b) => {
      const aActive = BigInt(a.activeDebtUSDC) > 0n ? 1 : 0;
      const bActive = BigInt(b.activeDebtUSDC) > 0n ? 1 : 0;
      if (a.statusName === "REPAID" && b.statusName !== "REPAID") return -1;
      if (b.statusName === "REPAID" && a.statusName !== "REPAID") return 1;
      if (aActive !== bActive) return bActive - aActive;
      return a.label.localeCompare(b.label);
    });

  const external = visibleAgents;
  const summary = {
    registeredExternalLines: external.filter((agent) => BigInt(agent.sponsorReserveUSDC) > 0n).length,
    signedIntents: external.reduce((sum, agent) => sum + agent.signedIntents, 0),
    paidSpends: external.reduce((sum, agent) => sum + agent.providerPaidCount, 0),
    repaidLifecycles: external.filter((agent) => BigInt(agent.repaidUSDC) > 0n && BigInt(agent.activeDebtUSDC) === 0n).length,
    openDebtAgents: external.filter((agent) => BigInt(agent.activeDebtUSDC) > 0n).length,
    providerPaidUSDC: external.reduce((sum, agent) => sum + BigInt(agent.providerPaidUSDC), 0n).toString(),
    repaidUSDC: external.reduce((sum, agent) => sum + BigInt(agent.repaidUSDC), 0n).toString(),
    activeDebtUSDC: external.reduce((sum, agent) => sum + BigInt(agent.activeDebtUSDC), 0n).toString(),
    blockedUSDC: external.reduce((sum, agent) => sum + BigInt(agent.blockedUSDC), 0n).toString(),
  };

  return {
    ok: true,
    mode: "shadow-float-v2-activity",
    checkedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    float: FLOAT,
    startBlock: startBlock.toString(),
    latestBlock: latestBlock.toString(),
    treasuryBalanceUSDC: treasuryBalance.toString(),
    totalAvailableCreditUSDC: totalAvailableCredit.toString(),
    totalSponsoredReserveUSDC: totalSponsoredReserve.toString(),
    summary,
    agents: visibleAgents,
    selfTestAgents: agents.filter((agent) => agent.category === "self-test"),
  };
}

async function getChunkedLogs(
  client: ReturnType<typeof createPublicClient>,
  args: {
    address: Address;
    event: ReturnType<typeof parseAbiItem>;
    fromBlock: bigint;
    toBlock: bigint;
  },
) {
  const logs: any[] = [];
  let fromBlock = args.fromBlock;
  while (fromBlock <= args.toBlock) {
    const toBlock = fromBlock + LOG_CHUNK_SIZE > args.toBlock ? args.toBlock : fromBlock + LOG_CHUNK_SIZE;
    logs.push(
      ...(await client.getLogs({
        address: args.address,
        event: args.event as any,
        fromBlock,
        toBlock,
      })),
    );
    fromBlock = toBlock + 1n;
  }
  return logs;
}

function clean(value?: string | null): string {
  return (value || "").trim();
}

function asHash(value?: string): `0x${string}` | undefined {
  return value && value.startsWith("0x") ? (value as `0x${string}`) : undefined;
}

function sanitize(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
