import { parseAbi, parseAbiItem } from "viem";

export const FLOAT_V2_CONTRACT = "0x20dcA96B0C487D94De885c726c956ffaF38b12C2";
export const FLOAT_V2_DEPLOY_BLOCK = 48_837_320n;
export const FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE = 9_000n;
export const FLOAT_V2_SOURCE_CHECKPOINT_SCAN_LIMIT = 45_000n;

export const FLOAT_V2_VERIFIED_POST_RECLAIM_STATE = Object.freeze({
  blockNumber: 52_836_679n,
  checkedAt: "2026-07-20T21:02:14.000Z",
  treasuryBalanceUSDC: "1519762",
  totalAvailableCreditUSDC: "540000",
  totalSponsoredReserveUSDC: "1450000",
  trackedExternalAgentLines: 9,
  externallySponsoredLines: 1,
  operatorSponsoredLines: 8,
  citePayRenewedLine: Object.freeze({
    agent: "0x236652EAd43fbb0948173fC4dDF23BC0971B274d",
    wallet: "0x0000000000000000000000000000000000000000",
    score: 0,
    creditLimitUSDC: "0",
    availableCreditUSDC: "0",
    activeDebtUSDC: "0",
    status: 4,
    statusName: "REVOKED",
    lastReview: "1784581334",
    lineExpiry: "0",
    sponsor: "0x0000000000000000000000000000000000000000",
    sponsorReserveUSDC: "0",
    sponsorState: "closed-reserve-reclaimed",
    preReclaimLatestTxHash: "0x1e0279903aba3e728385825e983bc840f9db804142e6314662df33afec54527f",
    closeTxHash: "0x515a8a3106fbc22fd36c75fe2a626e5e2273db58d8acf10679e44c7e90b52c09",
    autonomousScore: Object.freeze({ score: 5000, recommendedLimitUSDC: "0", cappedLimitUSDC: "0" }),
  }),
});

export function shouldUseFloatV2VerifiedSnapshot(checkpointSource, checkpointBlock, latestBlock) {
  return checkpointSource === "source-checkpoint"
    && latestBlock > checkpointBlock
    && latestBlock - checkpointBlock > FLOAT_V2_SOURCE_CHECKPOINT_SCAN_LIMIT;
}

export function reconcileFloatV2CheckpointLatestTx(checkpointBlock, agent, latestTxHash) {
  const reclaimed = FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine;
  if (checkpointBlock < FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.blockNumber) return latestTxHash;
  if (agent.toLowerCase() !== reclaimed.agent.toLowerCase()) return latestTxHash;
  if (latestTxHash && latestTxHash.toLowerCase() !== reclaimed.preReclaimLatestTxHash.toLowerCase()) {
    return latestTxHash;
  }
  return reclaimed.closeTxHash;
}

// Complete FloatIntentConsumed/FloatReceipt scan through this Arc block.
// API requests seed from this checkpoint and scan only newer blocks; successful
// incremental scans advance the checkpoint in KV. This keeps the public board
// live without replaying millions of historical blocks on every request.
export const FLOAT_V2_ACTIVITY_CHECKPOINT = {
  blockNumber: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.blockNumber,
  checkedAt: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.checkedAt,
  agents: [
    {
      agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xfba85515afe3fa1c9bae84b244bb874657756bd1656612d8b71b0686f412892e",
    },
    {
      agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0x0090b55caa8553540e38b886e09e5b88fdda051254305eb36676e9dd8f842ad2",
    },
    {
      agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368",
    },
    {
      agent: "0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0x2d91c37cc23ff8f342614bb9070e82efb37d0d588b15a43a3685c92786074e0d",
    },
    {
      agent: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.agent,
      signedIntents: 2,
      providerPaidCount: 2,
      repaidCount: 2,
      blockedCount: 0,
      providerPaidUSDC: "6000",
      repaidUSDC: "6000",
      blockedUSDC: "0",
      latestTxHash: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.closeTxHash,
    },
    {
      agent: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172",
    },
    {
      agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC",
      signedIntents: 2,
      providerPaidCount: 2,
      repaidCount: 2,
      blockedCount: 0,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      blockedUSDC: "0",
      latestTxHash: "0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699",
    },
    {
      agent: "0x7D4897489BFC663b90BaAF5B0803d18ae0ca817c",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xac1b0d231b0d19ebcb8e18877e7fcffbb2cbf990f204f648c288053bb597d679",
    },
    {
      agent: "0x43e0630025FD0339bE1fA04d3d75Daf355F50c89",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xad8301ca4edbbed18bc7204d8da9be53492116649a326728ad0ca5bc19bb1682",
    },
    {
      agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 0,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "0",
      blockedUSDC: "0",
      latestTxHash: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a",
    },
    {
      agent: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf",
      signedIntents: 2,
      providerPaidCount: 2,
      repaidCount: 2,
      blockedCount: 0,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      blockedUSDC: "0",
      latestTxHash: "0x5ace712f258220aa891d3c786458ede15ba8a5e281173e66571807a3a93aa13e",
    },
    {
      agent: "0xec28bfA6f4BcFf23933E21B7AbfB6D53287976A8",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "1000",
      repaidUSDC: "1000",
      blockedUSDC: "0",
      latestTxHash: "0x41e203d38209441761647f9c81ed1660eff7d4a6467089a7aaac58259a79f99c",
    },
    {
      agent: "0x43553CaeE153496200d37644cE28775B2b2b522E",
      signedIntents: 11,
      providerPaidCount: 11,
      repaidCount: 11,
      blockedCount: 0,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      blockedUSDC: "0",
      latestTxHash: "0xee1c4c3aa9062b233d1fc1f1a65c1a1df32c8750241aa22e68b31a97ac3a29c1",
    },
    {
      agent: "0x5773dd87b1A2b57697f773F0dcdFa65f405662a0",
      signedIntents: 2,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 1,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "100000",
      latestTxHash: "0x854380129df5c5ca590a5d5a06a4120aa8b5190cc3053901b83da5c83963f126",
    },
  ],
};

export const FLOAT_V2_STATUS_NAMES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];

// Provenance is intentionally explicit: an unrecognized sponsor is not
// promoted to external traction merely because it differs from the operator.
export const FLOAT_V2_SHADOW_CONTROLLED_SPONSORS = [
  "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8",
  "0x43553CaeE153496200d37644cE28775B2b2b522E",
];

export const FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS = [
  "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
  "0x12F25B721Cc21c38495e33A4c8524dd0B647ba03",
];

const FLOAT_V2_VERIFIED_EXTERNAL_SPONSOR_KEYS = new Set(
  FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS.map((address) => address.toLowerCase()),
);

function verifiedExternalSponsorKey(agent) {
  const candidate = agent.verifiedSponsor || (agent.sponsorProvenance === "verified-external" ? agent.sponsor : null);
  if (!candidate) return null;
  const sponsor = candidate.toLowerCase();
  return FLOAT_V2_VERIFIED_EXTERNAL_SPONSOR_KEYS.has(sponsor) ? sponsor : null;
}

export function countFloatV2VerifiedReturningAgents(agents) {
  return agents.filter(
    (agent) => Number(agent.signedIntents) > 1 && verifiedExternalSponsorKey(agent) !== null,
  ).length;
}

export function countFloatV2VerifiedReturningSponsors(agents) {
  const cyclesBySponsor = new Map();
  for (const agent of agents) {
    if (Number(agent.signedIntents) <= 0) continue;
    const sponsor = verifiedExternalSponsorKey(agent);
    if (!sponsor) continue;
    cyclesBySponsor.set(sponsor, (cyclesBySponsor.get(sponsor) || 0) + Number(agent.signedIntents));
  }
  return [...cyclesBySponsor.values()].filter((cycles) => cycles > 1).length;
}

export const FLOAT_V2_TRACKED_EXTERNAL_AGENTS = [
  { label: "Forum", agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770" },
  { label: "CitePay", agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" },
  {
    label: "Crux",
    agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092",
    spendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d",
    repayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368",
  },
  {
    label: "CitePay sponsor (retired line)",
    agent: "0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f",
    verifiedSponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
    retired: true,
    spendTx: "0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae",
    repayTx: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe",
  },
  {
    label: "CitePay sponsor (renewed line)",
    agent: "0x236652EAd43fbb0948173fC4dDF23BC0971B274d",
    verifiedSponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
    spendTx: "0x9007d0e8f66c0bc641caaa305266d50aeb5e2e969ff3edbbd8122542ed08eae4",
    repayTx: "0x52ef42211858713601721a9ae6935604c43c04a832fd7d7c5aef6c7c8156a911",
  },
  {
    label: "Forum Tollgate sponsor",
    agent: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C",
    verifiedSponsor: "0x12F25B721Cc21c38495e33A4c8524dd0B647ba03",
    spendTx: "0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f",
    repayTx: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172",
  },
  { label: "Argus Alpha", agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC" },
  { label: "Argus Beta", agent: "0x7d4897489bfc663b90baaf5b0803d18ae0ca817c" },
  { label: "Argus Gamma", agent: "0x43e0630025fd0339be1fa04d3d75daf355F50c89" },
  {
    label: "Obol",
    agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3",
    spendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a",
  },
  { label: "Driplet", agent: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf" },
].map((entry) => ({
  ...entry,
  category: "external",
  agentProvenance: "verified-external-signer",
}));

// System lines are part of reserve accounting, never external traction.
export const FLOAT_V2_TRACKED_SYSTEM_AGENTS = [
  { label: "CCTP-funded system line", agent: "0xec28bfA6f4BcFf23933E21B7AbfB6D53287976A8" },
  { label: "Float Desk system line", agent: "0x43553CaeE153496200d37644cE28775B2b2b522E" },
  { label: "V2 verifier system line", agent: "0x5773dd87b1A2b57697f773F0dcdFa65f405662a0" },
].map((entry) => ({
  ...entry,
  category: "system",
  agentProvenance: "shadow-controlled-signer",
}));

export const FLOAT_V2_TRACKED_AGENTS = [
  ...FLOAT_V2_TRACKED_EXTERNAL_AGENTS,
  ...FLOAT_V2_TRACKED_SYSTEM_AGENTS,
];

export const floatV2Abi = parseAbi([
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
  "function lineExpiries(address agent) view returns (uint64)",
  "function openSponsoredLine(address agent,uint256 reserveUSDC,bytes32 mandateId,uint64 lineExpiry,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 providerExpiry) returns (bytes32)",
  "function setSponsoredProviderMandate(address agent,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function closeSponsoredLine(address agent,address recipient,bytes32 requestHash) returns (bytes32)",
  "function requestSignedSpend((address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,uint256 maxDebtUSDC,uint256 nonce,uint256 expiry,address executor,string reason) intent, bytes signature) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function repay(address agent, uint256 amountUSDC, bytes32 requestHash) returns (bytes32)",
  "function behaviorStats(address agent) view returns (uint16 paidBound,uint16 signedExternalPaid,uint16 repaid,uint16 blocked,uint16 denied,uint16 errorCount)",
  "function autonomousLineScore(address agent) view returns (uint16 score,uint256 recommendedLimitUSDC,uint256 cappedLimitUSDC)",
  "function lineProviderMandates(address agent,address provider) view returns (bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function totalSponsoredReserveUSDC() view returns (uint256)",
]);

export const floatV2IntentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);

export const floatV2ReceiptEvent = parseAbiItem(
  "event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)",
);
