import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { createWalletClient, custom, getAddress, keccak256, parseAbi, parseAbiItem, parseUnits, stringToBytes, type Address, type Hash, type Hex } from "viem";
import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
  getUserOperationGasPrice,
  type WebAuthnCredential,
} from "@circle-fin/modular-wallets-core";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { createPublicClient as createClient, encodeFunctionData, http, type PublicClient } from "viem";
import {
  addresses,
  agentSignal,
  arcTestnet,
  computeEarnedReputation,
  erc20Abi,
  fetchLeptonState,
  fetchShadowState,
  formatAsset,
  formatUSDC,
  isConfigured,
  isLeptonConfigured,
  leptonAddresses,
  mandateRegistryAbi,
  pilotAttestorAbi,
  publicClient,
  routerAbi,
  shortAddress,
  txUrl,
  v4StyleArcAdapterAbi,
  type AgentSignal,
  type EarnedReputation,
  type IntentLog,
  type LeptonState,
  type PositionCloseLog,
  type ReceiptLog,
  type ShadowState,
  type SourceAgent,
} from "./chain";
import {
  FLOAT_V2_CONTRACT,
  FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE,
  FLOAT_V2_DEPLOY_BLOCK,
  FLOAT_V2_STATUS_NAMES,
  FLOAT_V2_TRACKED_EXTERNAL_AGENTS,
  floatV2Abi,
  floatV2IntentConsumedEvent,
  floatV2ReceiptEvent,
} from "../floatV2Config.js";
import "./styles.css";

type PresetKey = "conservative" | "balanced" | "aggressive";

type Preset = {
  label: string;
  tagline: string;
  maxAmountPerIntent: string;
  dailyCap: string;
  maxRiskLevel: number;
  minBpsOut: number;
};

const PRESETS: Record<PresetKey, Preset> = {
  conservative: {
    label: "Conservative",
    tagline: "Strict slippage, low risk only, tight cap.",
    maxAmountPerIntent: "0.2",
    dailyCap: "1",
    maxRiskLevel: 1,
    minBpsOut: 10000,
  },
  balanced: {
    label: "Balanced",
    tagline: "Moderate slippage, mid risk, daily room to run.",
    maxAmountPerIntent: "0.5",
    dailyCap: "3",
    maxRiskLevel: 2,
    minBpsOut: 9500,
  },
  aggressive: {
    label: "Aggressive",
    tagline: "Loose slippage, take any risk, larger size.",
    maxAmountPerIntent: "1",
    dailyCap: "5",
    maxRiskLevel: 3,
    minBpsOut: 9000,
  },
};

type ExternalSignedLabel = { kind: "obol" | "builder"; eyebrow: string; title: string };

const OBOL_SIGNER = "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3".toLowerCase();
const EXTERNAL_SIGNER_LABELS: Record<string, ExternalSignedLabel> = {
  [OBOL_SIGNER]: { kind: "obol", eyebrow: "arms length buyer agent", title: "Obol signed Float intent" },
  ["0x13585c6004fbA9D7D49219a6435B68348fD30770".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Forum agent",
    title: "Forum signed Float V2 intent",
  },
  ["0x5389688243328c26a92b301faEEAb5fbf9AFf105".toLowerCase()]: {
    kind: "builder",
    eyebrow: "CitePay agent",
    title: "CitePay signed Float V2 intent",
  },
  ["0x9972fF27a2EADBDB8414072736395236E0BF0092".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Crux agent",
    title: "Crux signed Float V2 intent",
  },
  ["0x5c0b33b209f510868E07792Edc46c3792B0b92EC".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Argus Agent Alpha",
    title: "Argus signed Float V2 intent",
  },
  ["0x7d4897489bfc663b90baaf5b0803d18ae0ca817c".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Argus Agent Beta",
    title: "Argus Beta V2 line",
  },
  ["0x43e0630025fd0339be1fa04d3d75daf355f50c89".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Argus Agent Gamma",
    title: "Argus Gamma V2 line",
  },
};

const FLOAT_V2_PROOF = {
  sourcify: "https://sourcify.dev/server/v2/contract/5042002/0x20dcA96B0C487D94De885c726c956ffaF38b12C2",
  directSpendTx: "0xf2615a12b11d42d6509bc2baaafbc81fd31e4d5b54751c3686c55458252d9b03" as Hash,
  blockedSpendTx: "0x81d02cba62577eaff7f6b4bbf6233111d3372ee7cc6bc074d04030d0b41f0314" as Hash,
  repayTx: "0x854380129df5c5ca590a5d5a06a4120aa8b5190cc3053901b83da5c83963f126" as Hash,
  directRequestHash: "0xd53dbce76814360802c36fb03e5165759c1b383e5dfbdfb7e3f02d2426b6ccff",
  blockedRequestHash: "0x03c1655ba18fd886d6b4bcaa2b190fb47dfb5df79528bad58490da93a892e0f5",
  cruxSpendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d" as Hash,
  cruxRepayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368" as Hash,
  obolSpendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a" as Hash,
  argusAlphaBorrowTx: "0x50831fd00ef83a2c5fdb5bd5829ac6800c783aa34ec2149eb92c1bb38553aa2c" as Hash,
  argusAlphaRepayTx: "0x4ae5922841cb91b090e2785e26b94789a9c4028340bea5c162106657280bf896" as Hash,
  argusBetaBorrowTx: "0x03d67f3f911abda8e862700787f33d5ad7002e49a6fd989172dfbca5d6aa9ba9" as Hash,
  argusBetaRepayTx: "0xac1b0d231b0d19ebcb8e18877e7fcffbb2cbf990f204f648c288053bb597d679" as Hash,
  argusGammaBorrowTx: "0x49aceee516b7eb037c9b475cdf9f238335eea9975c2102731b05826c6a0dc33e" as Hash,
  argusGammaRepayTx: "0xad8301ca4edbbed18bc7204d8da9be53492116649a326728ad0ca5bc19bb1682" as Hash,
  argusCitePaySpendTx: "0x552c7e32e34d9f06e03ca185f705637f9c66002d709d7d14c24d11edefdbc322" as Hash,
  argusCitePayRepayTx: "0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699" as Hash,
  argusCitePayQueryId: "6e6d9c2c-b988-438a-9930-0d6d40ff78b5",
  citePaySponsorApproveTx: "0xa23a69aa34d4d3532ad1cc15718ca9a8537a9d085a9312937a2596ba319ad2af" as Hash,
  citePaySponsorOpenTx: "0xf2dabb1ce651330a389acd4d6cacee1a859dc4fc12f18459143dc0f60ee53540" as Hash,
  citePaySponsorSpendTx: "0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae" as Hash,
  citePaySponsorRepayTx: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe" as Hash,
  forumSponsorOpenTx: "0x8f9759660161819cf924314abcaf2feefb55d973a845c6ed0921d14e560c79df" as Hash,
  forumSponsorSpendTx: "0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f" as Hash,
  forumSponsorRepayTx: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172" as Hash,
  forumSponsorCloseTx: "0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463" as Hash,
  citePayProviderQueryTxs: [
    "0x3c74ba902d9494c7762f440affa0065ef4a2478b6e9cb4cb228e11cd689a9929",
    "0xc8ee30e0c2ab5943f472baf819fb17af8b39571665ba4ac408b9fe8d9343532a",
    "0xb1b6727138218b79ec829cd221db65bd4abe47b5a9b7afee8bdd42b14e1f48bd",
    "0x88ef62f2ab2b13cbea658ca9f4d26ebd38c6e86aa8e0704dd7e51a676beadef8",
    "0x85aea6dfce5b589fa5a1e5526889d31ca9126385217614b42d0ad34656261311",
  ] as readonly Hash[],
};
const FLOAT_V2_LOG_CHUNK_SIZE = FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE;

type FloatV2LineRead = readonly [Address, number, bigint, bigint, bigint, number, bigint, `0x${string}`, bigint, bigint];
type FloatV2SponsorLineRead = readonly [Address, bigint];
type FloatV2BehaviorStatsRead = readonly [number, number, number, number, number, number];
type FloatV2AutonomousScoreRead = readonly [number, bigint, bigint];

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type ActionState = {
  label: string;
  tx?: `0x${string}`;
  error?: string;
};

type VerifyOutcome = {
  address: Address;
  status: "COPIED" | "BLOCKED";
  reason: string;
  usdcAmount: string;
  mirrorFee: string;
  assetOut: string;
};

type VerifyResponse = {
  ok: boolean;
  cached: boolean;
  retryAfter: number;
  tx: `0x${string}`;
  blockNumber: string;
  amountUSDC: string;
  liveQuote: string;
  minAmountOut: string;
  scaledMinA: string;
  scaledMinB: string;
  followerA: VerifyOutcome;
  followerB: VerifyOutcome;
  intentHash?: string;
  reasoning?: ReasoningPacket;
};

type ReasoningPacket = {
  sourceAgent: string;
  sourceName: string;
  intentHash: string;
  createdAt: number;
  amountUSDC: string;
  minAmountOut: string;
  liveQuote: string;
  reserveUSDC: string;
  reserveAsset: string;
  riskLevel: number;
  confidenceBps: number;
  decision: "publish" | "skip";
  rationale: string;
};

type ReasoningResponse = {
  configured: boolean;
  packet: ReasoningPacket | null;
  latestIntentHash: string | null;
  error?: string;
};

type PilotSlice = {
  sourceAddress: string;
  name: string;
  weightBps: number;
  preset: PresetKey;
  amountUSDC: string;
  reason: string;
};

type PilotPlan = {
  model: string;
  fellBack: boolean;
  fellBackReason?: string;
  headline: string;
  confidenceBps: number;
  rationale: string;
  watchSignals: string[];
  allocation: PilotSlice[];
  generatedAt: number;
  decisionHash: string;
};

type PilotRisk = "low" | "balanced" | "high";

type FloatLineState = {
  wallet: Address;
  score: number;
  creditLimitUSDC: string;
  availableCreditUSDC: string;
  activeDebtUSDC: string;
  status: string;
  lastReview: number;
  mandateId: string;
  day: number;
  spentTodayUSDC: string;
};

type FloatReceiptState = {
  receiptId: string;
  receiptHash: string;
  receiptType: string;
  agent: Address;
  provider: Address;
  endpointHash: string;
  amountUSDC: string;
  amountFormatted: string;
  providerAmountUSDC?: string;
  feeUSDC?: string;
  debtOpenedUSDC?: string;
  debtDeltaUSDC?: string;
  creditBeforeUSDC: string;
  creditAfterUSDC: string;
  debtBeforeUSDC: string;
  debtAfterUSDC: string;
  reason: string;
  mandateId: string;
  requestHash: string;
  prevChecksum: string;
  checksum: string;
  transactionHash: `0x${string}`;
  blockNumber: string;
  x402?: {
    receiptId: string;
    requestHash: string;
    x402Hash: `0x${string}`;
    provider: Address;
    amountUSDC: string;
    amountFormatted: string;
    facilitator: Address;
    bindingTxHash: `0x${string}`;
    blockNumber: string;
  };
};

type FloatSourceSummary = {
  cycles?: number;
  paidCount?: number;
  blockedCount?: number;
  deniedCount?: number;
  repaidCount?: number;
  lifecycleClosedCount?: number;
  skipCount?: number;
  errorCount?: number;
  fallbacks?: number;
  providerPaidUSDC?: string;
  debtOpenedUSDC?: string;
  blockedUSDC?: string;
  deniedUSDC?: string;
  repaidUSDC?: string;
};

type FloatLoopRun = {
  id?: string;
  source?: "agent-loop" | "external-signed" | "operator-assisted" | "external";
  action?: string;
  outcome?: string;
  at?: string;
  agent?: Address;
  facilitator?: Address;
  amountUSDC?: string;
  x402Hash?: `0x${string}`;
  bindTxHash?: `0x${string}`;
  repayTxHash?: `0x${string}`;
  txHash?: `0x${string}`;
  requestHash?: string;
  reason?: string;
  rationale?: string;
  intent?: {
    agent?: Address;
    provider?: Address;
    endpointHash?: string;
    amountUSDC?: string;
    nonce?: string;
    expiry?: string;
    reason?: string;
    float?: Address;
    chainId?: number;
  };
  model?: string;
  fellBack?: boolean;
};

type FloatStandingAgent = {
  agent: Address;
  label: "lab" | "invited" | "self-test" | "demo";
  score: number;
  status: string;
  creditLimitUSDC: string;
  availableCreditUSDC: string;
  activeDebtUSDC: string;
  lastReview: number;
};

type FloatStandingBoard = {
  generatedAt?: number;
  legend?: Record<string, string>;
  counts?: {
    lab?: number;
    invited?: number;
    "self-test"?: number;
    demo?: number;
  };
  agents?: FloatStandingAgent[];
};

type FloatScoreResponse = {
  configured?: boolean;
  agent: Address;
  label?: FloatStandingAgent["label"] | string;
  evidenceMode?: string;
  evidence?: {
    runs?: number;
    paidBound?: number;
    signedExternalPaidBound?: number;
    repaid?: number;
    blocked?: number;
    denied?: number;
    error?: number;
    requestHashes?: string[];
    receiptHashes?: string[];
  };
  evidenceCompleteness?: {
    logFetchComplete?: boolean;
    indexedReceiptCountMatchesChain?: boolean;
    receiptLogsIndexed?: number;
  };
  computed?: {
    score?: number;
    recommendedLimitUSDC?: string;
    recommendedLimitFormatted?: string;
  };
  currentLine?: {
    wallet?: Address;
    score?: number;
    creditLimitUSDC?: string;
    availableCreditUSDC?: string;
    activeDebtUSDC?: string;
    status?: string;
  };
  supportCheck?: {
    currentLineSupportedByComputedV0?: boolean;
    scoreSupported?: boolean;
    limitSupported?: boolean;
  };
  trustAssumption?: string;
};

type FloatState = {
  configured: boolean;
  testnet: true;
  network: "arc-testnet";
  float?: Address;
  usdc?: Address;
  alpha?: Address;
  beta?: Address;
  provider?: Address;
  receiptCount?: string;
  treasuryBalanceUSDC?: string;
  totalProviderPaidUSDC?: string;
  totalDebtOpenedUSDC?: string;
  totalBlockedUSDC?: string;
  totalDeniedUSDC?: string;
  totalRepaidUSDC?: string;
  totalFeesAccruedUSDC?: string;
  totalDefaultedUSDC?: string;
  totalAvailableCreditUSDC?: string;
  feeBps?: number;
  lastChecksum?: string;
  alphaLine?: FloatLineState;
  betaLine?: FloatLineState;
  providerMandate?: {
    endpointHash: string;
    maxPerRequestUSDC: string;
    dailyLimitUSDC: string;
    expiry: number;
    active: boolean;
  };
  sourceBreakdown?: {
    agentLoop?: FloatSourceSummary;
    demoAdmin?: FloatSourceSummary;
    externalSigned?: FloatSourceSummary;
    assisted?: FloatSourceSummary;
  };
  proofChecks?: Record<string, boolean | string>;
  proofPointers?: {
    x402BoundReceipt?: FloatReceiptState | null;
    providerPaidReceipt?: FloatReceiptState | null;
    debtReceipt?: FloatReceiptState | null;
    repaymentReceipt?: FloatReceiptState | null;
    overspendReceipt?: FloatReceiptState | null;
    denialReceipt?: FloatReceiptState | null;
    grantReceipt?: FloatReceiptState | null;
    latestExternalVerify?: { requestHash: string; verifyUrl: string } | null;
  };
  walletProof?: {
    agent?: Address;
    balanceSnapshot?: "current" | "historical";
    historicalBeforeBalanceAvailable?: boolean;
    note?: string;
    agentWalletUSDC?: string;
    requiredX402AmountUSDC?: string;
    walletShortfallUSDC?: string;
    floatAvailableCapacityUSDC?: string;
    facilitatorPaidUSDC?: string;
    debtAssignedUSDC?: string;
    requestHash?: string | null;
    x402Hash?: `0x${string}` | null;
    bindTxHash?: `0x${string}` | null;
  };
  standingBoard?: FloatStandingBoard;
  loopRuns?: FloatLoopRun[];
  receipts?: FloatReceiptState[];
  latestBlock?: string;
  fetchedAt?: number;
  missing?: string[];
  degraded?: boolean;
  error?: string;
};

type FloatV2AgentState = {
  label: string;
  category: "external" | "self-test";
  agent: Address;
  wallet: Address;
  score: number;
  creditLimitUSDC: string;
  availableCreditUSDC: string;
  activeDebtUSDC: string;
  status: number;
  statusName: string;
  lastReview?: string;
  lastReviewISO?: string | null;
  scoredByContract?: boolean;
  behavior?: {
    paidBound: number;
    signedExternalPaid: number;
    repaid: number;
    blocked: number;
    denied: number;
    errorCount: number;
  };
  autonomousScore?: {
    score: number;
    recommendedLimitUSDC: string;
    cappedLimitUSDC: string;
  };
  sponsor: Address;
  sponsorReserveUSDC: string;
  sponsorState?: "active-reserve" | "closed-reserve-reclaimed" | "none";
  signedIntents: number;
  providerPaidCount: number;
  repaidCount: number;
  blockedCount: number;
  providerPaidUSDC: string;
  repaidUSDC: string;
  blockedUSDC: string;
  spendTx?: Hash;
  repayTx?: Hash;
  latestTxHash?: Hash;
};

type FloatV2ActivityState = {
  ok?: boolean;
  source?: "live" | "verified-snapshot";
  mode?: string;
  checkedAt?: string;
  chainId?: number;
  float?: Address;
  latestBlock?: string;
  treasuryBalanceUSDC?: string;
  totalAvailableCreditUSDC?: string;
  totalSponsoredReserveUSDC?: string;
  summary?: {
    registeredExternalLines: number;
    signedIntents: number;
    paidSpends: number;
    repaidLifecycles: number;
    openDebtAgents: number;
    providerPaidUSDC: string;
    repaidUSDC: string;
    activeDebtUSDC: string;
    blockedUSDC: string;
  };
  agents?: FloatV2AgentState[];
  selfTestAgents?: FloatV2AgentState[];
  logFetch?: {
    fromBlock?: string;
    toBlock?: string;
    complete?: boolean;
    warnings?: string[];
  };
  error?: string;
};

type FloatDeskEntry = {
  ok?: boolean | null;
  live?: boolean;
  cycle?: string;
  ts?: string;
  source?: string;
  decision?: {
    action?: "PAY" | "SKIP" | "REPAY" | "HOLD" | string;
    provider?: string;
    amountAtomic?: string;
    rationale?: string;
    wasClamped?: boolean;
    clampReasons?: string[];
  };
  bookNote?: string;
  assessment?: string;
  txs?: {
    spend?: {
      txHash?: Hash;
      requestHash?: Hash;
      rationaleDigest?: Hash;
      amountUSDC?: string;
      provider?: string;
      providerPaid?: boolean;
      providerDeltaUSDC?: string;
    };
    repay?: {
      txHash?: Hash;
      approve?: Hash;
      requestHash?: Hash;
      amountUSDC?: string;
    };
    settle?: {
      txHash?: Hash;
      approve?: Hash;
      requestHash?: Hash;
      amountUSDC?: string;
    };
    ask?: {
      ok?: boolean;
      status?: number;
      queryId?: string | null;
    };
  };
  reviews?: Array<{
    agent?: Address;
    txHash?: Hash;
    scoreBefore?: number;
    scoreAfter?: number;
    limitBeforeUSDC?: string;
    limitAfterUSDC?: string;
    skipped?: string;
    error?: string;
  }>;
  error?: string;
};

type FloatDeskLabLine = {
  agent?: Address;
  label?: string;
  score?: number;
  creditLimitUSDC?: string;
  availableCreditUSDC?: string;
  activeDebtUSDC?: string;
  statusName?: string;
  sponsor?: Address;
  sponsorReserveUSDC?: string;
  recommendedLimitUSDC?: string;
  cappedLimitUSDC?: string;
  scoredByContract?: boolean;
};

type FloatDeskState = {
  ok?: boolean;
  mode?: string;
  checkedAt?: string;
  labLine?: FloatDeskLabLine | null;
  entries?: FloatDeskEntry[];
  counts?: {
    cycles: number;
    pays: number;
    skips: number;
    holds: number;
    repays: number;
    settles?: number;
    clamps: number;
  };
  missing?: string[];
  error?: string;
};

const FLOAT_DESK_GATEWAY_PROOF = {
  rows: 2,
  totalUSDC: "0.002",
  batches: ["cad5a209-df11-4eb3-95e6-29b442c6293c", "910c14fc-3af9-4716-81f3-9144e31d2650"],
};

const FLOAT_V2_VERIFIED_SNAPSHOT: FloatV2ActivityState = {
  ok: true,
  source: "verified-snapshot",
  mode: "shadow-float-v2-activity",
  checkedAt: "2026-07-02T11:54:41.321Z",
  chainId: arcTestnet.id,
  float: FLOAT_V2_CONTRACT,
  latestBlock: "49803171",
  treasuryBalanceUSDC: "495275",
  totalAvailableCreditUSDC: "465000",
  totalSponsoredReserveUSDC: "500000",
  summary: {
    registeredExternalLines: 9,
    signedIntents: 11,
    paidSpends: 11,
    repaidLifecycles: 10,
    openDebtAgents: 1,
    providerPaidUSDC: "101000",
    repaidUSDC: "91000",
    activeDebtUSDC: "10000",
    blockedUSDC: "0",
  },
  agents: [
    {
      label: "Argus Alpha",
      category: "external",
      agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC" as Address,
      wallet: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC" as Address,
      score: 9000,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782870038",
      lastReviewISO: "2026-07-01T01:40:38.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 2, repaid: 2, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 9000, recommendedLimitUSDC: "1000000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 2,
      providerPaidCount: 2,
      repaidCount: 2,
      blockedCount: 0,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      blockedUSDC: "0",
      latestTxHash: "0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699" as Hash,
    },
    {
      label: "Argus Beta",
      category: "external",
      agent: "0x7D4897489BFC663b90BaAF5B0803d18ae0ca817c" as Address,
      wallet: "0x7D4897489BFC663b90BaAF5B0803d18ae0ca817c" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782645116",
      lastReviewISO: "2026-06-28T11:11:56.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xac1b0d231b0d19ebcb8e18877e7fcffbb2cbf990f204f648c288053bb597d679" as Hash,
    },
    {
      label: "Argus Gamma",
      category: "external",
      agent: "0x43e0630025FD0339bE1fA04d3d75Daf355F50c89" as Address,
      wallet: "0x43e0630025FD0339bE1fA04d3d75Daf355F50c89" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782645128",
      lastReviewISO: "2026-06-28T11:12:08.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xad8301ca4edbbed18bc7204d8da9be53492116649a326728ad0ca5bc19bb1682" as Hash,
    },
    {
      label: "CitePay",
      category: "external",
      agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" as Address,
      wallet: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782510847",
      lastReviewISO: "2026-06-26T21:54:07.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0x0090b55caa8553540e38b886e09e5b88fdda051254305eb36676e9dd8f842ad2" as Hash,
    },
    {
      label: "Crux",
      category: "external",
      agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092" as Address,
      wallet: "0x9972fF27a2EADBDB8414072736395236E0BF0092" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782542835",
      lastReviewISO: "2026-06-27T06:47:15.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      spendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d" as Hash,
      repayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368" as Hash,
      latestTxHash: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368" as Hash,
    },
    {
      label: "CitePay sponsor",
      category: "external",
      agent: "0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f" as Address,
      wallet: "0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782990434",
      lastReviewISO: "2026-07-02T11:07:14.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" as Address,
      sponsorReserveUSDC: "50000",
      sponsorState: "active-reserve",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      spendTx: "0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae" as Hash,
      repayTx: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe" as Hash,
      latestTxHash: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe" as Hash,
    },
    {
      label: "Forum Tollgate sponsor",
      category: "external",
      agent: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C" as Address,
      wallet: "0x0000000000000000000000000000000000000000" as Address,
      score: 0,
      creditLimitUSDC: "0",
      availableCreditUSDC: "0",
      activeDebtUSDC: "0",
      status: 4,
      statusName: "REVOKED",
      lastReview: "1782992348",
      lastReviewISO: "2026-07-02T11:39:08.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 0, repaid: 0, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 5000, recommendedLimitUSDC: "0", cappedLimitUSDC: "0" },
      sponsor: "0x0000000000000000000000000000000000000000" as Address,
      sponsorReserveUSDC: "0",
      sponsorState: "closed-reserve-reclaimed",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      spendTx: "0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f" as Hash,
      repayTx: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172" as Hash,
      latestTxHash: "0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463" as Hash,
    },
    {
      label: "Driplet",
      category: "external",
      agent: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf" as Address,
      wallet: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782660996",
      lastReviewISO: "2026-06-28T15:36:36.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0x0579c4c845809681a4af35c8b2bf1d474250ff0f35ce0cff7e94ce7abf209854" as Hash,
    },
    {
      label: "Forum",
      category: "external",
      agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770" as Address,
      wallet: "0x13585c6004fbA9D7D49219a6435B68348fD30770" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1782500200",
      lastReviewISO: "2026-06-26T18:56:40.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xfba85515afe3fa1c9bae84b244bb874657756bd1656612d8b71b0686f412892e" as Hash,
    },
    {
      label: "Obol",
      category: "external",
      agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3" as Address,
      wallet: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3" as Address,
      score: 7850,
      creditLimitUSDC: "25000",
      availableCreditUSDC: "15000",
      activeDebtUSDC: "10000",
      status: 2,
      statusName: "LIMITED",
      lastReview: "1782568032",
      lastReviewISO: "2026-06-27T13:47:12.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 0, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 7850, recommendedLimitUSDC: "25000", cappedLimitUSDC: "25000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 0,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "0",
      blockedUSDC: "0",
      spendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a" as Hash,
      latestTxHash: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a" as Hash,
    },
  ],
  selfTestAgents: [],
  logFetch: {
    fromBlock: FLOAT_V2_DEPLOY_BLOCK.toString(),
    toBlock: "49803171",
    complete: true,
    warnings: [],
  },
};

type TreasuryCheck = {
  check: string;
  status: "PASS" | "FAIL";
  ok: boolean;
  detail: string;
};

type TreasuryState = {
  ok: boolean;
  checkedAt?: string;
  mode?: string;
  chainId?: number;
  operator?: Address;
  requestHash?: Hash;
  txs?: {
    createMandate?: Hash;
    allowedAllocation?: Hash;
    blockedAllocation?: Hash;
    x402Settlement?: Hash;
    floatBind?: Hash;
  };
  amounts?: {
    allowedAllocationUSDC?: string;
    blockedAttemptUSDC?: string;
    x402PaidUSDC?: string;
    floatFeeUSDC?: string;
  };
  checks?: TreasuryCheck[];
  error?: string;
};

const TREASURY_PROOF = {
  operator: "0x26bA923FbbB4404395E61f94Ca4b39823A1763c5" as Address,
  float: "0xF305647bA0ff7f1E2d4bE5f37F2EF9f930531057" as Address,
  mandateRegistry: "0xe3cf1a4d54f627f599255142cef4bf9b8c361a4c" as Address,
  mandateAttestor: "0x9b5afc6c442364d4397763917ebbc659d85ee86d" as Address,
  bondedEnforcer: "0x1825f447c0aa8e64dd2d290cdce85d82993d0e1e" as Address,
  morphoAdapter: "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5" as Address,
  vaultSink: "0x110f79c5617797b199d3d6e2abb855c34fbc5e58" as Address,
  amountAllocatedUSDC: "100000",
  amountBlockedUSDC: "300000",
  amountX402USDC: "1000",
  feeUSDC: "10",
  txs: {
    createMandate: "0x5f511e1bf49fadf998b7a94f5e34598510e9479fab15f5a5fb713636c158a411" as Hash,
    allocation: "0x9836e74ee95907847fac464f3a65554cf314adab9efe7141f4644022b3e09c17" as Hash,
    blocked: "0x7d3dddd89dc50ea5b410564c7f1134ce1350fd3687e8cefec74192d9e9b4bd23" as Hash,
    x402Settlement: "0x516d95ed55d61663c491f2cccb45d1d16d83967bdcc6fc66899d05426fea80ab" as Hash,
    floatBind: "0x7fe14e70081f682017d5804250f9db6b0dc7416fe1eb100f7135c6e34007d103" as Hash,
  },
  hashes: {
    floatRequest: "0xbcb5bbbcdd270198a5c4258d34ac1c0625c8b807f8fe8dde8912ac12feda910b",
    allowedAction: "0x7b0f276c844b63db15c82995ba154ffb136dab19aa7481a853ce95eedff16205",
    blockedAction: "0xe93a7933e6ce39a04dcb0bf8561c838930f8333b6d4eeb4f60db4d2a366b7523",
  },
};

async function fetchFloatV2Activity(): Promise<FloatV2ActivityState> {
  try {
    const res = await fetch(`/api/float?mode=v2&ts=${Date.now()}`, { cache: "no-store" });
    const data = await res.json();
    if (res.ok && data?.ok && data?.logFetch?.complete !== false) return data as FloatV2ActivityState;
    if (res.ok && data?.ok && data?.logFetch?.complete === false) {
      throw new Error("V2 API returned an incomplete log read");
    }
    throw new Error(data?.error || `V2 API returned ${res.status}`);
  } catch (error) {
    console.warn("Falling back to browser V2 read", error);
  }
  return fetchFloatV2ActivityFromRpc();
}

async function fetchFloatDeskJournal(): Promise<FloatDeskState> {
  const res = await fetch(`/api/float?mode=desk&ts=${Date.now()}`, { cache: "no-store" });
  const data = (await res.json()) as FloatDeskState;
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `desk read failed with ${res.status}`);
  return data;
}

async function fetchFloatV2ActivityFromRpc(): Promise<FloatV2ActivityState> {
  const client = createClient({
    chain: arcTestnet,
    transport: http(import.meta.env.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network"),
  });
  const latestBlock = BigInt(await client.getBlockNumber());
  const float = getAddress(FLOAT_V2_CONTRACT);
  const [intentLogs, receiptLogs] = await Promise.all([
    getFloatV2Logs(client, float, floatV2IntentConsumedEvent, FLOAT_V2_DEPLOY_BLOCK, latestBlock),
    getFloatV2Logs(client, float, floatV2ReceiptEvent, FLOAT_V2_DEPLOY_BLOCK, latestBlock),
  ]);
  const [treasuryBalance, totalAvailableCredit, totalSponsoredReserve] = await Promise.all([
    readFloatV2Uint(client, "treasuryBalanceUSDC", latestBlock),
    readFloatV2Uint(client, "totalAvailableCreditUSDC", latestBlock),
    readFloatV2Uint(client, "totalSponsoredReserveUSDC", latestBlock),
  ]);

  type AgentStats = {
    label: string;
    category: "external" | "self-test";
    agent: Address;
    spendTx?: Hash;
    repayTx?: Hash;
    latestTxHash?: Hash;
    signedIntents: number;
    providerPaidCount: number;
    repaidCount: number;
    blockedCount: number;
    providerPaidUSDC: bigint;
    repaidUSDC: bigint;
    blockedUSDC: bigint;
  };

  const tracked = new Map(FLOAT_V2_TRACKED_EXTERNAL_AGENTS.map((entry) => [getAddress(entry.agent).toLowerCase(), entry]));
  const statsByAgent = new Map<string, AgentStats>();
  const ensureStats = (address: Address): AgentStats => {
    const agent = getAddress(address);
    const key = agent.toLowerCase();
    const existing = statsByAgent.get(key);
    if (existing) return existing;
    const trackedEntry = tracked.get(key);
    const stats: AgentStats = {
      label: trackedEntry?.label || "V2 proof agent",
      category: trackedEntry ? "external" : "self-test",
      agent,
      spendTx: trackedEntry?.spendTx,
      repayTx: trackedEntry?.repayTx,
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

  for (const entry of FLOAT_V2_TRACKED_EXTERNAL_AGENTS) {
    ensureStats(entry.agent);
  }

  for (const log of intentLogs) {
    const stats = ensureStats(getAddress(String((log as any).args.agent)));
    stats.signedIntents += 1;
    stats.latestTxHash = (log as any).transactionHash;
  }

  for (const log of receiptLogs) {
    const args = (log as any).args;
    const stats = ensureStats(getAddress(String(args.agent)));
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
    [...statsByAgent.values()].map(async (stats): Promise<FloatV2AgentState> => {
      const [line, sponsorLine, behaviorStats, autonomousScore] = await Promise.all([
        readFloatV2Line(client, stats.agent, latestBlock),
        readFloatV2SponsorLine(client, stats.agent, latestBlock),
        readFloatV2BehaviorStats(client, stats.agent, latestBlock),
        readFloatV2AutonomousScore(client, stats.agent, latestBlock),
      ]);
      const status = Number(line[5]);
      const sponsorReserveUSDC = sponsorLine[1].toString();
      const sponsorState =
        sponsorLine[1] > 0n
          ? "active-reserve"
          : stats.repaidCount > 0 && line[2] === 0n && line[4] === 0n
            ? "closed-reserve-reclaimed"
            : "none";
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
        statusName: FLOAT_V2_STATUS_NAMES[status] || "UNKNOWN",
        lastReview: line[6].toString(),
        lastReviewISO: line[6] > 0n ? new Date(Number(line[6]) * 1000).toISOString() : null,
        scoredByContract: true,
        behavior: {
          paidBound: Number(behaviorStats[0]),
          signedExternalPaid: Number(behaviorStats[1]),
          repaid: Number(behaviorStats[2]),
          blocked: Number(behaviorStats[3]),
          denied: Number(behaviorStats[4]),
          errorCount: Number(behaviorStats[5]),
        },
        autonomousScore: {
          score: Number(autonomousScore[0]),
          recommendedLimitUSDC: autonomousScore[1].toString(),
          cappedLimitUSDC: autonomousScore[2].toString(),
        },
        sponsor: sponsorLine[0],
        sponsorReserveUSDC,
        sponsorState,
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
    repaidLifecycles: visibleAgents.reduce((sum, agent) => sum + agent.repaidCount, 0),
    openDebtAgents: visibleAgents.filter((agent) => BigInt(agent.activeDebtUSDC) > 0n).length,
    providerPaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.providerPaidUSDC), 0n).toString(),
    repaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.repaidUSDC), 0n).toString(),
    activeDebtUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.activeDebtUSDC), 0n).toString(),
    blockedUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.blockedUSDC), 0n).toString(),
  };

  return {
    ok: true,
    mode: "shadow-float-v2-activity",
    checkedAt: new Date().toISOString(),
    chainId: arcTestnet.id,
    float,
    latestBlock: latestBlock.toString(),
    treasuryBalanceUSDC: treasuryBalance.toString(),
    totalAvailableCreditUSDC: totalAvailableCredit.toString(),
    totalSponsoredReserveUSDC: totalSponsoredReserve.toString(),
    summary,
    agents: visibleAgents,
    selfTestAgents: agents.filter((agent) => agent.category === "self-test"),
    logFetch: {
      fromBlock: FLOAT_V2_DEPLOY_BLOCK.toString(),
      toBlock: latestBlock.toString(),
      complete: true,
      warnings: [],
    },
  };
}

async function getFloatV2Logs(client: PublicClient, address: Address, event: ReturnType<typeof parseAbiItem>, fromBlock: bigint, toBlock: bigint) {
  const logs: Array<{
    args: Record<string, unknown>;
    transactionHash: Hash;
  }> = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = cursor + FLOAT_V2_LOG_CHUNK_SIZE - 1n > toBlock ? toBlock : cursor + FLOAT_V2_LOG_CHUNK_SIZE - 1n;
    logs.push(...((await client.getLogs({ address, event: event as any, fromBlock: cursor, toBlock: chunkEnd })) as typeof logs));
    cursor = chunkEnd + 1n;
  }
  return logs;
}

async function readFloatV2Uint(
  client: PublicClient,
  functionName: "treasuryBalanceUSDC" | "totalAvailableCreditUSDC" | "totalSponsoredReserveUSDC",
  blockNumber: bigint,
) {
  return client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName, blockNumber }) as Promise<bigint>;
}

async function readFloatV2Line(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "lines",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2LineRead>;
}

async function readFloatV2SponsorLine(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "lineSponsors",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2SponsorLineRead>;
}

async function readFloatV2BehaviorStats(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "behaviorStats",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2BehaviorStatsRead>;
}

async function readFloatV2AutonomousScore(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "autonomousLineScore",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2AutonomousScoreRead>;
}

function App() {
  const [state, setState] = useState<ShadowState | null>(null);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<Address>();
  const [action, setAction] = useState<ActionState>({ label: "ready" });
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<Address | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PresetKey>("balanced");
  const [depositAmount, setDepositAmount] = useState("0.5");
  const [userBalance, setUserBalance] = useState<bigint>(0n);
  const [userFollows, setUserFollows] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [managing, setManaging] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningResponse | null>(null);
  const [closingIntentId, setClosingIntentId] = useState<bigint | null>(null);
  const [pilotAmount, setPilotAmount] = useState("1");
  const [pilotRisk, setPilotRisk] = useState<PilotRisk>("balanced");
  const [pilotPlan, setPilotPlan] = useState<PilotPlan | null>(null);
  const [pilotLoading, setPilotLoading] = useState(false);
  const [pilotExecuting, setPilotExecuting] = useState(false);
  const [pilotError, setPilotError] = useState<string | null>(null);
  const [leptonState, setLeptonState] = useState<LeptonState | null>(null);
  const [leptonLoading, setLeptonLoading] = useState(false);
  const [leptonError, setLeptonError] = useState<string | null>(null);
  const [floatState, setFloatState] = useState<FloatState | null>(null);
  const [floatLoading, setFloatLoading] = useState(false);
  const [floatError, setFloatError] = useState<string | null>(null);
  const [floatV2State, setFloatV2State] = useState<FloatV2ActivityState | null>(FLOAT_V2_VERIFIED_SNAPSHOT);
  const [floatV2Loading, setFloatV2Loading] = useState(false);
  const [floatV2Error, setFloatV2Error] = useState<string | null>(null);
  const [floatDeskState, setFloatDeskState] = useState<FloatDeskState | null>(null);
  const [floatDeskLoading, setFloatDeskLoading] = useState(false);
  const [floatDeskError, setFloatDeskError] = useState<string | null>(null);
  const [treasuryState, setTreasuryState] = useState<TreasuryState | null>(null);
  const [treasuryLoading, setTreasuryLoading] = useState(false);
  const [treasuryError, setTreasuryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/reasoning");
        const data = (await response.json()) as ReasoningResponse;
        if (cancelled) return;
        setReasoning(data);
      } catch {
        // best-effort; transient errors are ignored
      }
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      setState(await fetchShadowState());
    } catch (error) {
      setAction({ label: "read failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshLepton() {
    setLeptonLoading(true);
    try {
      setLeptonState(await fetchLeptonState());
      setLeptonError(null);
    } catch (error) {
      setLeptonError(error instanceof Error ? error.message : String(error));
    } finally {
      setLeptonLoading(false);
    }
  }

  useEffect(() => {
    refreshLepton();
    const interval = setInterval(refreshLepton, 20_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshFloat() {
    setFloatLoading(true);
    try {
      const response = await fetch("/api/float?mode=v1");
      const data = (await response.json()) as FloatState;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Float read failed with ${response.status}`);
      }
      setFloatState(data);
      setFloatError(null);
    } catch (error) {
      setFloatError(error instanceof Error ? error.message : String(error));
    } finally {
      setFloatLoading(false);
    }
  }

  useEffect(() => {
    refreshFloat();
    const interval = setInterval(refreshFloat, 20_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshFloatV2() {
    setFloatV2Loading(true);
    try {
      const data = await fetchFloatV2Activity();
      setFloatV2State({ ...data, source: "live" });
      setFloatV2Error(null);
    } catch (error) {
      setFloatV2State(FLOAT_V2_VERIFIED_SNAPSHOT);
      setFloatV2Error(error instanceof Error ? error.message : String(error));
    } finally {
      setFloatV2Loading(false);
    }
  }

  useEffect(() => {
    refreshFloatV2();
    const interval = setInterval(refreshFloatV2, 20_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshFloatDesk() {
    setFloatDeskLoading(true);
    try {
      setFloatDeskState(await fetchFloatDeskJournal());
      setFloatDeskError(null);
    } catch (error) {
      setFloatDeskError(error instanceof Error ? error.message : String(error));
    } finally {
      setFloatDeskLoading(false);
    }
  }

  useEffect(() => {
    refreshFloatDesk();
    const interval = setInterval(refreshFloatDesk, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshTreasury() {
    setTreasuryLoading(true);
    try {
      const response = await fetch("/api/treasury");
      const data = (await response.json()) as TreasuryState;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Treasury read failed with ${response.status}`);
      }
      setTreasuryState(data);
      setTreasuryError(null);
    } catch (error) {
      setTreasuryError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreasuryLoading(false);
    }
  }

  useEffect(() => {
    refreshTreasury();
    const interval = setInterval(refreshTreasury, 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (state?.sources?.length && !selectedSource) {
      setSelectedSource(state.sources[0].address);
    }
  }, [state, selectedSource]);

  useEffect(() => {
    if (!account || !isConfigured || !state?.sources?.length) {
      setUserBalance(0n);
      setUserFollows(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [balance, ...follows] = await Promise.all([
          publicClient.readContract({
            address: addresses.router!,
            abi: routerAbi,
            functionName: "followerBalanceUSDC",
            args: [account],
          }),
          ...state.sources.map((source) =>
            publicClient.readContract({
              address: addresses.router!,
              abi: routerAbi,
              functionName: "getPolicy",
              args: [account, source.address],
            }),
          ),
        ]);
        if (cancelled) return;
        setUserBalance(balance as bigint);
        const followedSet = new Set<string>();
        state.sources.forEach((source, index) => {
          const policy = follows[index] as readonly [bigint, bigint, Address, number, number, bigint, bigint, boolean];
          if (policy[7]) followedSet.add(source.address.toLowerCase());
        });
        setUserFollows(followedSet);
      } catch {
        // best-effort read; ignore transient RPC errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, state]);

  const copiedReceipts = useMemo(() => state?.receipts.filter((receipt) => receipt.status === "copied") || [], [state]);
  const blockedReceipts = useMemo(() => state?.receipts.filter((receipt) => receipt.status === "blocked") || [], [state]);
  const sourceNameByAddress = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of state?.sources || []) {
      map.set(source.address.toLowerCase(), source.name);
    }
    return map;
  }, [state]);
  const feedReceipts = useMemo(() => {
    const all = state?.receipts || [];
    return all
      .slice()
      .sort((a, b) => Number(b.blockNumber - a.blockNumber))
      .slice(0, 12);
  }, [state]);
  const spotlight = useMemo(() => {
    if (!state) return null;
    const intents = [...state.intents].sort((a, b) => Number(b.blockNumber - a.blockNumber));
    for (const intent of intents) {
      const matches = state.receipts.filter((r) => r.intentId === intent.intentId);
      const copied = matches.find((r) => r.status === "copied");
      const blocked = matches.find((r) => r.status === "blocked");
      if (copied && blocked) return { intent, copied, blocked };
    }
    return null;
  }, [state]);

  async function runVerify() {
    setVerifying(true);
    setVerifyError(null);
    try {
      const demoCode = ((import.meta as any).env?.VITE_SHADOW_DEMO_CODE as string | undefined) || "";
      const response = await fetch("/api/verify-slippage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shadow-demo-code": demoCode },
        body: JSON.stringify({ demoCode }),
      });
      const data = (await response.json()) as VerifyResponse & { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `request failed with ${response.status}`);
      }
      setVerifyResult(data);
      if (data.reasoning) {
        setReasoning({ configured: true, packet: data.reasoning, latestIntentHash: data.reasoning.intentHash });
      }
      refresh();
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setVerifying(false);
    }
  }

  async function connectWallet() {
    if (!window.ethereum) {
      setAction({ label: "wallet missing", error: "Install a browser wallet to write transactions." });
      return;
    }
    try {
      setAction({ label: "connecting wallet" });
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      setAccount(accounts[0]);
      await switchToArc();
      setAction({ label: "wallet connected on Arc Testnet" });
    } catch (error) {
      setAction({ label: "wallet connect failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function followWithPreset() {
    if (!isConfigured || !addresses.router || !addresses.usdc || !addresses.arceth) {
      setAction({ label: "follow blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "follow blocked", error: "Install a browser wallet to follow." });
      return;
    }
    if (!selectedSource) {
      setAction({ label: "follow blocked", error: "Pick a source agent." });
      return;
    }
    let parsedDeposit: bigint;
    try {
      parsedDeposit = parseUnits(depositAmount || "0", 6);
    } catch {
      setAction({ label: "follow blocked", error: "Enter a valid USDC amount." });
      return;
    }
    if (parsedDeposit < 0n) {
      setAction({ label: "follow blocked", error: "Deposit must be non-negative." });
      return;
    }
    const preset = PRESETS[selectedPreset];
    const maxAmount = parseUnits(preset.maxAmountPerIntent, 6);
    const dailyCap = parseUnits(preset.dailyCap, 6);

    setFollowing(true);
    setAction({ label: "follow flow starting" });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({
        account: user,
        chain: arcTestnet,
        transport: custom(window.ethereum),
      });

      if (parsedDeposit > 0n) {
        setAction({ label: `approve ${depositAmount} USDC` });
        const approveTx = await wallet.writeContract({
          account: user,
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.router, parsedDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });

        setAction({ label: `deposit ${depositAmount} USDC`, tx: approveTx });
        const depositTx = await wallet.writeContract({
          account: user,
          address: addresses.router,
          abi: routerAbi,
          functionName: "depositUSDC",
          args: [parsedDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: depositTx });
        setAction({ label: "deposit confirmed", tx: depositTx });
      }

      setAction({ label: `follow ${preset.label.toLowerCase()}` });
      const followTx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource,
          maxAmount,
          dailyCap,
          addresses.arceth,
          preset.maxRiskLevel,
          preset.minBpsOut,
        ],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: followTx });
      setAction({ label: "follow confirmed", tx: followTx });
      await refresh();
    } catch (error) {
      setAction({
        label: "follow failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFollowing(false);
    }
  }

  async function runPilot() {
    if (!state) {
      setPilotError("State is still loading; try again in a moment.");
      return;
    }
    if (state.sources.length === 0) {
      setPilotError("No source agents registered yet.");
      return;
    }
    const amt = Number(pilotAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setPilotError("Enter a positive USDC amount.");
      return;
    }
    setPilotLoading(true);
    setPilotError(null);
    try {
      const reputation = computeEarnedReputation(state);
      const sourceMap = new Map(reputation.map((r) => [r.source.address.toLowerCase(), r]));
      // Make sure every registered source is sent, even if no reputation yet.
      const payloadSources = state.sources.map((src) => {
        const r = sourceMap.get(src.address.toLowerCase());
        return {
          address: src.address,
          name: src.name,
          intentsPublished: r?.intentsPublished || 0,
          copyCount: r?.copyCount || 0,
          blockCount: r?.blockCount || 0,
          copyRateBps: r?.copyRateBps || 0,
          routedUSDC: formatUSDC(r?.routedUSDC || 0n),
          mirrorFeesUSDC: formatUSDC(r?.mirrorFeesUSDC || 0n),
          closedCount: r?.closedCount || 0,
          realizedPnlAvgBps: r?.realizedPnlAvgBps ?? null,
        };
      });
      const response = await fetch("/api/pilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUSDC: pilotAmount, risk: pilotRisk, sources: payloadSources }),
      });
      const data = (await response.json()) as PilotPlan & { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `pilot request failed with ${response.status}`);
      }
      setPilotPlan(data);
    } catch (err) {
      setPilotError(err instanceof Error ? err.message : String(err));
    } finally {
      setPilotLoading(false);
    }
  }

  async function executePilot() {
    if (!pilotPlan) return;
    if (!isConfigured || !addresses.router || !addresses.usdc || !addresses.arceth) {
      setAction({ label: "pilot blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "pilot blocked", error: "Install a browser wallet." });
      return;
    }
    setPilotExecuting(true);
    setAction({ label: "pilot starting" });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({
        account: user,
        chain: arcTestnet,
        transport: custom(window.ethereum),
      });
      const totalDeposit = pilotPlan.allocation.reduce(
        (sum, slice) => sum + parseUnits(slice.amountUSDC || "0", 6),
        0n,
      );

      if (addresses.pilotAttestor) {
        setAction({ label: "anchor decision onchain" });
        const decisionHashBytes32 = normalizeBytes32(pilotPlan.decisionHash);
        const modelHash = keccak256(stringToBytes(pilotPlan.model));
        const attestTx = await wallet.writeContract({
          account: user,
          address: addresses.pilotAttestor,
          abi: pilotAttestorAbi,
          functionName: "attest",
          args: [
            decisionHashBytes32,
            totalDeposit,
            pilotPlan.allocation.length,
            pilotPlan.confidenceBps,
            modelHash,
          ],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: attestTx });
        setAction({ label: "decision anchored", tx: attestTx });
      }
      if (totalDeposit > 0n) {
        setAction({ label: `approve ${formatUSDC(totalDeposit)} USDC` });
        const approveTx = await wallet.writeContract({
          account: user,
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.router, totalDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        setAction({ label: `deposit ${formatUSDC(totalDeposit)} USDC`, tx: approveTx });
        const depositTx = await wallet.writeContract({
          account: user,
          address: addresses.router,
          abi: routerAbi,
          functionName: "depositUSDC",
          args: [totalDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: depositTx });
        setAction({ label: "deposit confirmed", tx: depositTx });
      }
      for (let i = 0; i < pilotPlan.allocation.length; i++) {
        const slice = pilotPlan.allocation[i];
        const preset = PRESETS[slice.preset];
        setAction({
          label: `follow ${slice.name} ${preset.label.toLowerCase()} (${i + 1}/${pilotPlan.allocation.length})`,
        });
        const followTx = await wallet.writeContract({
          account: user,
          address: addresses.router,
          abi: routerAbi,
          functionName: "followSource",
          args: [
            slice.sourceAddress as Address,
            parseUnits(preset.maxAmountPerIntent, 6),
            parseUnits(preset.dailyCap, 6),
            addresses.arceth,
            preset.maxRiskLevel,
            preset.minBpsOut,
          ],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: followTx });
        setAction({ label: `${slice.name} followed`, tx: followTx });
      }
      setAction({ label: "pilot plan executed" });
      await refresh();
    } catch (err) {
      setAction({ label: "pilot failed", error: err instanceof Error ? err.message : String(err) });
    } finally {
      setPilotExecuting(false);
    }
  }

  async function withdraw() {
    if (!isConfigured || !addresses.router) {
      setAction({ label: "withdraw blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "withdraw blocked", error: "Install a browser wallet." });
      return;
    }
    let parsed: bigint;
    try {
      parsed = parseUnits(withdrawAmount || "0", 6);
    } catch {
      setAction({ label: "withdraw blocked", error: "Enter a valid USDC amount." });
      return;
    }
    if (parsed <= 0n) {
      setAction({ label: "withdraw blocked", error: "Amount must be positive." });
      return;
    }
    if (parsed > userBalance) {
      setAction({ label: "withdraw blocked", error: "Amount exceeds router balance." });
      return;
    }
    setManaging(true);
    setAction({ label: `withdraw ${withdrawAmount} USDC` });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({ account: user, chain: arcTestnet, transport: custom(window.ethereum) });
      const tx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "withdrawUSDC",
        args: [parsed],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAction({ label: "withdraw confirmed", tx });
      setWithdrawAmount("");
      await refresh();
    } catch (error) {
      setAction({ label: "withdraw failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setManaging(false);
    }
  }

  async function unfollow(source: Address) {
    if (!isConfigured || !addresses.router) {
      setAction({ label: "unfollow blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "unfollow blocked", error: "Install a browser wallet." });
      return;
    }
    setManaging(true);
    setAction({ label: `unfollow ${shortAddress(source)}` });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({ account: user, chain: arcTestnet, transport: custom(window.ethereum) });
      const tx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "unfollowSource",
        args: [source],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAction({ label: "unfollow confirmed", tx });
      await refresh();
    } catch (error) {
      setAction({ label: "unfollow failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setManaging(false);
    }
  }

  async function closePosition(intentId: bigint) {
    if (!isConfigured || !addresses.router) {
      setAction({ label: "close blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "close blocked", error: "Install a browser wallet." });
      return;
    }
    setClosingIntentId(intentId);
    setAction({ label: `closing intent ${intentId.toString()}` });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({ account: user, chain: arcTestnet, transport: custom(window.ethereum) });
      const tx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "closePosition",
        args: [intentId],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAction({ label: "position closed", tx });
      await refresh();
    } catch (error) {
      setAction({ label: "close failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setClosingIntentId(null);
    }
  }

  const navigate = useNavigate();

  const followFromAgents = (addr: Address) => {
    setSelectedSource(addr);
    navigate("/follow");
  };

  const homePage = (
    <>
      <section className="hero" id="top">
        <div className="heroBackdrop" aria-hidden="true">
          <span className="heroBackdropGrid" />
          <span className="heroBackdropGlow heroBackdropGlow--graphite" />
          <span className="heroBackdropGlow heroBackdropGlow--signal" />
          <span className="heroBackdropTrail" />
        </div>
        <div className="heroGrid">
          <div className="heroCopy">
            <div className="heroBadge">
              <span className="heroBadgeDot" />
              Shadow Float V2 · live on Arc testnet
            </div>
            <h1>Agents can buy services before every wallet is pre funded.</h1>
            <p className="lede">
              Shadow Float gives autonomous agents a small, policy-bound USDC spending line. A sponsor reserves Arc USDC,
              the agent signs a bounded intent, the contract pays the provider, debt opens, repayment restores capacity,
              and oversized requests are blocked before funds move.
            </p>
            <HomeTruthStrip floatState={floatV2State} deskState={floatDeskState} deskLoading={floatDeskLoading} />
            <div className="heroActions">
              <Link to="/float" className="heroCtaPrimary">
                Open Shadow Float
                <span className="heroCtaArrow">→</span>
              </Link>
              <Link className="heroCtaSecondary" to="/float#v2-activity">
                View external board
              </Link>
            </div>
            <ul className="heroTrust" aria-label="Built on">
              <li><span className="heroTrustDot heroTrustDot--signal" />Arc testnet</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />Arc USDC</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />contract-enforced intents</li>
              <li>
                <span className="heroTrustDot heroTrustDot--signal" />
                external V2 intents live
              </li>
            </ul>
          </div>
          <HeroDiagram />
        </div>
        <HeroMetrics state={floatV2State} loading={floatV2Loading} error={floatV2Error} />
      </section>

      <HomeProofOverview state={floatV2State} loading={floatV2Loading} error={floatV2Error} />

      <section className="pageNext" aria-label="Shadow Float product paths">
        <Link to="/float" className="pageNextCard pageNextCardPrimary">
          <span className="pageNextEyebrow">product</span>
          <span className="pageNextTitle">Walk the signed spend, provider payment, debt, repay, block, and denial loop</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/treasury" className="pageNextCard">
          <span className="pageNextEyebrow">records</span>
          <span className="pageNextTitle">Check the supporting adapter records without leaving the Float story</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/builders" className="pageNextCard">
          <span className="pageNextEyebrow">builders</span>
          <span className="pageNextTitle">Give your agent a sponsor-backed line and sign a bounded spend intent</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/roadmap" className="pageNextCard">
          <span className="pageNextEyebrow">roadmap</span>
          <span className="pageNextTitle">See what is live now, what matured this week, and what remains next</span>
          <span className="pageNextArrow">→</span>
        </Link>
      </section>
    </>
  );

  const treasuryPage = (
    <>
      <TreasuryHero treasuryState={treasuryState} />
      <TreasuryEvidenceStrip treasuryState={treasuryState} />
      <TreasuryRailSplit leptonState={leptonState} />
      <TreasuryLiveVerifierPanel state={treasuryState} loading={treasuryLoading} error={treasuryError} />
      <TreasuryOnchainLinks />
      <TreasuryValidationPanel />
    </>
  );

  const floatPage = (
    <>
      <FloatV2CurrentPanel
        state={floatV2State}
        loading={floatV2Loading}
        error={floatV2Error}
        deskState={floatDeskState}
        deskLoading={floatDeskLoading}
        deskError={floatDeskError}
      />
    </>
  );

  const buildersPage = (
    <div className="routePage">
      <section className="pageHead">
        <p className="pageEyebrow">builders · agent access</p>
        <h1 className="pageTitle">Give your agent sponsor-backed capacity without pre funding it first.</h1>
        <p className="pageLede">
          Shadow Float is for buyer agents that need paid data, compute, or API calls under strict policy. The agent signs
          a bounded intent; V2 verifies it onchain, pays the named provider from sponsor reserve, and records the debt trail.
        </p>
      </section>
      <section className="builderFlowGrid" aria-label="Builder integration flow">
        <article className="builderFlowCard">
          <span>1</span>
          <strong>Request a line</strong>
          <p>Share the Arc testnet wallet your agent actually controls. A sponsor reserves bounded USDC capacity for that signer.</p>
        </article>
        <article className="builderFlowCard">
          <span>2</span>
          <strong>Sign an intent</strong>
          <p>Sign typed data locally. The key stays on your machine; only the intent JSON and signature are shared.</p>
        </article>
        <article className="builderFlowCard">
          <span>3</span>
          <strong>Contract pays provider</strong>
          <p>ShadowFloat verifies the intent onchain, pays the named provider from custody, and opens debt against the line.</p>
        </article>
        <article className="builderFlowCard">
          <span>4</span>
          <strong>Repay when ready</strong>
          <p>Your agent can repay from its own wallet to close the external borrow, spend, and repay loop.</p>
        </article>
      </section>
      <section className="builderReferenceGrid" aria-label="Builder references">
        <article className="builderReferenceCard">
          <span>line state lookup</span>
          <code>/api/float-tools?action=agent&amp;address=0x...</code>
          <p>Read the current line limit, available capacity, active debt, and status for a registered agent.</p>
        </article>
        <article className="builderReferenceCard">
          <span>typed-data intent</span>
          <code>/api/float-tools?action=intent&amp;agent=0x...&amp;reason=...</code>
          <p>Returns the exact EIP-712 payload a builder can sign with their own wallet tooling. No Shadow script or private key env is required.</p>
        </article>
        <article className="builderReferenceCard">
          <span>intent verifier</span>
          <code>/api/float-tools?action=verify&amp;hash=0x...</code>
          <p>Verify signer, request hash, onchain receipt, V2 direct provider payment, and nonce use.</p>
        </article>
        <article className="builderReferenceCard">
          <span>local scripts</span>
          <code>float-builder-sign.mjs · float-builder-repay.mjs</code>
          <p>Reference helpers for local signing and repayment. Builders can also construct calls with their own signer.</p>
        </article>
      </section>
    </div>
  );

  const roadmapPage = (
    <div className="routePage">
      <section className="pageHead">
        <p className="pageEyebrow">product status</p>
        <h1 className="pageTitle">What is live on Arc, and what comes next.</h1>
        <p className="pageLede">
          Shadow Float now covers the full testnet loop: sponsor reserve, signed authorization, provider payment, debt,
          repayment, automated scoring, external sponsors, Gateway settlement evidence, and CCTP acknowledgement. The next
          work is production custody and larger provider markets.
        </p>
      </section>
      <section className="roadmapStatusBand" aria-label="Live Shadow Float milestones">
        <article>
          <span>live now</span>
          <strong>Float V2 spending lines</strong>
          <p>Agents sign bounded intents, providers are paid from sponsor-backed reserve, debt is recorded, and repayment restores capacity.</p>
        </article>
        <article>
          <span>matured</span>
          <strong>External sponsor capital</strong>
          <p>CitePay and Forum Tollgate opened external sponsored lines; Forum closed its line and reclaimed the full reserve.</p>
        </article>
        <article>
          <span>matured</span>
          <strong>Circle interop evidence</strong>
          <p>Gateway settled recorded Desk amounts, and CCTP attestation verification is live through Shadow&apos;s acknowledgement route.</p>
        </article>
      </section>
      <section className="roadmapGrid" aria-label="Shadow Float roadmap">
        <article className="roadmapCard">
          <span>next</span>
          <strong>Production-grade mandate custody</strong>
          <p>Move M1 adapter allocation into a withdrawable custody model with cleaner release rules and stronger execution accountability.</p>
        </article>
        <article className="roadmapCard">
          <span>next</span>
          <strong>Provider delivery receipts</strong>
          <p>Make provider-signed delivery receipts part of the standard public flow so payment and service delivery can be checked together.</p>
        </article>
        <article className="roadmapCard">
          <span>next</span>
          <strong>More independent providers</strong>
          <p>Expand from CitePay-style paid answers into more data, scan, compute, and API services that agents can buy through Float.</p>
        </article>
        <article className="roadmapCard">
          <span>next</span>
          <strong>Deeper sponsor controls</strong>
          <p>Give sponsors clearer dashboards for daily limits, provider mandates, reserve reclaim, defaults, and risk exposure.</p>
        </article>
        <article className="roadmapCard">
          <span>mainnet</span>
          <strong>Treasury reserve model</strong>
          <p>Define reserve providers, fee policy, and default handling for larger spending lines without weakening the reserve floor.</p>
        </article>
      </section>
    </div>
  );

  return (
    <main className="shell">
      <nav className="nav">
        <Link className="brand" to="/" aria-label="Shadow">
          <ShadowMark />
          <span>Shadow</span>
        </Link>
        <div className="navLinks">
          <NavLink end to="/" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Home
          </NavLink>
          <NavLink to="/float" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Float
          </NavLink>
          <NavLink to="/treasury" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Records
          </NavLink>
          <NavLink to="/builders" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Builders
          </NavLink>
          <NavLink to="/roadmap" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Roadmap
          </NavLink>
        </div>
        <div className="navActions">
          <button
            className={account ? "navWallet connected" : "navWallet"}
            onClick={connectWallet}
            type="button"
            aria-label={account ? `Connected wallet ${account}` : "Connect wallet"}
          >
            <span className="navWalletDot" />
            {account ? shortAddress(account) : "Wallet"}
          </button>
          <Link to="/float" className="navCta">
            Open Float
          </Link>
        </div>
      </nav>

      <RouteScroll />

      <Routes>
        <Route path="/" element={homePage} />
        <Route path="/agents" element={<Navigate to="/float" replace />} />
        <Route path="/follow" element={<Navigate to="/builders" replace />} />
        <Route path="/receipts" element={<Navigate to="/float" replace />} />
        <Route path="/lepton" element={<Navigate to="/treasury" replace />} />
        <Route path="/treasury" element={treasuryPage} />
        <Route path="/float" element={floatPage} />
        <Route path="/proof" element={<Navigate to="/float" replace />} />
        <Route path="/builders" element={buildersPage} />
        <Route path="/roadmap" element={roadmapPage} />
        <Route path="/archive" element={<Navigate to="/float" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <SiteFooter />
    </main>
  );
}

function RouteScroll() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const id = hash.slice(1);
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        else window.scrollTo({ top: 0, behavior: "auto" });
      });
    } else {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [pathname, hash]);
  return null;
}

function TreasuryHero({ treasuryState }: {
  treasuryState: TreasuryState | null;
}) {
  const railStats = [
    { label: "V2 provider paid", value: "0.01 USDC", tone: "allow" },
    { label: "vault allocated", value: `${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`, tone: "allow" },
    { label: "blocked first", value: `${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`, tone: "block" },
    { label: "external V2 lifecycle", value: "Crux repaid", tone: "neutral" },
  ];
  const verifierLabel = treasuryState
    ? treasuryState.ok
      ? `${treasuryState.checks?.filter((check) => check.ok).length || 0}/${treasuryState.checks?.length || 0} record checks`
      : "record verifier red"
    : "record verifier ready";

  return (
    <section className="treasuryHero" aria-label="Shadow supporting records overview">
      <div className="treasuryHeroCopy">
        <p className="eyebrow">supporting records</p>
        <h1>Mandate checks and settlement records sit behind the Float product.</h1>
        <p>
          This page keeps the supporting records visible without making them the main story: approved-adapter checks,
          settlement records, and over-limit blocks that complement Float V2.
        </p>
        <div className="treasuryHeroActions">
          <Link className="treasuryHeroPrimary" to="/float">
            Open Float V2
          </Link>
          <a className="treasuryHeroSecondary" href={FLOAT_V2_PROOF.sourcify} target="_blank" rel="noreferrer">
            View V2 source
          </a>
        </div>
        <div className="treasuryHeroBoundary" aria-label="Verified receipt scope">
          <span>External Float usage live</span>
          <span>mandate adapter record</span>
          <span>{verifierLabel}</span>
        </div>
      </div>

      <aside className="treasuryFlow" aria-label="Shadow supporting records flow">
        <div className="treasuryFlowHeader">
          <span>execution wallet</span>
          <code>{shortAddress(TREASURY_PROOF.operator)}</code>
        </div>
        <div className="treasuryFlowBranch allow">
          <span>Float path</span>
          <strong>Provider paid</strong>
          <a href={txUrl(FLOAT_V2_PROOF.directSpendTx)} target="_blank" rel="noreferrer">
            {shortAddress(FLOAT_V2_PROOF.directSpendTx)}
          </a>
        </div>
        <div className="treasuryFlowBranch allow">
          <span>mandate path</span>
          <strong>Allocates to vault</strong>
          <a href={txUrl(TREASURY_PROOF.txs.allocation)} target="_blank" rel="noreferrer">
            {shortAddress(TREASURY_PROOF.txs.allocation)}
          </a>
        </div>
        <div className="treasuryFlowBranch block">
          <span>policy guard</span>
          <strong>Blocks overreach</strong>
          <a href={txUrl(TREASURY_PROOF.txs.blocked)} target="_blank" rel="noreferrer">
            {shortAddress(TREASURY_PROOF.txs.blocked)}
          </a>
        </div>
        <div className="treasuryFlowFooter">
          <span>strict verifier</span>
          <code>npm run float:v2-verify-live</code>
        </div>
      </aside>

      <div className="treasuryHeroStats" aria-label="Shadow supporting record amounts">
        {railStats.map((stat) => (
          <div className={`treasuryHeroStat ${stat.tone}`} key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function TreasuryEvidenceStrip({ treasuryState }: { treasuryState: TreasuryState | null }) {
  const passed = treasuryState?.checks?.filter((check) => check.ok).length;
  const total = treasuryState?.checks?.length;
  const contractLinks = [
    { label: "Float V2", value: FLOAT_V2_CONTRACT, href: `https://testnet.arcscan.app/address/${FLOAT_V2_CONTRACT}` },
    {
      label: "MandateRegistry",
      value: TREASURY_PROOF.mandateRegistry,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.mandateRegistry}`,
    },
    {
      label: "BondedEnforcer",
      value: TREASURY_PROOF.bondedEnforcer,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.bondedEnforcer}`,
    },
    {
      label: "Morpho adapter",
      value: TREASURY_PROOF.morphoAdapter,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.morphoAdapter}`,
    },
  ];
  const txLinks = [
    { label: "V2 provider payment", value: FLOAT_V2_PROOF.directSpendTx, href: txUrl(FLOAT_V2_PROOF.directSpendTx) },
    { label: "V2 blocked spend", value: FLOAT_V2_PROOF.blockedSpendTx, href: txUrl(FLOAT_V2_PROOF.blockedSpendTx) },
    { label: "vault allocation", value: TREASURY_PROOF.txs.allocation, href: txUrl(TREASURY_PROOF.txs.allocation) },
    { label: "blocked allocation", value: TREASURY_PROOF.txs.blocked, href: txUrl(TREASURY_PROOF.txs.blocked) },
  ];

  return (
    <section className="treasuryEvidenceStrip" aria-label="Shadow supporting records onchain evidence">
      <div className="treasuryEvidenceIntro">
        <span>onchain evidence</span>
        <strong>{treasuryState?.ok ? `${passed}/${total} live checks pass` : "contracts and txs visible"}</strong>
        <p>Contract addresses and ArcScan transactions are visible from the product surface.</p>
      </div>
      <div className="treasuryEvidenceGroup" aria-label="Record contracts">
        {contractLinks.map((item) => (
          <a href={item.href} target="_blank" rel="noreferrer" key={item.label}>
            <span>{item.label}</span>
            <code>{shortAddress(item.value)}</code>
          </a>
        ))}
      </div>
      <div className="treasuryEvidenceGroup" aria-label="Record transactions">
        {txLinks.map((item) => (
          <a href={item.href} target="_blank" rel="noreferrer" key={item.label}>
            <span>{item.label}</span>
            <code>{shortAddress(item.value)}</code>
          </a>
        ))}
        <a href="/api/treasury" target="_blank" rel="noreferrer">
          <span>verifier JSON</span>
          <code>/api/treasury</code>
        </a>
      </div>
    </section>
  );
}

function TreasuryRailSplit({
  leptonState,
}: {
  leptonState: LeptonState | null;
}) {
  const railCards = [
    {
      eyebrow: "payment path",
      title: "Float pays before the agent is funded",
      body: "Signed agents authorize a spend, Float pays the approved provider from reserved capacity, fee-inclusive debt opens, and repayment restores capacity.",
      stat: "V2 signed intent live",
      href: "/float",
      cta: "Open Float",
    },
    {
      eyebrow: "allocation path",
      title: "Mandate adapters gate approved movement",
      body: "The approved adapter authenticates the account, reads the bonded enforcer's ALLOW or BLOCK decision, and only moves vault-style USDC on ALLOW. This guarantee is scoped to approved adapters.",
      stat: leptonState?.morphoDepositedUSDC !== undefined ? `${formatUSDC(leptonState.morphoDepositedUSDC)} USDC allocated` : "0.1 USDC allocated",
      href: "/treasury",
      cta: "View records",
    },
    {
      eyebrow: "combined receipts",
      title: "One read-only check follows the transaction path",
      body: "The current product surface separates Float V2 payments from adapter records and settlement evidence, while keeping every anchor public.",
      stat: "Arc tx anchors",
      href: "https://github.com/dolepee/shadow",
      cta: "View repo",
    },
  ];

  return (
    <section className="treasuryRailSection" aria-label="Shadow supporting records path split">
      <div className="treasurySectionHeader">
        <p className="eyebrow">supporting records</p>
        <h2>Payments, adapter movement, and settlement records stay separated and verifiable.</h2>
      </div>
      <div className="treasuryRailGrid">
        {railCards.map((card) => {
          const content = (
            <>
              <span>{card.eyebrow}</span>
              <strong>{card.title}</strong>
              <p>{card.body}</p>
              <em>{card.stat}</em>
              <small>{card.cta} →</small>
            </>
          );
          return card.href.startsWith("http") ? (
            <a className="treasuryRailCard" href={card.href} target="_blank" rel="noreferrer" key={card.eyebrow}>
              {content}
            </a>
          ) : (
            <Link className="treasuryRailCard" to={card.href} key={card.eyebrow}>
              {content}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function TreasuryProofPanel({
  floatState,
  leptonState,
  treasuryState,
}: {
  floatState: FloatState | null;
  leptonState: LeptonState | null;
  treasuryState: TreasuryState | null;
}) {
  const indexedFloatReceipt = Boolean(
    floatState?.receipts?.some(
      (receipt) => receipt.requestHash?.toLowerCase() === TREASURY_PROOF.hashes.floatRequest.toLowerCase(),
    ),
  );
  const m1HasVaultProof = Boolean(leptonState?.morphoDepositedUSDC && leptonState.morphoDepositedUSDC > 0n);
  const m1HasBlockProof = Boolean(leptonState?.morphoBlockedUSDC && leptonState.morphoBlockedUSDC > 0n);
  const proofRows = [
    {
      status: indexedFloatReceipt ? "live" : "verifier",
      title: "Float paid the provider",
      amount: TREASURY_PROOF.amountX402USDC,
      receipt: "SPEND_ALLOWED + X402PaymentBound",
      meaning: "The supporting path uses the historical Float record: the execution wallet fronted Arc USDC to the provider, then bound the settlement into Float debt.",
      links: [
        { label: "settlement", href: txUrl(TREASURY_PROOF.txs.x402Settlement) },
        { label: "bind", href: txUrl(TREASURY_PROOF.txs.floatBind) },
        { label: "verify", href: `/api/float-tools?action=verify&hash=${TREASURY_PROOF.hashes.floatRequest}` },
      ],
    },
    {
      status: m1HasVaultProof ? "live" : "verifier",
      title: "M1 allocated USDC into a vault sink",
      amount: TREASURY_PROOF.amountAllocatedUSDC,
      receipt: "ALLOW",
      meaning: "The bonded mandate path allowed a vault-style allocation only after policy checks passed.",
      links: [{ label: "allocation", href: txUrl(TREASURY_PROOF.txs.allocation) }],
    },
    {
      status: m1HasBlockProof ? "live" : "verifier",
      title: "M1 blocked an oversized allocation",
      amount: TREASURY_PROOF.amountBlockedUSDC,
      receipt: "BLOCK / AMOUNT_TOO_HIGH",
      meaning: "The same mandate refused an over-limit allocation before vault USDC moved.",
      links: [{ label: "block", href: txUrl(TREASURY_PROOF.txs.blocked) }],
    },
    {
      status: "proven",
      title: "Read-only checks cover both paths",
      amount: `${formatFloatUSDC(TREASURY_PROOF.feeUSDC)} fee`,
      receipt: "npm run treasury:verify-live",
      meaning: "The command checks the payment tx, bind event, vault movement, blocked no-move path, debt, and fee.",
      links: [{ label: "repo", href: "https://github.com/dolepee/shadow" }],
    },
  ];

  return (
    <section className="treasuryProofPanel" id="treasury-runway" aria-label="Shadow Treasury live transaction runway">
      <div className="treasuryProofHeader">
        <div>
          <p className="eyebrow">live transaction runway · Arc receipts</p>
          <h2>One execution wallet paid, allocated, and was stopped on the third action.</h2>
          <p>
            The sequence below is deliberately concrete: one provider payment, one vault allocation, one blocked over-limit
            allocation, and one read-only check. It shows the scoped M1 adapter path that is live on Arc testnet.
          </p>
        </div>
        <div className={`treasuryProofStatus ${treasuryState?.ok === false ? "fail" : ""}`}>
          <span className="treasuryProofStatusDot" />
          {treasuryState ? (treasuryState.ok ? "live checks green" : "checks need review") : "checks ready"}
        </div>
      </div>

      <div className="treasuryMetricGrid" aria-label="Treasury transaction amounts">
        <TreasuryMetric label="Float paid" value={`${formatFloatUSDC(TREASURY_PROOF.amountX402USDC)} USDC`} tone="allow" />
        <TreasuryMetric label="vault allocated" value={`${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`} tone="allow" />
        <TreasuryMetric label="blocked attempt" value={`${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`} tone="block" />
        <TreasuryMetric label="Float fee" value={`${formatFloatUSDC(TREASURY_PROOF.feeUSDC)} USDC`} />
      </div>

      <div className="treasuryProofLayout">
        <div className="treasuryTimeline">
          {proofRows.map((row, index) => (
            <article className={`treasuryStep ${row.status}`} key={row.title}>
              <div className="treasuryStepIndex">{index + 1}</div>
              <div className="treasuryStepBody">
                <div className="treasuryStepMeta">
                  <span>{row.status}</span>
                  <code>{row.receipt}</code>
                </div>
                <strong>{row.title}</strong>
                <p>{row.meaning}</p>
                <div className="treasuryStepFooter">
                  <span>{row.amount.includes("fee") ? row.amount : `${formatFloatUSDC(row.amount)} USDC`}</span>
                  <div className="treasuryStepLinks">
                    {row.links.map((link) =>
                      link.href.startsWith("http") || link.href.startsWith("/api") ? (
                        <a key={link.label} href={link.href} target="_blank" rel="noreferrer">
                          {link.label}
                        </a>
                      ) : (
                        <Link key={link.label} to={link.href}>
                          {link.label}
                        </Link>
                      ),
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>

        <aside className="treasuryContractStack" aria-label="Contracts used in the Treasury transaction path">
          <div>
            <span>operator</span>
            <code>{shortAddress(TREASURY_PROOF.operator)}</code>
          </div>
          <div>
            <span>Float</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.float}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.float)}
            </a>
          </div>
          <div>
            <span>MandateRegistry</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.mandateRegistry}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.mandateRegistry)}
            </a>
          </div>
          <div>
            <span>BondedEnforcer</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.bondedEnforcer}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.bondedEnforcer)}
            </a>
          </div>
          <div>
            <span>Morpho-style adapter</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.morphoAdapter}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.morphoAdapter)}
            </a>
          </div>
          <div>
            <span>vault sink</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.vaultSink}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.vaultSink)}
            </a>
          </div>
        </aside>
      </div>

      <div className="treasuryBoundary">
        <span>External Float signed usage is live.</span>
        <span>CitePay and Forum gave technical feedback on the adapter record path.</span>
        <span>
          API and CLI both check the combined path: <code>/api/treasury</code> and <code>npm run treasury:verify-live</code>.
        </span>
      </div>
    </section>
  );
}

function TreasuryReceiptStructurePanel() {
  const receipts = [
    {
      title: "ALLOW receipt",
      subtitle: "vault allocation",
      href: txUrl(TREASURY_PROOF.txs.allocation),
      fields: [
        "decision = ALLOW",
        "reason = NONE",
        `amount = ${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`,
        `actor = ${shortAddress(TREASURY_PROOF.operator)}`,
        `target = ${shortAddress(TREASURY_PROOF.morphoAdapter)}`,
        `actionHash = ${shortAddress(TREASURY_PROOF.hashes.allowedAction as Hash)}`,
      ],
    },
    {
      title: "BLOCK receipt",
      subtitle: "over-limit allocation",
      href: txUrl(TREASURY_PROOF.txs.blocked),
      fields: [
        "decision = BLOCK",
        "reason = AMOUNT_TOO_HIGH",
        `amount = ${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`,
        `actor = ${shortAddress(TREASURY_PROOF.operator)}`,
        "vault Transfer = none",
        `actionHash = ${shortAddress(TREASURY_PROOF.hashes.blockedAction as Hash)}`,
      ],
    },
    {
      title: "Float debt receipt",
      subtitle: "historical Float payment",
      href: `/api/float-tools?action=verify&hash=${TREASURY_PROOF.hashes.floatRequest}`,
      fields: [
        "receipt = SPEND_ALLOWED + PROVIDER_PAID + FEE_ACCRUED + DEBT_OPENED",
        `provider paid = ${formatFloatUSDC(TREASURY_PROOF.amountX402USDC)} USDC`,
        `fee = ${formatFloatUSDC(TREASURY_PROOF.feeUSDC)} USDC`,
        `requestHash = ${shortAddress(TREASURY_PROOF.hashes.floatRequest as Hash)}`,
      ],
    },
  ];

  return (
    <section className="treasuryReceiptStructure" aria-label="Treasury receipt structure">
      <div className="treasurySectionHeader">
        <p className="eyebrow">receipt structure · defined fields</p>
        <h2>ALLOW and BLOCK are not labels; they are receipt fields checked by the verifier.</h2>
      </div>
      <div className="treasuryReceiptGrid">
        {receipts.map((receipt) => (
          <a className="treasuryReceiptCard" href={receipt.href} target="_blank" rel="noreferrer" key={receipt.title}>
            <span>{receipt.subtitle}</span>
            <strong>{receipt.title}</strong>
            <ul>
              {receipt.fields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </a>
        ))}
      </div>
    </section>
  );
}

function TreasuryLiveVerifierPanel({
  state,
  loading,
  error,
}: {
  state: TreasuryState | null;
  loading: boolean;
  error: string | null;
}) {
  const checks = state?.checks || [];
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  const visibleChecks = checks.slice(0, 8);
  const checkedAt = state?.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <section className="treasuryLiveVerifier" aria-label="Live Shadow records verifier">
      <div className="treasuryLiveVerifierHeader">
        <div>
          <p className="eyebrow">live verifier · no private keys</p>
          <h2>The Records page reads the same onchain checks as the CLI.</h2>
          <p>
            This endpoint verifies the mandate adapter path from live Arc state. The current Float V2 payment anchors are
            shown on the Float page.
          </p>
        </div>
        <a href="/api/treasury" target="_blank" rel="noreferrer" className={`treasuryVerifierBadge ${state?.ok ? "pass" : error ? "fail" : ""}`}>
          {loading && !state ? "syncing" : state?.ok ? "PASS" : error ? "CHECK API" : "loading"}
          {state && <span>{passed}/{checks.length} checks</span>}
        </a>
      </div>

      {error ? (
        <div className="treasuryVerifierError">
          <strong>Verifier read failed</strong>
          <p>{error}</p>
        </div>
      ) : (
        <div className="treasuryVerifierGrid">
          <article className="treasuryVerifierSummary">
            <span>combined path</span>
            <strong>{state?.ok ? "green" : loading ? "syncing" : "pending"}</strong>
            <p>
              {failed
                ? `${failed} check${failed === 1 ? "" : "s"} need attention before relying on this view.`
                : state
                  ? `All ${passed} live checks passed${checkedAt ? ` at ${checkedAt}` : ""}.`
                  : "Waiting for the live records API to return."}
            </p>
            <div>
              <a href="/api/treasury" target="_blank" rel="noreferrer">
                Open JSON
              </a>
              <a href="https://github.com/dolepee/shadow" target="_blank" rel="noreferrer">
                Run CLI
              </a>
            </div>
          </article>
          <div className="treasuryVerifierChecks">
            {visibleChecks.map((check) => (
              <article className={check.ok ? "pass" : "fail"} key={check.check}>
                <span>{check.status}</span>
                <strong>{check.check}</strong>
                <p>{check.detail}</p>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TreasuryOnchainLinks() {
  const links = [
    { label: "Strict V2 verifier", value: "npm run float:v2-verify-live", href: "https://github.com/dolepee/shadow" },
    { label: "V2 provider payment", value: shortAddress(FLOAT_V2_PROOF.directSpendTx), href: txUrl(FLOAT_V2_PROOF.directSpendTx) },
    { label: "V2 blocked spend", value: shortAddress(FLOAT_V2_PROOF.blockedSpendTx), href: txUrl(FLOAT_V2_PROOF.blockedSpendTx) },
    { label: "Vault allocation", value: shortAddress(TREASURY_PROOF.txs.allocation), href: txUrl(TREASURY_PROOF.txs.allocation) },
    { label: "Blocked allocation", value: shortAddress(TREASURY_PROOF.txs.blocked), href: txUrl(TREASURY_PROOF.txs.blocked) },
    { label: "V2 source match", value: shortAddress(FLOAT_V2_CONTRACT), href: FLOAT_V2_PROOF.sourcify },
  ];

  return (
    <section className="treasuryJudgePath" aria-label="Shadow Treasury onchain references">
      <div className="treasurySectionHeader">
        <p className="eyebrow">onchain references</p>
        <h2>The same story resolves to public transactions.</h2>
      </div>
      <div className="treasuryJudgeGrid">
        {links.map((link) => (
          <a className="treasuryJudgeLink" href={link.href} target="_blank" rel="noreferrer" key={link.label}>
            <span>{link.label}</span>
            <strong>{link.value}</strong>
          </a>
        ))}
      </div>
    </section>
  );
}

function TreasuryValidationPanel() {
  const validationRows = [
    {
      label: "Obol",
      status: "verified Float draw",
      detail: "Buyer-side agent signed a current-contract spend intent and returned the bind plus repayment flow.",
    },
    {
      label: "Argus",
      status: "signed security-agent intent",
      detail: "Agent Alpha signed a Float intent for paid x402 security data before producing a verdict.",
    },
    {
      label: "CitePay",
      status: "architecture fit feedback",
      detail: "Builder feedback says Float + M1 fits agent/x402 workflows because enforcement happens before USDC leaves the policy boundary.",
    },
    {
      label: "Forum",
      status: "live tx feedback",
      detail: "Forum checked the Arc transactions and noted that the same vault entrypoint moved funds when allowed, then moved zero USDC when over limit.",
    },
  ];

  return (
    <section className="treasuryValidationSection" aria-label="External feedback and builder background">
      <div className="treasurySectionHeader">
        <p className="eyebrow">builder feedback · public receipts</p>
        <h2>External Float usage is live; M1 feedback is tied to public receipts.</h2>
      </div>

      <div className="treasuryValidationGrid">
        <article className="treasuryValidationCard treasuryValidationCardPrimary">
          <span>external Float usage</span>
          <strong>V2 signed intents live</strong>
          <p>
            External agents can authorize a bounded Float spend without pre funding the provider payment first. The contract
            verifies the signature and pays the provider from sponsor reserve.
          </p>
          <Link to="/float">Open Float →</Link>
        </article>

        <article className="treasuryValidationCard treasuryValidationCardValidated">
          <span>technical review</span>
          <strong>Builders gave technical feedback on the transaction path</strong>
          <p>
            CitePay said the model fits agent payment workflows. Forum checked the live Arc transactions and noted the
            same vault adapter entrypoint moved USDC when allowed, then moved zero USDC when over limit.
          </p>
          <a href="/api/treasury" target="_blank" rel="noreferrer">
            Open verifier output →
          </a>
        </article>

        <article className="treasuryValidationCard">
          <span>current usage</span>
          <strong>External agents are signing V2 intents</strong>
          <p>
            Forum, CitePay, Obol, Crux, and Argus-style agents are the relevant surface now: bounded intents, provider
            payment, debt, repayment, and overrun blocks on V2.
          </p>
          <Link to="/float">Open Float →</Link>
        </article>
      </div>

      <div className="treasuryValidationList" aria-label="External feedback entries">
        {validationRows.map((row) => (
          <article key={row.label}>
            <span>{row.label}</span>
            <strong>{row.status}</strong>
            <p>{row.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TreasuryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`treasuryMetric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function FloatPanel({
  state,
  loading,
  error,
  compact = false,
}: {
  state: FloatState | null;
  loading: boolean;
  error: string | null;
  compact?: boolean;
}) {
  const configured = Boolean(state?.configured);
  const alpha = state?.alphaLine;
  const beta = state?.betaLine;
  const receipts = state?.receipts || [];
  const pointers = state?.proofPointers;
  const agentLoop = state?.sourceBreakdown?.agentLoop;
  const externalSigned = state?.sourceBreakdown?.externalSigned;
  const standingBoard = state?.standingBoard;
  const runs = state?.loopRuns || [];
  const latestPaidRun = runs.find((run) => run.x402Hash || run.bindTxHash || run.txHash);
  const latestGuardRun = runs.find(
    (run) => run.outcome?.includes("BLOCK") || run.outcome?.includes("DENIED") || run.action === "PREMIUM",
  );
  const latestExternalRun = runs.find((run) => run.source === "external-signed" && run.requestHash);
  const latestPaidReceipt =
    pointers?.x402BoundReceipt || receipts.find((receipt) => receipt.x402) || receipts.find((receipt) => receipt.receiptType === "SPEND_ALLOWED");
  const latestGuardReceipt = receipts.find(
    (receipt) => receipt.receiptType.includes("BLOCK") || receipt.receiptType.includes("DENIED"),
  ) || pointers?.overspendReceipt || pointers?.denialReceipt;
  const updated =
    state?.fetchedAt && configured
      ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  const floatSteps = [
    {
      label: "1",
      title: "Reserve",
      detail: "A sponsor locks Arc USDC capacity for an agent line.",
    },
    {
      label: "2",
      title: "Sign",
      detail: "The agent signs provider, endpoint, amount, max debt, nonce, expiry, and executor.",
    },
    {
      label: "3",
      title: "Pay",
      detail: "The contract verifies the intent, pays the provider from reserve, and opens debt.",
    },
    {
      label: "4",
      title: "Block",
      detail: "Oversized or risky spends are refused before treasury USDC moves.",
    },
  ];
  const historicalX402Hash = latestPaidRun?.x402Hash || latestPaidReceipt?.x402?.x402Hash;
  const bindProofHash = latestPaidRun?.bindTxHash || latestPaidReceipt?.x402?.bindingTxHash || latestPaidReceipt?.transactionHash;
  const guardProofHash = latestGuardRun?.txHash || latestGuardReceipt?.transactionHash;
  const syncPending = loading && !configured;

  return (
    <section className={`floatPanel floatPanelV2${compact ? " floatPanelCompact" : ""}`} id="shadow-float">
      <div className="floatHeroShell">
        <div className="floatHeroCopy">
          <p className="eyebrow">Shadow Float V2 · current contract live</p>
          {compact ? (
            <h2>Signed agents draw reserved USDC, then repay the debt.</h2>
          ) : (
            <h1>Signed agents draw reserved USDC, then repay the debt.</h1>
          )}
          <p className="floatLede">
            Shadow Float V2 gives autonomous agents sponsor-backed Arc USDC capacity without pre funding every wallet. The
            agent signs one bounded intent; the contract verifies it onchain, pays the named provider from reserve, opens
            debt, restores capacity on repayment, and blocks overreach before funds move.
          </p>
          <div className="floatHeroActions">
            <a className="floatPrimaryAction" href={txUrl(FLOAT_V2_PROOF.directSpendTx)} target="_blank" rel="noreferrer">
              Open V2 spend tx
            </a>
            <a className="floatSecondaryAction" href="#float-loop">
              Watch autonomous loop
            </a>
          </div>
        </div>
        <aside className="floatProofCard" aria-label="Shadow Float live state">
          <div className="floatProofCardHeader">
            <span>live state</span>
            <strong>{configured ? `${state?.receiptCount || "0"} receipts` : "syncing"}</strong>
          </div>
          <div className="floatProofCardMoment">
            <span>V2 intent</span>
            <strong>provider paid</strong>
            <small>{shortAddress(FLOAT_V2_PROOF.directSpendTx)}</small>
          </div>
          <div className="floatProofCardMoment blocked">
            <span>overreach</span>
            <strong>blocked first</strong>
            <small>{guardProofHash ? shortAddress(guardProofHash) : "no treasury spend"}</small>
          </div>
          <div className="floatProofCardFooter">
            <span>{configured ? `treasury ${formatFloatUSDC(state?.treasuryBalanceUSDC)} USDC` : "treasury syncing"}</span>
            <span>chain 5042002</span>
          </div>
        </aside>
      </div>

      <div className="floatStatusRow">
        <div className={`floatStatus ${configured ? "configured" : "pending"}`}>
          <span className="floatStatusDot" />
          {configured ? "live historical reads" : syncPending ? "syncing live receipts" : "configuration pending"}
          {loading && <small>syncing</small>}
          {updated && <small>updated {updated}</small>}
        </div>
        <span>real Arc USDC</span>
        <span>V2 signed intent enforced onchain</span>
        <span>sponsor reserve pays the named provider</span>
      </div>

      {!compact && <FloatWalletProof state={state} loading={loading} />}
      {!compact && <FloatProofRunway state={state} />}

      <div className="floatHeadlineStats">
        <FloatHeadlineStat
          label="external signed spends"
          value={`${externalSigned?.cycles || 0}`}
          detail={`${formatFloatUSDC(externalSigned?.providerPaidUSDC)} provider paid`}
          tone="allow"
        />
        <FloatHeadlineStat
          label="external lifecycles closed"
          value={`${externalSigned?.lifecycleClosedCount || 0}`}
          detail={`${formatFloatUSDC(externalSigned?.repaidUSDC)} repaid`}
          tone="allow"
        />
        <FloatHeadlineStat
          label="operator loop cycles"
          value={`${agentLoop?.cycles || 0}`}
          detail={`${agentLoop?.paidCount || 0} paid · ${agentLoop?.skipCount || 0} skipped`}
        />
        <FloatHeadlineStat
          label="historical loop settled"
          value={formatFloatUSDC(agentLoop?.providerPaidUSDC)}
          detail="separate from external signed usage"
          tone="allow"
        />
        <FloatHeadlineStat
          label="blocked before spend"
          value={formatFloatUSDC(state?.totalBlockedUSDC)}
          detail="total refused before funds moved"
          tone="block"
        />
        <FloatHeadlineStat
          label="risky denied"
          value={formatFloatUSDC(state?.totalDeniedUSDC)}
          detail="no spendable line opened"
          tone="block"
        />
      </div>

      <FloatStandingBoardPanel board={standingBoard} alpha={state?.alpha} beta={state?.beta} compact={compact} />
      {!compact && <FloatExternalSignedPanel state={state} />}
      {!compact && <FloatCreditFlywheelPanel board={standingBoard} />}

      {!compact && (
        <div className="floatProofRail" aria-label="Shadow Float product flow">
          {floatSteps.map((step) => (
            <div className="floatProofStep" key={step.title}>
              <span>{step.label}</span>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </div>
          ))}
        </div>
      )}

      <div className="floatHeroGrid">
        <article className="floatAgentCard primary">
          <div className="floatCardHeader">
            <span>Agent Alpha</span>
            <code>{state?.alpha ? shortAddress(state.alpha) : "pending"}</code>
          </div>
          <h3>{alpha?.status || "ELIGIBLE"}</h3>
          <div className="floatLineStats">
            <FloatFact label="line limit" value={formatFloatUSDC(alpha?.creditLimitUSDC)} />
            <FloatFact label="available" value={formatFloatUSDC(alpha?.availableCreditUSDC)} />
            <FloatFact label="active debt" value={formatFloatUSDC(alpha?.activeDebtUSDC)} />
            <FloatFact label="score" value={alpha ? alpha.score.toString() : "9300"} />
          </div>
          <p>
            The historical Alpha line shows the original receipt depth: approved provider payment, debt, repayment, and
            overrun refusal. V2 moves the signed authorization checks into the contract.
          </p>
        </article>

        <article className="floatAgentCard blocked">
          <div className="floatCardHeader">
            <span>Agent Beta</span>
            <code>{state?.beta ? shortAddress(state.beta) : "pending"}</code>
          </div>
          <h3>{beta?.status || "DENIED"}</h3>
          <div className="floatLineStats">
            <FloatFact label="line limit" value={formatFloatUSDC(beta?.creditLimitUSDC)} />
            <FloatFact label="available" value={formatFloatUSDC(beta?.availableCreditUSDC)} />
            <FloatFact label="active debt" value={formatFloatUSDC(beta?.activeDebtUSDC)} />
            <FloatFact label="score" value={beta ? beta.score.toString() : "2100"} />
          </div>
          <p>Beta has block/slash-style history and cannot turn reputation into spendable USDC.</p>
        </article>
      </div>

      <div className="floatMetricGrid">
        <FloatMetric label="receipts" value={state?.receiptCount || "pending"} />
        <FloatMetric label="treasury" value={formatFloatUSDC(state?.treasuryBalanceUSDC)} />
        <FloatMetric label="provider paid" value={formatFloatUSDC(state?.totalProviderPaidUSDC)} tone="allow" />
        <FloatMetric label="debt + fee" value={formatFloatUSDC(state?.totalDebtOpenedUSDC)} tone="allow" />
        <FloatMetric label="fees accrued" value={formatFloatUSDC(state?.totalFeesAccruedUSDC)} tone="allow" />
        <FloatMetric label="repaid" value={formatFloatUSDC(state?.totalRepaidUSDC)} tone="allow" />
        <FloatMetric label="blocked" value={formatFloatUSDC(state?.totalBlockedUSDC)} tone="block" />
        <FloatMetric label="denied" value={formatFloatUSDC(state?.totalDeniedUSDC)} tone="block" />
        <FloatMetric label="defaulted" value={formatFloatUSDC(state?.totalDefaultedUSDC)} tone="block" />
        <FloatMetric
          label="receipt chain"
          value={
            state?.lastChecksum &&
            state.lastChecksum !== "0x0000000000000000000000000000000000000000000000000000000000000000"
              ? "valid"
              : "pending"
          }
        />
      </div>

      {!compact && <FloatProofChecksPanel state={state} />}

      <FloatLoopPanel state={state} compact={compact} />

      <div className="floatGrid">
        <article className="floatBox">
          <div className="floatBoxHeader">
            <span>approved provider endpoint</span>
            <small>{state?.provider ? shortAddress(state.provider) : "waiting"}</small>
          </div>
          <div className="floatProviderFacts">
            <FloatFact label="endpoint hash" value={shortHash(state?.providerMandate?.endpointHash)} />
            <FloatFact label="max/request" value={formatFloatUSDC(state?.providerMandate?.maxPerRequestUSDC)} />
            <FloatFact label="daily cap" value={formatFloatUSDC(state?.providerMandate?.dailyLimitUSDC)} />
            <FloatFact label="active" value={state?.providerMandate?.active ? "yes" : "pending"} />
          </div>
        </article>

        <article className="floatBox">
          <div className="floatBoxHeader">
            <span>onchain links</span>
            <small>deterministic policy</small>
          </div>
          <div className="floatProofLinks">
            {historicalX402Hash && (
              <a href={txUrl(historicalX402Hash as `0x${string}`)} target="_blank" rel="noreferrer">
                historical x402 settlement <strong>{shortAddress(historicalX402Hash)}</strong>
              </a>
            )}
            {bindProofHash && (
              <a href={txUrl(bindProofHash as `0x${string}`)} target="_blank" rel="noreferrer">
                historical Float bind <strong>{shortAddress(bindProofHash)}</strong>
              </a>
            )}
            {guardProofHash && (
              <a href={txUrl(guardProofHash as `0x${string}`)} target="_blank" rel="noreferrer">
                block tx <strong>{shortAddress(guardProofHash)}</strong>
              </a>
            )}
            {latestExternalRun?.requestHash && (
              <a href={`/api/float-tools?action=verify&hash=${latestExternalRun.requestHash}`} target="_blank" rel="noreferrer">
                signed external check <strong>{shortHash(latestExternalRun.requestHash)}</strong>
              </a>
            )}
            {state?.float && (
              <a href={`https://testnet.arcscan.app/address/${state.float}`} target="_blank" rel="noreferrer">
                ShadowFloat <strong>{shortAddress(state.float)}</strong>
              </a>
            )}
          </div>
        </article>
      </div>

      {!compact && (
        <article className="floatReceipts" id="float-receipts">
          <div className="floatBoxHeader">
            <span>latest Float receipts</span>
            <small>{receipts.length ? `${receipts.length} indexed` : "waiting for receipts"}</small>
          </div>
          <div className="floatReceiptList">
            {receipts.length ? (
              receipts.slice(0, 10).map((receipt) => (
                <div
                  className={`floatReceipt ${
                    receipt.receiptType.includes("BLOCK") || receipt.receiptType.includes("DENIED") ? "blocked" : "allowed"
                  }`}
                  key={`${receipt.receiptId}-${receipt.transactionHash}`}
                >
                  <a className="floatReceiptPrimary" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer">
                    <span>#{receipt.receiptId}</span>
                    <strong>{receipt.receiptType}</strong>
                    <code>{receipt.receiptType === "DEBT_OPENED" ? `${formatFloatUSDC(receipt.debtOpenedUSDC)} debt` : `${formatFloatUSDC(receipt.amountUSDC)} USDC`}</code>
                    <small>{receipt.reason}</small>
                  </a>
                  <div className="floatReceiptDetails">
                    <small>provider {formatFloatUSDC(receipt.providerAmountUSDC || receipt.amountUSDC)}</small>
                    <small>fee {formatFloatUSDC(receipt.feeUSDC)}</small>
                    <small>debt opened {formatFloatUSDC(receipt.debtOpenedUSDC)}</small>
                    <small>debt after {formatFloatUSDC(receipt.debtAfterUSDC)}</small>
                  </div>
                  {receipt.x402 && receipt.receiptType === "SPEND_ALLOWED" && (
                    <a className="floatX402Link" href={txUrl(receipt.x402.x402Hash)} target="_blank" rel="noreferrer">
                      paid via x402 · {shortAddress(receipt.x402.x402Hash)}
                    </a>
                  )}
                </div>
              ))
            ) : (
              <div className="floatEmpty">No Float receipts are indexed for this deployment yet.</div>
            )}
          </div>
        </article>
      )}

      {error && <div className="leptonError">Float read failed: {error}</div>}

      {!compact && (
        <FloatOnchainLinks state={state} />
      )}

      {!compact && (
        <div className="floatBoundaries">
          <span>testnet USDC line, not a lending market</span>
          <span>agent chooses the spend; Shadow enforces the mandate</span>
          <span>V2 provider payment is contract enforced</span>
          <span>external signed and onboarding-assisted activity stays labeled separately</span>
        </div>
      )}
    </section>
  );
}

function FloatV2CurrentPanel({
  state,
  loading,
  error,
  deskState,
  deskLoading,
  deskError,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
  error: string | null;
  deskState: FloatDeskState | null;
  deskLoading: boolean;
  deskError: string | null;
}) {
  const isSnapshot = state?.source === "verified-snapshot";
  const showCount = (value: number | undefined) => (value === undefined ? (loading ? "reading" : "unavailable") : String(value));
  const showUSDC = (value?: string | bigint | null) => (value === undefined || value === null ? (loading ? "reading" : "unavailable") : `${formatFloatUSDC(value)} USDC`);
  const statusText = isSnapshot ? (loading ? "syncing live V2" : "last verified V2") : error ? "V2 read needs review" : loading && !state ? "reading V2" : "V2 active";
  const statusTone = error && !isSnapshot ? "pending" : "configured";
  const anchors = [
    { label: "V2 contract source", href: FLOAT_V2_PROOF.sourcify, value: shortAddress(FLOAT_V2_CONTRACT) },
    { label: "signed provider payment", href: txUrl(FLOAT_V2_PROOF.directSpendTx), value: shortAddress(FLOAT_V2_PROOF.directSpendTx) },
    { label: "overrun blocked", href: txUrl(FLOAT_V2_PROOF.blockedSpendTx), value: shortAddress(FLOAT_V2_PROOF.blockedSpendTx) },
    { label: "repayment restored line", href: txUrl(FLOAT_V2_PROOF.repayTx), value: shortAddress(FLOAT_V2_PROOF.repayTx) },
    { label: "Crux external lifecycle", href: txUrl(FLOAT_V2_PROOF.cruxRepayTx), value: shortAddress(FLOAT_V2_PROOF.cruxRepayTx) },
    { label: "Argus Alpha closed loop", href: txUrl(FLOAT_V2_PROOF.argusAlphaRepayTx), value: shortAddress(FLOAT_V2_PROOF.argusAlphaRepayTx) },
    { label: "Argus to CitePay loop", href: txUrl(FLOAT_V2_PROOF.argusCitePayRepayTx), value: shortAddress(FLOAT_V2_PROOF.argusCitePayRepayTx) },
    { label: "CitePay provider proof", href: txUrl(FLOAT_V2_PROOF.citePayProviderQueryTxs[0]), value: "5 paid queries" },
    { label: "CitePay sponsor line", href: txUrl(FLOAT_V2_PROOF.citePaySponsorOpenTx), value: shortAddress(FLOAT_V2_PROOF.citePaySponsorOpenTx) },
    { label: "Forum reserve reclaim", href: txUrl(FLOAT_V2_PROOF.forumSponsorCloseTx), value: shortAddress(FLOAT_V2_PROOF.forumSponsorCloseTx) },
    { label: "Obol signed spend", href: txUrl(FLOAT_V2_PROOF.obolSpendTx), value: shortAddress(FLOAT_V2_PROOF.obolSpendTx) },
  ];

  return (
    <section className="floatPanel floatPanelV2" id="shadow-float" aria-label="Shadow Float V2 current product">
      <div className="floatHeroShell">
        <div className="floatHeroCopy">
          <p className="eyebrow">Shadow Float V2 · live on Arc</p>
          <h1>Let agents pay providers without pre funding every wallet.</h1>
          <p className="floatLede">
            Shadow Float lets a sponsor reserve Arc USDC for an agent. The agent signs a bounded spend intent, the contract
            pays the named provider from that reserve, and the line is restored when the agent repays.
          </p>
          <div className="floatHeroActions">
            <a className="floatPrimaryAction" href="#v2-activity">
              View activity
            </a>
            <Link className="floatSecondaryAction" to="/builders">
              Add an agent
            </Link>
          </div>
        </div>
        <aside className="floatProofCard" aria-label="Shadow Float V2 live state">
          <div className="floatProofCardHeader">
            <span>current line behavior</span>
            <strong>contract enforced</strong>
          </div>
          <div className="floatProofCardMoment">
            <span>approved request</span>
            <strong>provider paid</strong>
            <small>from sponsor reserve</small>
          </div>
          <div className="floatProofCardMoment blocked">
            <span>oversized request</span>
            <strong>blocked first</strong>
            <small>no provider transfer</small>
          </div>
          <div className="floatProofCardFooter">
            <span>chain 5042002</span>
            <span>Arc USDC</span>
          </div>
        </aside>
      </div>

      <div className="floatStatusRow">
        <div className={`floatStatus ${statusTone}`}>
          <span className="floatStatusDot" />
          {statusText}
        </div>
        <span>sponsor reserve pays providers</span>
        <span>nonce and max debt checked onchain</span>
        <span>external agent lines active</span>
      </div>

      <div className="floatMetricGrid">
        <FloatMetric label="external lines" value={showCount(state?.summary?.registeredExternalLines)} tone="allow" />
        <FloatMetric label="signed intents" value={showCount(state?.summary?.signedIntents)} tone="allow" />
        <FloatMetric label="provider paid" value={showUSDC(state?.summary?.providerPaidUSDC)} tone="allow" />
        <FloatMetric label="closed loops" value={showCount(state?.summary?.repaidLifecycles)} tone="allow" />
        <FloatMetric label="open debt" value={showUSDC(state?.summary?.activeDebtUSDC)} tone={state?.summary?.openDebtAgents ? "block" : "allow"} />
      </div>

      <FloatDeskLabLineCard state={deskState} loading={deskLoading} error={deskError} />
      <FloatDeskJournal state={deskState} loading={deskLoading} error={deskError} />
      <FloatV2ActivityBoard state={state} loading={loading} error={error} />
      <FloatV2WorkflowPanel />
      <FloatV2UseCasePanel />
      <FloatV2VerificationFooter anchors={anchors} />
    </section>
  );
}

function FloatV2UseCasePanel() {
  const items = [
    {
      title: "For buyer agents",
      body: "Call paid APIs or data providers before every agent wallet has to be manually topped up.",
    },
    {
      title: "For sponsors",
      body: "Set bounded capacity per agent, keep reserves capped, and let repayment restore the line.",
    },
    {
      title: "For providers",
      body: "Receive Arc USDC directly from contract custody when the signed request is inside policy.",
    },
  ];

  return (
    <section className="floatV2UseCase" aria-label="Shadow Float V2 users">
      <div>
        <span>why Float exists</span>
        <strong>Autonomous agents need paid services, but pre funding every wallet is hard to manage at scale.</strong>
      </div>
      <div className="floatV2UseCaseGrid">
        {items.map((item) => (
          <article key={item.title}>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function FloatV2WorkflowPanel() {
  const steps = [
    {
      label: "Sponsor",
      title: "Reserve capacity",
      body: "A sponsor backs a specific agent line with Arc USDC. The contract will not promise more spendable capacity than the reserve can support.",
    },
    {
      label: "Agent",
      title: "Sign bounded spend",
      body: "The agent signs provider, endpoint, amount, max debt, nonce, expiry, and executor. The key stays with the builder.",
    },
    {
      label: "Provider",
      title: "Get paid directly",
      body: "If the signed intent is valid and inside the line policy, Float pays the named provider from contract custody.",
    },
    {
      label: "Line",
      title: "Repay or block",
      body: "Repayment restores capacity. Oversized attempts are recorded and refused before provider funds move.",
    },
  ];

  return (
    <section className="floatV2Workflow" aria-label="Shadow Float V2 workflow">
      <div className="floatBoxHeader">
        <span>how it works</span>
        <small>sponsor backed capacity</small>
      </div>
      <div className="floatV2WorkflowGrid">
        {steps.map((step, index) => (
          <article key={step.label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function FloatV2VerificationFooter({
  anchors,
}: {
  anchors: Array<{ label: string; href: string; value: string }>;
}) {
  return (
    <section className="floatV2VerificationFooter" aria-label="Shadow Float V2 verification links">
      <div>
        <span>inspectable records</span>
        <p>Source match, transaction anchors, and the local check command are available for builders who want to inspect the line.</p>
      </div>
      <div className="floatV2VerificationLinks">
        {anchors.map((anchor) => (
          <a href={anchor.href} target="_blank" rel="noreferrer" key={anchor.label}>
            {anchor.label} <strong>{anchor.value}</strong>
          </a>
        ))}
        <a href="https://github.com/dolepee/shadow" target="_blank" rel="noreferrer">
          strict check <strong>float:v2-verify-live</strong>
        </a>
      </div>
    </section>
  );
}

function classifyFloatV2Lifecycle(agent: FloatV2AgentState): {
  label: string;
  detail: string;
  tone: "closed" | "open" | "signed" | "registered" | "blocked";
} {
  const activeDebt = asAtomicUSDC(agent.activeDebtUSDC);
  if (agent.repaidCount > 0 && activeDebt === 0n) {
    if (agent.sponsorState === "closed-reserve-reclaimed" || (asAtomicUSDC(agent.sponsorReserveUSDC) === 0n && asAtomicUSDC(agent.creditLimitUSDC) === 0n)) {
      return { label: "closed", detail: "paid, repaid, reserve reclaimed", tone: "closed" };
    }
    return { label: "closed", detail: "signed, paid, repaid", tone: "closed" };
  }
  if (activeDebt > 0n) {
    return {
      label: "open debt",
      detail: agent.providerPaidCount > 0 ? "provider paid, repayment pending" : "debt open, payment log syncing",
      tone: "open",
    };
  }
  if (agent.blockedCount > 0 && agent.providerPaidCount === 0) {
    return { label: "blocked", detail: "overrun refused", tone: "blocked" };
  }
  if (agent.signedIntents > 0) {
    return { label: "signed", detail: "waiting for provider payment", tone: "signed" };
  }
  return { label: "registered", detail: "line ready", tone: "registered" };
}

function describeFloatV2Behavior(agent: FloatV2AgentState): string {
  const behavior = agent.behavior;
  if (!behavior) {
    if (agent.providerPaidCount > 0 || agent.repaidCount > 0) return `paid ${agent.providerPaidCount} · repaid ${agent.repaidCount}`;
    return "behavior syncing";
  }
  const behaviorPaid = behavior.signedExternalPaid + behavior.paidBound;
  const paid = behaviorPaid > 0 ? behaviorPaid : agent.providerPaidCount;
  const repaid = behavior.repaid > 0 ? behavior.repaid : agent.repaidCount;
  const parts = [`paid ${paid}`, `repaid ${repaid}`];
  if (behavior.blocked > 0) parts.push(`blocked ${behavior.blocked}`);
  if (behavior.denied > 0) parts.push(`denied ${behavior.denied}`);
  if (behavior.errorCount > 0) parts.push(`errors ${behavior.errorCount}`);
  return parts.join(" · ");
}

function formatFloatV2Review(agent: FloatV2AgentState): string {
  if (!agent.lastReviewISO) return "review syncing";
  const date = new Date(agent.lastReviewISO);
  if (Number.isNaN(date.getTime())) return "review syncing";
  return `reviewed ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function FloatV2ActivityBoard({
  state,
  loading,
  error,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
  error: string | null;
}) {
  const agents = state?.agents || [];
  const isSnapshot = state?.source === "verified-snapshot";
  const checkedAt = state?.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const statusLabel = isSnapshot ? (loading ? "syncing live V2" : "last verified snapshot") : error ? "V2 read needs review" : loading && !state ? "reading V2 activity" : "live V2 activity";
  const closed = state?.summary?.repaidLifecycles ?? 0;
  const openDebt = state?.summary?.openDebtAgents ?? 0;
  const topScore = agents.reduce((max, agent) => Math.max(max, agent.autonomousScore?.score ?? agent.score ?? 0), 0);
  const showCount = (value: number | undefined) => (value === undefined ? (loading ? "reading" : "unavailable") : String(value));
  const showUSDC = (value?: string | bigint | null) => (value === undefined || value === null ? (loading ? "reading" : "unavailable") : `${formatFloatUSDC(value)} USDC`);

  return (
    <section className="floatV2ActivityBoard" id="v2-activity" aria-label="Shadow Float V2 external activity">
      <div className="floatBoxHeader">
        <span>external agent board</span>
        <small>{checkedAt ? `${isSnapshot ? "snapshot" : "updated"} ${checkedAt}` : statusLabel}</small>
      </div>
      <div className="floatV2ActivityIntro">
        <div>
          <strong>{closed} closed V2 lifecycle{closed === 1 ? "" : "s"} · {openDebt} open debt line{openDebt === 1 ? "" : "s"}</strong>
          <p>
            Closed means the agent signed a V2 intent, ShadowFloat paid the provider from sponsor reserve, and the same line
            was repaid. Open debt means the provider payment is already bound and the agent has not repaid yet.
            Sponsored lines are scored by the contract from behavior stats after paid, blocked, and repaid actions.
            {isSnapshot ? " Showing the last verified snapshot while the live feed syncs." : ""}
          </p>
        </div>
        <a href="/api/float?mode=v2" target="_blank" rel="noreferrer">
          Live API
        </a>
      </div>
      <div className="floatV2BoardGuide" aria-label="How to read the external agent board">
        <div>
          <span>closed</span>
          <strong>signed, paid, repaid</strong>
          <p>The provider was paid from reserve, then the agent restored the line.</p>
        </div>
        <div>
          <span>open debt</span>
          <strong>provider paid, repay pending</strong>
          <p>The service payment happened already. The agent still has debt on its line.</p>
        </div>
        <div>
          <span>blocked</span>
          <strong>no provider transfer</strong>
          <p>Oversized or denied requests are refused before any reserve moves.</p>
        </div>
      </div>

      <div className="floatV2ActivityStats">
        <FloatFact label="registered lines" value={showCount(state?.summary?.registeredExternalLines)} />
        <FloatFact label="signed intents" value={showCount(state?.summary?.signedIntents)} />
        <FloatFact label="provider paid" value={showUSDC(state?.summary?.providerPaidUSDC)} />
        <FloatFact label="closed loops" value={showCount(state?.summary?.repaidLifecycles)} />
        <FloatFact label="open debt" value={showUSDC(state?.summary?.activeDebtUSDC)} />
        <FloatFact label="top contract score" value={topScore > 0 ? String(topScore) : loading ? "reading" : "unavailable"} />
      </div>

      {error && !isSnapshot ? (
        <div className="floatV2ActivityEmpty">
          <strong>V2 activity read failed</strong>
          <span>{error}</span>
        </div>
      ) : agents.length ? (
        <div className="floatV2ActivityRows">
          {agents.map((agent) => {
            const href = agent.latestTxHash || agent.repayTx || agent.spendTx;
            const lifecycle = classifyFloatV2Lifecycle(agent);
            const reserveReclaimed = lifecycle.detail.includes("reserve reclaimed");
            const row = (
              <>
                <div className="floatV2ActivityIdentity">
                  <strong>{agent.label}</strong>
                  <small>{shortAddress(agent.agent)}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>lifecycle</span>
                  <strong>{lifecycle.label}</strong>
                  <small>{lifecycle.detail}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>contract score</span>
                  <strong>{agent.autonomousScore?.score ?? agent.score}</strong>
                  <small>{formatFloatV2Review(agent)}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>behavior vector</span>
                  <strong>{describeFloatV2Behavior(agent)}</strong>
                  <small>scored by ShadowFloat</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>line</span>
                  <strong>{reserveReclaimed ? "closed" : formatFloatUSDC(agent.creditLimitUSDC)}</strong>
                  <small>{reserveReclaimed ? "reserve reclaimed" : `cap ${formatFloatUSDC(agent.autonomousScore?.cappedLimitUSDC || agent.creditLimitUSDC)}`}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>debt</span>
                  <strong>{formatFloatUSDC(agent.activeDebtUSDC)}</strong>
                  <small>{formatFloatUSDC(agent.providerPaidUSDC)} paid</small>
                </div>
              </>
            );
            return href ? (
              <a className={`floatV2ActivityRow ${lifecycle.tone}`} href={txUrl(href)} target="_blank" rel="noreferrer" key={agent.agent}>
                {row}
              </a>
            ) : (
              <div className={`floatV2ActivityRow ${lifecycle.tone}`} key={agent.agent}>
                {row}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="floatV2ActivityEmpty">
          <strong>{loading ? "Reading V2 lines" : "No V2 external lines yet"}</strong>
          <span>Rows appear after registered external agents sign or repay on Float V2.</span>
        </div>
      )}
    </section>
  );
}

function FloatDeskLabLineCard({
  state,
  loading,
  error,
}: {
  state: FloatDeskState | null;
  loading: boolean;
  error: string | null;
}) {
  const labLine = state?.labLine || null;
  const latest = state?.entries?.[0];
  const latestSpend = latest?.txs?.spend;
  const latestSettle = latest?.txs?.settle;
  const status = error
    ? "desk line read needs review"
    : loading && !labLine
      ? "reading desk line"
      : labLine
        ? `${labLine.statusName || "UNKNOWN"} · scored by contract`
        : "desk line pending";

  return (
    <section className="floatDeskLineCard" aria-label="Float Desk system line">
      <div className="floatBoxHeader">
        <span>Float Desk system line</span>
        <small>{status}</small>
      </div>
      <div className="floatDeskLineBody">
        <div className="floatDeskLineLead">
          <span>autonomous desk</span>
          <strong>{labLine?.agent ? shortAddress(labLine.agent) : "desk agent"}</strong>
          <p>
            The Desk line is separated from external builder traction. It earns capacity from the same contract-scored
            behavior path used by sponsored external lines.
          </p>
        </div>
        <div className="floatDeskLineStats">
          <FloatFact label="score" value={labLine?.score !== undefined ? String(labLine.score) : loading ? "reading" : "pending"} />
          <FloatFact label="limit" value={labLine?.creditLimitUSDC ? `${formatFloatUSDC(labLine.creditLimitUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="available" value={labLine?.availableCreditUSDC ? `${formatFloatUSDC(labLine.availableCreditUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="debt" value={labLine?.activeDebtUSDC ? `${formatFloatUSDC(labLine.activeDebtUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="reserve" value={labLine?.sponsorReserveUSDC ? `${formatFloatUSDC(labLine.sponsorReserveUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="settled cycles" value={state?.counts ? String((state.counts.settles || 0) + state.counts.repays) : loading ? "reading" : "0"} />
        </div>
        <div className="floatDeskLineProofs">
          {latestSpend?.requestHash && (
            <a href={latestSpend.txHash ? txUrl(latestSpend.txHash) : "/api/desk"} target="_blank" rel="noreferrer">
              rationale digest {shortHash(latestSpend.requestHash)}
            </a>
          )}
          {latestSpend?.txHash && (
            <a href={txUrl(latestSpend.txHash)} target="_blank" rel="noreferrer">
              latest spend {shortAddress(latestSpend.txHash)}
            </a>
          )}
          {latestSettle?.txHash && (
            <a href={txUrl(latestSettle.txHash)} target="_blank" rel="noreferrer">
              latest settle {shortAddress(latestSettle.txHash)}
            </a>
          )}
          <a href="/api/desk" target="_blank" rel="noreferrer">
            Desk API
          </a>
        </div>
      </div>
    </section>
  );
}

function FloatDeskJournal({
  state,
  loading,
  error,
}: {
  state: FloatDeskState | null;
  loading: boolean;
  error: string | null;
}) {
  const entries = state?.entries || [];
  const latest = entries[0];
  const counts = state?.counts;
  const status = error ? "desk read needs review" : loading && !state ? "reading desk" : entries.length ? "live journal" : "waiting for first cycle";

  return (
    <section className="floatDeskJournal" id="desk-journal" aria-label="Shadow Float Desk journal">
      <div className="floatBoxHeader">
        <span>Float Desk journal</span>
        <small>{status}</small>
      </div>
      <div className="floatDeskIntro">
        <div>
          <strong>Autonomous desk decisions, constrained by contract policy.</strong>
          <p>
            The desk reads the live Float book, proposes pay, skip, hold, or repay actions, and the contract policy decides
            what can execute. Desk activity is separated from external builder traction.
          </p>
        </div>
        <a href="/api/desk" target="_blank" rel="noreferrer">
          Desk API
        </a>
      </div>
      <div className="floatDeskGateway">
        <div>
          <span>Circle Gateway settlement</span>
          <strong>{FLOAT_DESK_GATEWAY_PROOF.totalUSDC} USDC batched over {FLOAT_DESK_GATEWAY_PROOF.rows} Desk cycles</strong>
          <p>
            Gateway settled recorded Desk amounts after provider payments landed. This shows settlement plumbing for small
            Desk amounts, separate from V2 provider payment and external traction.
          </p>
        </div>
        <div className="floatDeskGatewayProofs">
          {FLOAT_DESK_GATEWAY_PROOF.batches.map((batch) => (
            <span key={batch}>batch {shortHash(batch)}</span>
          ))}
          <a href="/api/settlements" target="_blank" rel="noreferrer">
            Settlement API
          </a>
        </div>
      </div>
      <div className="floatDeskStats">
        <FloatFact label="cycles" value={counts ? String(counts.cycles) : loading ? "reading" : "0"} />
        <FloatFact label="pays" value={counts ? String(counts.pays) : "0"} />
        <FloatFact label="settles" value={counts ? String((counts.settles || 0) + counts.repays) : "0"} />
        <FloatFact label="skips" value={counts ? String(counts.skips + counts.holds) : "0"} />
        <FloatFact label="policy clamps" value={counts ? String(counts.clamps) : "0"} />
        <FloatFact label="latest" value={latest?.ts ? formatDeskTime(latest.ts) : loading ? "reading" : "pending"} />
      </div>
      {error ? (
        <div className="floatDeskEmpty">
          <strong>Desk journal read failed</strong>
          <span>{error}</span>
        </div>
      ) : entries.length ? (
        <div className="floatDeskRows">
          {entries.slice(0, 6).map((entry, index) => (
            <FloatDeskRow entry={entry} key={`${entry.cycle || index}-${entry.ts || "desk"}`} />
          ))}
        </div>
      ) : (
        <div className="floatDeskEmpty">
          <strong>{loading ? "Reading desk journal" : "Desk cycles have not been published yet"}</strong>
          <span>Scheduled cycles will appear here after the workflow writes to the public journal.</span>
        </div>
      )}
    </section>
  );
}

function FloatDeskRow({ entry }: { entry: FloatDeskEntry }) {
  const action = entry.decision?.action || "HOLD";
  const spend = entry.txs?.spend;
  const repay = entry.txs?.repay;
  const settle = entry.txs?.settle;
  const txHash = spend?.txHash || repay?.txHash || settle?.txHash;
  const amount = spend?.amountUSDC || repay?.amountUSDC || settle?.amountUSDC || entry.decision?.amountAtomic || "0";
  const reviewed = entry.reviews?.filter((review) => review.txHash).length || 0;
  const clamped = entry.decision?.wasClamped;

  return (
    <article className={`floatDeskRow ${String(action).toLowerCase()}${entry.ok === false ? " error" : ""}`}>
      <div className="floatDeskAction">
        <span>{formatDeskTime(entry.ts)}</span>
        <strong>{action}</strong>
        <small>{entry.decision?.provider || "policy"} · {formatFloatUSDC(amount)} USDC</small>
      </div>
      <div className="floatDeskReason">
        <strong>{entry.decision?.rationale || entry.bookNote || "Desk cycle recorded."}</strong>
        <small>
          {entry.assessment ||
            (clamped ? `policy clamped: ${entry.decision?.clampReasons?.join(", ") || "yes"}` : entry.bookNote || "chain policy unchanged")}
        </small>
      </div>
      <div className="floatDeskProofs">
        {spend?.requestHash && (
          <a href={txHash ? txUrl(txHash) : "/api/desk"} target="_blank" rel="noreferrer">
            digest {shortHash(spend.requestHash)}
          </a>
        )}
        {txHash && (
          <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
            tx {shortAddress(txHash)}
          </a>
        )}
        {settle?.txHash && (
          <a href={txUrl(settle.txHash)} target="_blank" rel="noreferrer">
            settle {shortAddress(settle.txHash)}
          </a>
        )}
        {entry.txs?.ask?.queryId && <span>citepay {entry.txs.ask.queryId.slice(0, 8)}</span>}
        {reviewed > 0 && <span>reviewed {reviewed}</span>}
        {entry.error && <span>{entry.error}</span>}
      </div>
    </article>
  );
}

function FloatWalletProof({ state, loading }: { state: FloatState | null; loading: boolean }) {
  const proof = state?.walletProof;
  const exactHistory = Boolean(proof?.historicalBeforeBalanceAvailable);
  const pending = loading && !proof;
  const showUSDC = (value?: string | bigint | null) => (pending ? "syncing" : formatFloatUSDC(value));
  return (
    <article className="floatWalletProof" aria-label="Agent wallet shortfall evidence">
      <div className="floatBoxHeader">
        <span>insufficient-wallet evidence</span>
        <small>{exactHistory ? "historical snapshot" : "current balance + receipts"}</small>
      </div>
      <div className="floatWalletProofCopy">
          <strong>The agent does not need to pre-fund the provider payment.</strong>
        <p>
          V2 pays the signed provider from sponsor-backed contract custody, then assigns debt to the agent&apos;s line.
          Historical pre-spend wallet balance is not stored by the V1 contract, so this board shows current wallet balance
          and live debt receipts instead of inventing a before snapshot.
        </p>
      </div>
      <div className="floatWalletProofGrid">
        <FloatFact label="agent wallet USDC" value={showUSDC(proof?.agentWalletUSDC)} />
        <FloatFact label="provider price" value={showUSDC(proof?.requiredX402AmountUSDC)} />
        <FloatFact label="current shortfall" value={showUSDC(proof?.walletShortfallUSDC)} />
        <FloatFact label="Float capacity" value={showUSDC(proof?.floatAvailableCapacityUSDC)} />
        <FloatFact label="facilitator paid" value={showUSDC(proof?.facilitatorPaidUSDC)} />
        <FloatFact label="debt assigned" value={showUSDC(proof?.debtAssignedUSDC)} />
      </div>
      <div className="floatWalletProofLinks">
        {proof?.x402Hash && (
          <a href={txUrl(proof.x402Hash)} target="_blank" rel="noreferrer">
            historical x402 settlement {shortAddress(proof.x402Hash)}
          </a>
        )}
        {proof?.bindTxHash && (
          <a href={txUrl(proof.bindTxHash)} target="_blank" rel="noreferrer">
            historical Float bind {shortAddress(proof.bindTxHash)}
          </a>
        )}
        <a href="/api/float?mode=v2" target="_blank" rel="noreferrer">
          live Float API
        </a>
      </div>
    </article>
  );
}

function FloatProofRunway({ state }: { state: FloatState | null }) {
  const receipts = state?.receipts || [];
  const pointers = state?.proofPointers;
  const latestExternalRun = (state?.loopRuns || []).find((run) => run.source === "external-signed" && run.requestHash);
  const x402Receipt = pointers?.x402BoundReceipt || receipts.find((receipt) => receipt.x402);
  const grantReceipt = pointers?.grantReceipt || receipts.find((receipt) => receipt.receiptType === "FLOAT_GRANTED");
  const providerPaidReceipt = pointers?.providerPaidReceipt || (x402Receipt?.requestHash
    ? receipts.find((receipt) => receipt.receiptType === "PROVIDER_PAID" && receipt.requestHash === x402Receipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "PROVIDER_PAID"));
  const debtReceipt = pointers?.debtReceipt || (x402Receipt?.requestHash
    ? receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED" && receipt.requestHash === x402Receipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED"));
  const repayReceipt = pointers?.repaymentReceipt || receipts.find((receipt) => receipt.receiptType === "REPAID");
  const overspendReceipt = pointers?.overspendReceipt || receipts.find((receipt) => receipt.receiptType === "SPEND_BLOCKED" && receipt.reason === "AMOUNT_TOO_HIGH");
  const denialReceipt = pointers?.denialReceipt || receipts.find((receipt) => receipt.receiptType === "CREDIT_DENIED");
  const walletProof = state?.walletProof;
  const rows = [
    {
      title: "Agent wallet insufficient",
      status: walletProof ? "live" : "pending",
      amount: formatFloatUSDC(walletProof?.walletShortfallUSDC),
      receipt: "BALANCE_CHECK",
      href: "/api/float?mode=v2",
      meaning: "Current wallet balance is shown separately from Float capacity; no fake historical balance is claimed.",
    },
    {
      title: "Behavior-backed line granted",
      status: grantReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(grantReceipt?.amountUSDC || state?.alphaLine?.creditLimitUSDC),
      receipt: "FLOAT_GRANTED",
      href: grantReceipt?.transactionHash ? txUrl(grantReceipt.transactionHash) : "/api/float?mode=v2",
      meaning: "The line exists onchain and can be checked against receipt-derived behavior evidence.",
    },
    {
      title: "Provider payment required",
      status: state?.providerMandate?.active ? "live" : "pending",
      amount: formatFloatUSDC(walletProof?.requiredX402AmountUSDC),
      receipt: "HTTP_402",
      href: "/api/reasoning-x402",
      meaning: "The provider endpoint requires USDC before returning the paid resource.",
    },
    {
      title: "Shadow pays provider",
      status: providerPaidReceipt || x402Receipt ? "proven" : "pending",
      amount: formatFloatUSDC(providerPaidReceipt?.amountUSDC || x402Receipt?.x402?.amountUSDC),
      receipt: "PROVIDER_PAID",
      href: x402Receipt?.x402?.x402Hash ? txUrl(x402Receipt.x402.x402Hash) : providerPaidReceipt?.transactionHash ? txUrl(providerPaidReceipt.transactionHash) : "/api/float?mode=v2",
      meaning: "V1 shows the facilitator fronting Arc USDC to the x402 provider. V2 pays directly from contract reserve.",
    },
    {
      title: "Historical x402 bind",
      status: x402Receipt?.x402 ? "proven" : "pending",
      amount: formatFloatUSDC(x402Receipt?.x402?.amountUSDC),
      receipt: "X402PaymentBound",
      href: x402Receipt?.x402?.bindingTxHash ? txUrl(x402Receipt.x402.bindingTxHash) : "/api/float?mode=v2",
      meaning: "The historical x402 settlement hash is bound to the Float request hash onchain.",
    },
    {
      title: "Debt opens",
      status: debtReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(debtReceipt?.debtOpenedUSDC),
      receipt: "DEBT_OPENED",
      href: debtReceipt?.transactionHash ? txUrl(debtReceipt.transactionHash) : "/api/float?mode=v2",
      meaning: "Debt includes provider amount plus the testnet fee, so accounting is explicit.",
    },
    {
      title: "Repayment restores capacity",
      status: repayReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(repayReceipt?.amountUSDC),
      receipt: "REPAID",
      href: repayReceipt?.transactionHash ? txUrl(repayReceipt.transactionHash) : "/api/float?mode=v2",
      meaning: "Repayment reduces debt and reopens available capacity.",
    },
    {
      title: "Overspend blocked",
      status: overspendReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(overspendReceipt?.amountUSDC),
      receipt: "SPEND_BLOCKED",
      href: overspendReceipt?.transactionHash ? txUrl(overspendReceipt.transactionHash) : "/api/float?mode=v2",
      meaning: "A request above the line is refused before provider or treasury funds move.",
    },
    {
      title: "Risky agent denied",
      status: denialReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(denialReceipt?.amountUSDC),
      receipt: "CREDIT_DENIED",
      href: denialReceipt?.transactionHash ? txUrl(denialReceipt.transactionHash) : "/api/float?mode=v2",
      meaning: "A denied line cannot turn into spendable USDC.",
    },
  ];

  return (
    <article className="floatRunway" aria-label="Float transaction runway">
      <div className="floatBoxHeader">
        <span>Float transaction runway</span>
        <small>the loop in 10 seconds</small>
      </div>
      <div className="floatRunwayRows">
        {rows.map((row, index) => (
          <a className={`floatRunwayRow ${row.status}`} href={row.href} target="_blank" rel="noreferrer" key={row.title}>
            <span className="floatRunwayIndex">{index + 1}</span>
            <span className="floatRunwayStatus">{row.status}</span>
            <span className="floatRunwayMain">
              <strong>{row.title}</strong>
              <small>{row.meaning}</small>
            </span>
            <code>{row.receipt}</code>
            <span className="floatRunwayAmount">{row.amount} USDC</span>
          </a>
        ))}
      </div>
      {latestExternalRun?.requestHash && (
        <a className="floatRunwayVerify" href={`/api/float-tools?action=verify&hash=${latestExternalRun.requestHash}`} target="_blank" rel="noreferrer">
          Check signed external intent {shortHash(latestExternalRun.requestHash)}
        </a>
      )}
    </article>
  );
}

function FloatProofChecksPanel({ state }: { state: FloatState | null }) {
  const checks = state?.proofChecks || {};
  const entries = Object.entries(checks).filter(([, value]) => typeof value === "boolean") as Array<[string, boolean]>;
  const trustBoundary = typeof checks.trustBoundary === "string" ? checks.trustBoundary : null;
  return (
    <article className="floatProofChecks" aria-label="Float API status checks">
      <div className="floatBoxHeader">
        <span>API status checks</span>
        <small>{entries.filter(([, ok]) => ok).length}/{entries.length || 0} passing</small>
      </div>
      <div className="floatProofCheckGrid">
        {entries.map(([key, ok]) => (
          <a className={`floatProofCheck ${ok ? "pass" : "pending"}`} href="/api/float?mode=v2" target="_blank" rel="noreferrer" key={key}>
            <span>{ok ? "PASS" : "PENDING"}</span>
            <strong>{humanizeFloatKey(key)}</strong>
          </a>
        ))}
      </div>
      {trustBoundary && <p>{trustBoundary}</p>}
    </article>
  );
}

function FloatOnchainLinks({ state }: { state: FloatState | null }) {
  const receipts = state?.receipts || [];
  const pointers = state?.proofPointers;
  const x402Receipt = pointers?.x402BoundReceipt || receipts.find((receipt) => receipt.x402);
  const debtReceipt = pointers?.debtReceipt || (x402Receipt?.requestHash
    ? receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED" && receipt.requestHash === x402Receipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED"));
  const repayReceipt = pointers?.repaymentReceipt || receipts.find((receipt) => receipt.receiptType === "REPAID");
  const overspendReceipt = pointers?.overspendReceipt || receipts.find((receipt) => receipt.receiptType === "SPEND_BLOCKED" && receipt.reason === "AMOUNT_TOO_HIGH");
  const denialReceipt = pointers?.denialReceipt || receipts.find((receipt) => receipt.receiptType === "CREDIT_DENIED");
  const latestExternalRun = (state?.loopRuns || []).find((run) => run.source === "external-signed" && run.requestHash);
  const links = [
    { label: "Open V2 activity API", href: "/api/float?mode=v2" },
    { label: "Check V2 reserve", href: "/api/float?mode=v2" },
    { label: "Check V2 direct spend", href: txUrl(FLOAT_V2_PROOF.directSpendTx) },
    { label: "Check V2 blocked overrun", href: txUrl(FLOAT_V2_PROOF.blockedSpendTx) },
    { label: "Check V2 repayment", href: txUrl(FLOAT_V2_PROOF.repayTx) },
    x402Receipt?.x402?.x402Hash ? { label: "Check historical x402 settlement", href: txUrl(x402Receipt.x402.x402Hash) } : null,
    x402Receipt?.x402?.bindingTxHash ? { label: "Check historical x402 bind", href: txUrl(x402Receipt.x402.bindingTxHash) } : null,
    debtReceipt?.transactionHash ? { label: "Check debt", href: txUrl(debtReceipt.transactionHash) } : null,
    repayReceipt?.transactionHash ? { label: "Check repayment", href: txUrl(repayReceipt.transactionHash) } : null,
    overspendReceipt?.transactionHash ? { label: "Check overspend block", href: txUrl(overspendReceipt.transactionHash) } : null,
    denialReceipt?.transactionHash ? { label: "Check denial", href: txUrl(denialReceipt.transactionHash) } : null,
    latestExternalRun?.requestHash ? { label: "Check signed external", href: `/api/float-tools?action=verify&hash=${latestExternalRun.requestHash}` } : null,
  ].filter((link): link is { label: string; href: string } => Boolean(link));
  return (
    <article className="floatJudgePath" aria-label="Shadow Float onchain references">
      <div className="floatBoxHeader">
        <span>onchain references</span>
        <small>transactions plus command</small>
      </div>
      <div className="floatJudgeLinks">
        {links.map((link) => (
          <a href={link.href} target="_blank" rel="noreferrer" key={link.label}>
            {link.label}
          </a>
        ))}
      </div>
      <code>npm run float:v2-verify-live</code>
    </article>
  );
}

function FloatStandingBoardPanel({
  board,
  alpha,
  beta,
  compact,
}: {
  board?: FloatStandingBoard;
  alpha?: Address;
  beta?: Address;
  compact: boolean;
}) {
  const agents = board?.agents || [];
  const visibleAgents = compact ? agents.slice(0, 3) : agents.slice(0, 8);
  const counts = board?.counts || {};
  const alphaApi = alpha ? `/api/float-tools?action=agent&address=${alpha}` : "/api/float?mode=v2";

  return (
    <article className="floatStandingBoard" aria-label="Shadow Float agent standing board">
      <div className="floatBoxHeader">
        <span>agent standing board</span>
        <small>
          {counts.invited || 0} invited · {counts["self-test"] || 0} self-test · {counts.lab || 0} lab · {counts.demo || 0} demo
        </small>
      </div>
      <div className="floatStandingIntro">
        <div>
          <strong>Behavior becomes queryable capacity.</strong>
          <p>Other agents can read standing before asking a sponsor-backed line to pay a provider.</p>
        </div>
        <a href={alphaApi} target="_blank" rel="noreferrer">
          Standing API
        </a>
      </div>
      <div className="floatStandingRows">
        {visibleAgents.length ? (
          visibleAgents.map((agent, index) => (
            <a
              className={`floatStandingRow ${agent.label}`}
              href={`/api/float-tools?action=agent&address=${agent.agent}`}
              key={agent.agent}
              target="_blank"
              rel="noreferrer"
            >
              <span className="floatStandingRank">#{index + 1}</span>
              <span className="floatStandingIdentity">
                <strong>{shortAddress(agent.agent)}</strong>
                <small>{agent.label}</small>
              </span>
              <span className="floatStandingStatus">{agent.status}</span>
              <span className="floatStandingMetric">
                <small>score</small>
                <strong>{agent.score}</strong>
              </span>
              <span className="floatStandingMetric">
                <small>line</small>
                <strong>{formatFloatUSDC(agent.creditLimitUSDC)}</strong>
              </span>
              <span className="floatStandingMetric">
                <small>available</small>
                <strong>{formatFloatUSDC(agent.availableCreditUSDC)}</strong>
              </span>
              <span className="floatStandingMetric">
                <small>debt</small>
                <strong>{formatFloatUSDC(agent.activeDebtUSDC)}</strong>
              </span>
            </a>
          ))
        ) : (
          <div className="floatStandingEmpty">Standing rows appear after the Float contract read returns agent lines.</div>
        )}
        {!compact && !counts.invited && (
          <div className="floatStandingExternalSlot">
            <span>invited slot</span>
            <strong>waiting for first builder line</strong>
            <small>Signed usage is counted separately only after a builder authorizes an x402 intent.</small>
          </div>
        )}
        {!compact && beta && !agents.some((agent) => agent.agent.toLowerCase() === beta.toLowerCase()) && (
          <a className="floatStandingRow demo" href={`/api/float-tools?action=agent&address=${beta}`} target="_blank" rel="noreferrer">
            <span className="floatStandingRank">demo</span>
            <span className="floatStandingIdentity">
              <strong>{shortAddress(beta)}</strong>
              <small>demo</small>
            </span>
            <span className="floatStandingStatus">queryable</span>
            <span className="floatStandingMetric">
              <small>API</small>
              <strong>open</strong>
            </span>
          </a>
        )}
      </div>
    </article>
  );
}

function FloatCreditFlywheelPanel({ board }: { board?: FloatStandingBoard }) {
  const agents = useMemo(() => (board?.agents || []).slice(0, 10), [board?.agents]);
  const agentKey = useMemo(() => agents.map((agent) => agent.agent).join(","), [agents]);
  const [scores, setScores] = useState<FloatScoreResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!agentKey) {
      setScores([]);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError(null);
    Promise.allSettled(
      agents.map(async (agent) => {
        const response = await fetch(`/api/float-tools?action=score&address=${agent.agent}`);
        if (!response.ok) throw new Error(`score ${response.status}`);
        return (await response.json()) as FloatScoreResponse;
      }),
    )
      .then((results) => {
        if (cancelled) return;
        const fulfilled = results
          .filter((result): result is PromiseFulfilledResult<FloatScoreResponse> => result.status === "fulfilled")
          .map((result) => result.value);
        setScores(fulfilled);
        const rejected = results.length - fulfilled.length;
        setError(rejected ? `${rejected} score read${rejected === 1 ? "" : "s"} did not return` : null);
      })
      .catch((err) => {
        if (!cancelled) {
          setScores([]);
          setError(err instanceof Error ? err.message : "score reads failed");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentKey, agents]);

  const orderedScores = useMemo(
    () => [...scores].sort((a, b) => floatScorePriority(a) - floatScorePriority(b)).slice(0, 6),
    [scores],
  );
  const receiptDerivedCount = scores.filter((score) => score.evidenceMode === "receipt-derived").length;
  const completeCount = scores.filter((score) => floatScoreEvidenceComplete(score)).length;
  const externalRepaidCount = scores.filter(
    (score) => score.label === "invited" && (score.evidence?.repaid || 0) > 0,
  ).length;
  const deferredRaiseCount = scores.filter((score) => classifyFloatScoreAction(score).label === "raise after repay").length;
  const readyActionCount = scores.filter((score) => {
    const action = classifyFloatScoreAction(score).label;
    return action === "raise ready" || action === "cut ready";
  }).length;
  const scoreApiHref = agents[0]?.agent
    ? `/api/float-tools?action=score&address=${agents[0].agent}`
    : "/api/float?mode=v2";

  return (
    <article className="floatCreditPanel" aria-label="Receipt-derived Float credit flywheel">
      <div className="floatBoxHeader">
        <span>receipt-derived credit flywheel</span>
        <small>{loading ? "reading scores" : `${receiptDerivedCount}/${scores.length || 0} receipt-derived`}</small>
      </div>
      <div className="floatCreditIntro">
        <div>
          <strong>Receipts now recompute capacity.</strong>
          <p>
            The v0 score reads Float receipts, mirrors the contract formula, and produces the next line action. Execution is
            still owner/operator-controlled; the evidence path is no longer a manually written score sheet.
          </p>
        </div>
        <a href={scoreApiHref} target="_blank" rel="noreferrer">
          Score API
        </a>
      </div>
      <div className="floatCreditMetrics">
        <FloatFact label="score mode" value={receiptDerivedCount ? "receipt-derived" : loading ? "syncing" : "pending"} />
        <FloatFact label="complete reads" value={`${completeCount}/${scores.length || 0}`} />
        <FloatFact label="external repaid" value={`${externalRepaidCount}`} />
        <FloatFact label="deferred raises" value={`${deferredRaiseCount}`} />
        <FloatFact label="ready actions" value={`${readyActionCount}`} />
      </div>
      <div className="floatCreditRows">
        {orderedScores.length ? (
          orderedScores.map((score) => {
            const action = classifyFloatScoreAction(score);
            const evidence = score.evidence || {};
            const agent = score.agent || score.currentLine?.wallet;
            return (
              <a
                className={`floatCreditRow ${action.tone}`}
                href={agent ? `/api/float-tools?action=score&address=${agent}` : "/api/float-tools?action=score"}
                target="_blank"
                rel="noreferrer"
                key={agent || `${score.label}-${score.currentLine?.score}`}
              >
                <span className="floatCreditIdentity">
                  <strong>{agent ? shortAddress(agent) : "agent pending"}</strong>
                  <small>
                    {score.label || "unlabeled"} · {score.currentLine?.status || "line pending"}
                  </small>
                </span>
                <span className="floatCreditScore">
                  <small>score</small>
                  <strong>
                    {score.currentLine?.score ?? "?"} -&gt; {score.computed?.score ?? "?"}
                  </strong>
                </span>
                <span className="floatCreditScore">
                  <small>line</small>
                  <strong>
                    {formatFloatUSDC(score.currentLine?.creditLimitUSDC)} -&gt;{" "}
                    {formatFloatUSDC(score.computed?.recommendedLimitUSDC)}
                  </strong>
                </span>
                <span className="floatCreditEvidence">
                  <small>evidence</small>
                  <strong>
                    paid {evidence.paidBound || 0} · signed {evidence.signedExternalPaidBound || 0} · repaid {evidence.repaid || 0}
                  </strong>
                </span>
                <span className="floatCreditAction">
                  <small>{action.detail}</small>
                  <strong>{action.label}</strong>
                </span>
              </a>
            );
          })
        ) : (
          <div className="floatCreditEmpty">{loading ? "Reading receipt-derived scores..." : "Score rows appear after the standing board loads."}</div>
        )}
      </div>
      <div className="floatCreditCommand">
        <span>read-only score</span>
        <code>npm run float:score-proof</code>
        <span>owner-controlled runner</span>
        <code>npm run float:autounderwrite</code>
      </div>
      {error && <p className="floatCreditNote">{error}</p>}
    </article>
  );
}

function floatScoreEvidenceComplete(score: FloatScoreResponse): boolean {
  return Boolean(
    score.evidenceMode === "receipt-derived" &&
      score.evidenceCompleteness?.logFetchComplete &&
      score.evidenceCompleteness?.indexedReceiptCountMatchesChain,
  );
}

function asAtomicUSDC(value?: string | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function classifyFloatScoreAction(score: FloatScoreResponse): { label: string; detail: string; tone: "allow" | "block" | "pending" } {
  if (!floatScoreEvidenceComplete(score)) return { label: "evidence syncing", detail: "index check", tone: "pending" };
  const currentLimit = asAtomicUSDC(score.currentLine?.creditLimitUSDC);
  const recommendedLimit = asAtomicUSDC(score.computed?.recommendedLimitUSDC);
  const activeDebt = asAtomicUSDC(score.currentLine?.activeDebtUSDC);
  const currentScore = score.currentLine?.score ?? 0;
  const computedScore = score.computed?.score ?? currentScore;

  if (recommendedLimit > currentLimit && activeDebt > 0n) {
    return { label: "raise after repay", detail: "debt open", tone: "pending" };
  }
  if (recommendedLimit > currentLimit) return { label: "raise ready", detail: "capacity earned", tone: "allow" };
  if (recommendedLimit < currentLimit) return { label: "cut ready", detail: "capacity reduced", tone: "block" };
  if (computedScore !== currentScore) return { label: "score refresh", detail: "same band", tone: "pending" };
  return { label: "current", detail: "line supported", tone: "allow" };
}

function floatScorePriority(score: FloatScoreResponse): number {
  const action = classifyFloatScoreAction(score).label;
  if (score.label === "invited" && (score.evidence?.repaid || 0) > 0) return 0;
  if (score.label === "invited" && action === "raise after repay") return 1;
  if (score.label === "invited") return 2;
  if (action === "raise ready" || action === "cut ready") return 3;
  if (score.label === "lab") return 4;
  if (score.label === "demo") return 6;
  return 5;
}

function FloatExternalSignedPanel({ state }: { state: FloatState | null }) {
  const externalRuns = (state?.loopRuns || []).filter((run) => run.source === "external-signed" && run.requestHash);
  const obolRuns = externalRuns.filter((run) => classifyExternalSignedRun(run).kind === "obol");
  const builderRuns = externalRuns.filter((run) => classifyExternalSignedRun(run).kind !== "obol");
  const sortedRuns = [...obolRuns, ...builderRuns];
  const summary = state?.sourceBreakdown?.externalSigned;
  const externalRepays = (state?.receipts || []).filter((receipt) => receipt.receiptType === "REPAID");

  return (
    <article className="floatExternalPanel" aria-label="External signed Shadow Float spends">
      <div className="floatBoxHeader">
        <span>external signed spends</span>
        <small>
          {summary?.cycles || 0} signed · {summary?.lifecycleClosedCount || 0} repaid ·{" "}
          {formatFloatUSDC(summary?.providerPaidUSDC)} USDC settled
        </small>
      </div>
      <div className="floatExternalIntro">
        <div>
          <strong>Outside agents sign; Shadow verifies before provider payment.</strong>
          <p>
            These rows show spend intents signed against Float contracts. V2 signatures are contract-enforced direct
            provider payments; older rows remain labeled as historical x402 binds.
          </p>
        </div>
        <a href="/api/float?mode=v2" target="_blank" rel="noreferrer">
          Live API
        </a>
      </div>
      <div className="floatExternalRows">
        {sortedRuns.length ? (
          sortedRuns.map((run) => {
            const label = classifyExternalSignedRun(run);
            const requestHash = run.requestHash || "";
            const agent = run.agent || run.intent?.agent;
            const amount = run.amountUSDC || run.intent?.amountUSDC;
            const repayReceipt = agent
              ? externalRepays.find((receipt) => receipt.agent?.toLowerCase() === agent.toLowerCase())
              : undefined;
            const repayTxHash = run.repayTxHash || repayReceipt?.transactionHash;
            return (
              <div className={`floatExternalRow ${label.kind}`} key={requestHash || run.id}>
                <div className="floatExternalIdentity">
                  <span>{label.eyebrow}</span>
                  <strong>{label.title}</strong>
                  <small>{agent ? shortAddress(agent) : "agent hidden"}</small>
                </div>
                <div className="floatExternalReason">
                  <strong>{run.outcome || "SIGNED"}</strong>
                  <p>{run.intent?.reason || run.reason || "Signed external Float intent."}</p>
                </div>
                <div className="floatExternalAmount">
                  <span>amount</span>
                  <strong>{formatFloatUSDC(amount)} USDC</strong>
                  <small>{repayTxHash ? "debt repaid · line restored" : "debt open unless repaid separately"}</small>
                </div>
                <div className="floatExternalLinks">
                  {requestHash && (
                    <a href={`/api/float-tools?action=verify&hash=${requestHash}`} target="_blank" rel="noreferrer">
                      verify {shortHash(requestHash)}
                    </a>
                  )}
                  {run.x402Hash && (
                    <a href={txUrl(run.x402Hash)} target="_blank" rel="noreferrer">
                      x402 {shortAddress(run.x402Hash)}
                    </a>
                  )}
                  {run.bindTxHash && (
                    <a href={txUrl(run.bindTxHash)} target="_blank" rel="noreferrer">
                      bind {shortAddress(run.bindTxHash)}
                    </a>
                  )}
                  {repayTxHash && (
                    <a href={txUrl(repayTxHash)} target="_blank" rel="noreferrer">
                      repay {shortAddress(repayTxHash)}
                    </a>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="floatExternalEmpty">
            Signed external spends appear here after an outside agent signs a Float intent and the receipt is indexed.
          </div>
        )}
      </div>
    </article>
  );
}

function classifyExternalSignedRun(run: FloatLoopRun): ExternalSignedLabel {
  const agent = (run.agent || run.intent?.agent || "").toLowerCase();
  const reason = (run.intent?.reason || run.reason || "").toLowerCase();
  const known = EXTERNAL_SIGNER_LABELS[agent];
  if (known) return known;
  if (agent === OBOL_SIGNER || reason.includes("obol")) {
    return EXTERNAL_SIGNER_LABELS[OBOL_SIGNER];
  }
  if (reason.includes("forum")) return { kind: "builder", eyebrow: "Forum agent", title: "Forum signed Float V2 intent" };
  if (reason.includes("citepay")) {
    return { kind: "builder", eyebrow: "CitePay agent", title: "CitePay signed Float V2 intent" };
  }
  if (reason.includes("crux")) return { kind: "builder", eyebrow: "Crux agent", title: "Crux signed Float V2 intent" };
  if (reason.includes("argus")) {
    return { kind: "builder", eyebrow: "Argus Agent Alpha", title: "Argus signed Float V2 intent" };
  }
  return { kind: "builder", eyebrow: "invited builder agent", title: "External signed intent" };
}

function FloatLoopPanel({ state, compact }: { state: FloatState | null; compact: boolean }) {
  const summary = state?.sourceBreakdown?.agentLoop;
  const runs = state?.loopRuns || [];
  const latest = runs[0];
  const hasRuns = Boolean(summary?.cycles);

  return (
    <article className="floatLoopPanel" id="float-loop">
      <div className="floatBoxHeader">
        <span>autonomous float loop</span>
        <small>{hasRuns ? `${summary?.cycles || 0} labeled cycles` : "no scheduled cycle indexed"}</small>
      </div>
      <div className="floatLoopStats">
        <FloatFact label="agent-loop paid" value={`${summary?.paidCount || 0}`} />
        <FloatFact label="blocked" value={`${summary?.blockedCount || 0}`} />
        <FloatFact label="denied" value={`${summary?.deniedCount || 0}`} />
        <FloatFact label="repaid" value={`${summary?.repaidCount || 0}`} />
        <FloatFact label="skipped" value={`${summary?.skipCount || 0}`} />
        <FloatFact label="quote-only exits" value={`${summary?.fallbacks || 0}`} />
      </div>
      <div className="floatLoopSplit">
        <div>
          <span>agent-loop x402 settled</span>
          <strong>{formatFloatUSDC(summary?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>historical x402 settled</span>
          <strong>{formatFloatUSDC(state?.sourceBreakdown?.demoAdmin?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>signed external spends</span>
          <strong>{formatFloatUSDC(state?.sourceBreakdown?.externalSigned?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>assisted onboarding</span>
          <strong>{formatFloatUSDC(state?.sourceBreakdown?.assisted?.providerPaidUSDC)}</strong>
        </div>
      </div>
      {latest ? (
        <div className={`floatLoopLatest ${latest.outcome?.includes("BLOCK") || latest.outcome === "DENIED" ? "blocked" : ""}`}>
          <div>
            <span>{latest.action || "UNKNOWN"}</span>
            <strong>{latest.outcome || "pending"}</strong>
            <small>
              {latest.model || "model unknown"}
              {latest.fellBack ? " · conservative route" : ""}
            </small>
          </div>
          <p>{latest.rationale || "No rationale recorded."}</p>
          <div className="floatLoopLinks">
            {latest.x402Hash && (
              <a href={txUrl(latest.x402Hash)} target="_blank" rel="noreferrer">
                x402 {shortAddress(latest.x402Hash)}
              </a>
            )}
            {latest.bindTxHash && (
              <a href={txUrl(latest.bindTxHash)} target="_blank" rel="noreferrer">
                bind {shortAddress(latest.bindTxHash)}
              </a>
            )}
            {latest.repayTxHash && (
              <a href={txUrl(latest.repayTxHash)} target="_blank" rel="noreferrer">
                repay {shortAddress(latest.repayTxHash)}
              </a>
            )}
            {latest.txHash && (
              <a href={txUrl(latest.txHash)} target="_blank" rel="noreferrer">
                receipt {shortAddress(latest.txHash)}
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="floatLoopEmpty">
          The Float receipt stream is live. No scheduled agent-loop receipt is indexed yet.
        </div>
      )}
      {!compact && hasRuns && (
        <div className="floatLoopRunList">
          {runs.slice(0, 5).map((run, index) => (
            <div className="floatLoopRun" key={`${run.id || index}-${run.outcome || "run"}`}>
              <span>{run.action || "UNKNOWN"}</span>
              <strong>{run.outcome || "pending"}</strong>
              <small>{run.at ? new Date(run.at).toLocaleString() : "time pending"}</small>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function FloatHeadlineStat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`floatHeadlineStat${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function FloatMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`floatMetric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function FloatFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="floatFact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatFloatUSDC(value?: string | bigint | null): string {
  if (value === undefined || value === null || value === "") return "0";
  try {
    const raw = typeof value === "bigint" ? value : BigInt(value);
    return formatUSDC(raw);
  } catch {
    return "0";
  }
}

function formatDeskTime(value?: string | null): string {
  if (!value) return "pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "pending";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortHash(value?: string | null): string {
  if (!value || value.length < 14) return "pending";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function humanizeFloatKey(value: string): string {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}

function normalizeBytes32(hex: string): Hash {
  let v = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  v = v.toLowerCase();
  if (v.length > 64) v = v.slice(0, 64);
  if (v.length < 64) v = v.padStart(64, "0");
  return `0x${v}` as Hash;
}

async function switchToArc() {
  if (!window.ethereum) return;
  const arcTestnetParams = {
    chainId: "0x4cef52",
    chainName: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: ["https://rpc.testnet.arc.network"],
    blockExplorerUrls: ["https://testnet.arcscan.app"],
  };
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: arcTestnetParams.chainId }],
    });
  } catch (error: unknown) {
    const code = (error as { code?: number })?.code;
    const message = String((error as { message?: string })?.message || "").toLowerCase();
    if (code === 4902 || message.includes("unrecognized") || message.includes("add the chain")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [arcTestnetParams],
      });
      return;
    }
    throw error;
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <article className="card">
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function Header({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="sectionHeader">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function HowItWorks() {
  const steps = [
    {
      num: "01",
      tone: "policy",
      title: "Choose a source agent",
      body: "Browse source reputation from real onchain receipts. CatArb, LobsterRisk, MomentumOtter, each with public copy and block history.",
    },
    {
      num: "02",
      tone: "policy",
      title: "Set delegation policy",
      body: "Deposit USDC into the router. Set max per intent, daily cap, allowed asset, and minimum slippage. Your rules sit onchain, not in a backend.",
    },
    {
      num: "03",
      tone: "outcome",
      title: "Copy or refuse every intent, onchain",
      body: "When the source agent publishes, Shadow either copies the swap or refuses it with an onchain receipt that names the exact policy field. No surprises, no off chain matcher.",
    },
  ];
  return (
    <section className="howItWorks">
      <p className="eyebrow">how Shadow works</p>
      <h2 className="howTitle">Three steps from picking a source to a verifiable receipt.</h2>
      <div className="howSteps">
        {steps.map((step) => (
          <div className={`howStep howStep--${step.tone}`} key={step.num}>
            <span>{step.num}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FollowFlow({
  sources,
  selectedSource,
  onSelectSource,
  selectedPreset,
  onSelectPreset,
  depositAmount,
  onDepositChange,
  onFollow,
  following,
  action,
  account,
  userBalance,
  userFollows,
  connectWallet,
}: {
  sources: SourceAgent[];
  selectedSource: Address | null;
  onSelectSource: (address: Address) => void;
  selectedPreset: PresetKey;
  onSelectPreset: (key: PresetKey) => void;
  depositAmount: string;
  onDepositChange: (value: string) => void;
  onFollow: () => Promise<void>;
  following: boolean;
  action: ActionState;
  account?: Address;
  userBalance: bigint;
  userFollows: Set<string>;
  connectWallet: () => Promise<void>;
}) {
  const selectedName =
    sources.find((s) => s.address.toLowerCase() === selectedSource?.toLowerCase())?.name || "a source";
  const preset = PRESETS[selectedPreset];
  return (
    <section className="followFlow" id="start">
      <header className="followHeader">
        <p className="eyebrow">start following · web2-readable</p>
        <h2>Choose an agent. Set your risk. Done in four taps.</h2>
        <p className="lede">
          You stay in your own wallet. Shadow holds your USDC in escrow and only spends it when an agent&apos;s intent
          fits the rules you set. Raise or lower those rules whenever you want.
        </p>
      </header>

      <div className="followStep">
        <span className="stepNum">1</span>
        <div className="stepBody">
          <h3>Pick your agent</h3>
          <p className="stepHint">These are the live AI source agents on Arc. You can change later.</p>
          <div className="sourceChoices">
            {sources.length === 0 && <Empty text="No source agents registered yet." />}
            {sources.map((source) => {
              const isSelected = selectedSource?.toLowerCase() === source.address.toLowerCase();
              const isFollowed = userFollows.has(source.address.toLowerCase());
              return (
                <button
                  key={source.address}
                  className={`sourceChoice ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelectSource(source.address)}
                  type="button"
                >
                  <div className="sourceChoiceTop">
                    <strong>{source.name}</strong>
                    {isFollowed && <span className="sourceTag">following</span>}
                  </div>
                  <span className="sourceChoiceAddr">{shortAddress(source.address)}</span>
                  <span className="sourceChoiceMeta">
                    {source.followerCount.toString()} follow records · registry score {(source.reputationScore / 100).toFixed(0)}%
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="followStep">
        <span className="stepNum">2</span>
        <div className="stepBody">
          <h3>Pick your risk rule</h3>
          <p className="stepHint">This is the rule the router will check on every intent. Anything outside it gets blocked, on-chain.</p>
          <div className="presetChoices">
            {(Object.keys(PRESETS) as PresetKey[]).map((key) => {
              const p = PRESETS[key];
              const isSelected = selectedPreset === key;
              return (
                <button
                  key={key}
                  className={`presetChoice ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelectPreset(key)}
                  type="button"
                >
                  <strong>{p.label}</strong>
                  <span className="presetTagline">{p.tagline}</span>
                  <dl className="presetStats">
                    <div>
                      <dt>max/intent</dt>
                      <dd>{p.maxAmountPerIntent} USDC</dd>
                    </div>
                    <div>
                      <dt>daily cap</dt>
                      <dd>{p.dailyCap} USDC</dd>
                    </div>
                    <div>
                      <dt>min slippage</dt>
                      <dd>{p.minBpsOut} bps</dd>
                    </div>
                    <div>
                      <dt>max risk</dt>
                      <dd>L{p.maxRiskLevel}</dd>
                    </div>
                  </dl>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="followStep">
        <span className="stepNum">3</span>
        <div className="stepBody">
          <h3>Deposit USDC</h3>
          <p className="stepHint">
            This is the budget for mirroring. It sits in escrow until your rule lets an intent through. You can withdraw any
            unused balance any time. Need testnet USDC?{" "}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer noopener">
              Grab some from Circle&apos;s faucet
            </a>
            .
          </p>
          <div className="depositRow">
            <input
              className="depositInput"
              type="text"
              inputMode="decimal"
              value={depositAmount}
              onChange={(event) => onDepositChange(event.target.value)}
              placeholder="0.5"
            />
            <span className="depositUnit">USDC</span>
          </div>
        </div>
      </div>

      <div className="followSummary">
        <span className="followSummaryLabel">What you&apos;re about to do</span>
        <p className="followSummaryBody">
          Follow <strong>{selectedName}</strong> with the <strong>{preset.label.toLowerCase()}</strong> rule. Any of its
          intents up to <strong>{preset.maxAmountPerIntent} USDC</strong> per intent get copied to you. Anything over
          that, or anything riskier than <strong>L{preset.maxRiskLevel}</strong>, gets blocked on-chain.
        </p>
      </div>
      <div className="followAction">
        {!account ? (
          <button className="followCta" onClick={connectWallet} type="button">
            connect wallet to continue
          </button>
        ) : (
          <button className="followCta" onClick={onFollow} disabled={following} type="button">
            {following ? "submitting…" : `Follow ${selectedName} now`}
          </button>
        )}
        <div className={action.error ? "followStatus error" : "followStatus"}>
          <strong>{action.label}</strong>
          {action.tx && (
            <a href={txUrl(action.tx)} target="_blank" rel="noreferrer noopener">
              {shortAddress(action.tx)}
            </a>
          )}
          {action.error && <span>{action.error}</span>}
        </div>
        {account && (
          <div className="followWallet">
            <span>
              wallet <strong>{shortAddress(account)}</strong>
            </span>
            <span>
              router balance <strong>{formatUSDC(userBalance)} USDC</strong>
            </span>
            <span>
              following <strong>{userFollows.size}</strong> of {sources.length}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function ManagePanel({
  sources,
  userBalance,
  userFollows,
  withdrawAmount,
  onWithdrawChange,
  onWithdraw,
  onUnfollow,
  managing,
}: {
  sources: SourceAgent[];
  userBalance: bigint;
  userFollows: Set<string>;
  withdrawAmount: string;
  onWithdrawChange: (value: string) => void;
  onWithdraw: () => Promise<void>;
  onUnfollow: (source: Address) => Promise<void>;
  managing: boolean;
}) {
  const followedSources = sources.filter((source) => userFollows.has(source.address.toLowerCase()));
  return (
    <section className="managePanel">
      <header className="sectionHeader">
        <p className="eyebrow">manage your follows</p>
        <h2>Withdraw idle balance or stop mirroring a source.</h2>
      </header>

      <div className="manageGrid">
        <div className="manageCard">
          <p className="eyebrow">router balance</p>
          <strong className="manageBalance">{formatUSDC(userBalance)} USDC</strong>
          <p className="manageHint">Pull idle USDC back to your wallet at any time. Mirroring stops only when the source publishes more intents than your balance covers.</p>
          <div className="depositRow">
            <input
              className="depositInput"
              type="text"
              inputMode="decimal"
              value={withdrawAmount}
              onChange={(event) => onWithdrawChange(event.target.value)}
              placeholder={formatUSDC(userBalance)}
              disabled={managing || userBalance === 0n}
            />
            <span className="depositUnit">USDC</span>
          </div>
          <div className="manageActions">
            <button
              className="manageButton"
              type="button"
              onClick={() => onWithdrawChange(formatUSDC(userBalance))}
              disabled={managing || userBalance === 0n}
            >
              max
            </button>
            <button
              className="manageButton primary"
              type="button"
              onClick={onWithdraw}
              disabled={managing || userBalance === 0n}
            >
              {managing ? "submitting…" : "withdraw"}
            </button>
          </div>
        </div>

        <div className="manageCard">
          <p className="eyebrow">followed sources</p>
          <strong className="manageBalance">{followedSources.length} active</strong>
          <p className="manageHint">Unfollow flips the policy to inactive. The router skips that source for any later intent until you follow again.</p>
          <div className="unfollowList">
            {followedSources.length === 0 && <span className="empty">No active policies on this wallet.</span>}
            {followedSources.map((source) => (
              <div className="unfollowRow" key={source.address}>
                <div className="unfollowMeta">
                  <strong>{source.name}</strong>
                  <span>{shortAddress(source.address)}</span>
                </div>
                <button
                  className="manageButton"
                  type="button"
                  onClick={() => onUnfollow(source.address)}
                  disabled={managing}
                >
                  unfollow
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function LatestReasoningPanel({ data }: { data: ReasoningResponse | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  if (!data || !data.configured) {
    return null;
  }

  if (!data.packet) {
    return (
      <section className="reasoningPanel empty">
        <div className="reasoningHeader">
          <p className="eyebrow">latest agent reasoning</p>
          <h2>Waiting for the next cron tick.</h2>
        </div>
        <p className="reasoningEmpty">No reasoning packets stored yet. The next published intent will appear here with its full rationale and a content-derived intentHash you can verify on chain.</p>
      </section>
    );
  }

  const packet = data.packet;
  const secondsSince = Math.max(0, Math.floor(now / 1000 - packet.createdAt));
  const confidencePct = (packet.confidenceBps / 100).toFixed(2);
  const shortHash = `${packet.intentHash.slice(0, 10)}…${packet.intentHash.slice(-6)}`;
  return (
    <section className="reasoningPanel">
      <div className="reasoningHeader">
        <div>
          <p className="eyebrow">latest agent reasoning</p>
          <h2>{packet.sourceName} just published an intent.</h2>
        </div>
        <span className={`reasoningBadge ${packet.decision}`}>{packet.decision.toUpperCase()}</span>
      </div>
      <p className="reasoningRationale">{packet.rationale}</p>
      <dl className="reasoningGrid">
        <div>
          <dt>source</dt>
          <dd>{shortAddress(packet.sourceAgent as `0x${string}`)}</dd>
        </div>
        <div>
          <dt>intent hash</dt>
          <dd className="mono">{shortHash}</dd>
        </div>
        <div>
          <dt>amount</dt>
          <dd>{packet.amountUSDC} USDC</dd>
        </div>
        <div>
          <dt>min out</dt>
          <dd>{packet.minAmountOut} ARCETH</dd>
        </div>
        <div>
          <dt>live quote</dt>
          <dd>{packet.liveQuote} ARCETH</dd>
        </div>
        <div>
          <dt>confidence</dt>
          <dd>{confidencePct}%</dd>
        </div>
        <div>
          <dt>risk level</dt>
          <dd>L{packet.riskLevel}</dd>
        </div>
        <div>
          <dt>pool depth</dt>
          <dd>{packet.reserveUSDC} USDC</dd>
        </div>
      </dl>
      <p className="reasoningFooter">
        <span>created {secondsSince}s ago</span>
        <span className="mono">intentHash = keccak256(source, amount, minOut, liveQuote, risk, name, rationale)</span>
      </p>
    </section>
  );
}

type DerivedRefusal = {
  label: string;
  detail: string;
  rawReason: string;
};

function derivePilotRefusal(
  receipt: ReceiptLog,
  intent: IntentLog | undefined,
  reasoning: ReasoningResponse | null,
): DerivedRefusal | null {
  const packet = reasoning?.packet;
  if (receipt.status !== "blocked" || !intent || !packet) return null;
  if (packet.intentHash.toLowerCase() !== intent.intentHash.toLowerCase()) return null;
  if (receipt.reason === "insufficient balance") return null;

  return {
    label: pilotRefusalLabel(receipt.reason, packet.decision),
    detail: pilotRefusalDetail(receipt.reason, packet.rationale),
    rawReason: receipt.reason,
  };
}

function pilotRefusalLabel(rawReason: string, decision: ReasoningPacket["decision"]) {
  if (decision === "skip") return "Pilot veto: source intent skipped";
  if (rawReason === "slippage too tight") return "Pilot veto: live quote failed policy";
  if (rawReason === "amount too high" || rawReason === "daily cap exceeded") return "Pilot veto: follower budget rejected";
  if (rawReason === "risk too high") return "Pilot veto: risk tier rejected";
  return "Pilot-labeled refusal";
}

function pilotRefusalDetail(rawReason: string, rationale: string) {
  const cleanRationale = rationale.trim().replace(/\s+/g, " ");
  const trimmedRationale = cleanRationale.length > 116 ? `${cleanRationale.slice(0, 113)}...` : cleanRationale;
  return trimmedRationale || `Reasoning packet attached to this ${rawReason} receipt.`;
}

function LiveFeed({
  receipts,
  intents,
  closes,
  sourceNameByAddress,
  reasoning,
  latestBlock,
  fetchedAt,
  loading,
  totalReceipts,
  account,
  closingIntentId,
  onClosePosition,
}: {
  receipts: ReceiptLog[];
  intents: IntentLog[];
  closes: PositionCloseLog[];
  sourceNameByAddress: Map<string, string>;
  reasoning: ReasoningResponse | null;
  latestBlock: bigint;
  fetchedAt: number;
  loading: boolean;
  totalReceipts: number;
  account?: Address;
  closingIntentId: bigint | null;
  onClosePosition: (intentId: bigint) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "copied" | "blocked">("all");
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const secondsSince = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const accountKey = account?.toLowerCase();
  const closedByFollowerIntent = new Set(closes.map((close) => `${close.follower.toLowerCase()}:${close.intentId.toString()}`));
  const latestCloses = closes
    .slice()
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
    .slice(0, 4);

  const intentByKey = useMemo(() => {
    const map = new Map<string, IntentLog>();
    for (const intent of intents) {
      map.set(`${intent.sourceAgent.toLowerCase()}:${intent.intentId.toString()}`, intent);
    }
    return map;
  }, [intents]);

  const sourceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of receipts) {
      const key = r.sourceAgent.toLowerCase();
      if (!map.has(key)) map.set(key, sourceNameByAddress.get(key) || shortAddress(r.sourceAgent));
    }
    return Array.from(map.entries());
  }, [receipts, sourceNameByAddress]);

  const reasonOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of receipts) if (r.status === "blocked") set.add(r.reason);
    return Array.from(set);
  }, [receipts]);

  const filteredReceipts = useMemo(() => {
    return receipts.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (sourceFilter !== "all" && r.sourceAgent.toLowerCase() !== sourceFilter) return false;
      if (reasonFilter !== "all" && r.reason !== reasonFilter) return false;
      return true;
    });
  }, [receipts, statusFilter, sourceFilter, reasonFilter]);
  return (
    <section className="liveFeed" id="live-feed">
      <div className="liveFeedHeader">
        <div>
          <p className="eyebrow">
            <span className={`livePulse ${loading ? "loading" : ""}`} />
            recent-window activity · auto refresh
          </p>
          <h2>Recent onchain receipts across every source.</h2>
        </div>
        <div className="liveFeedMeta">
          <div>
            <dt>latest block</dt>
            <dd>{latestBlock ? latestBlock.toString() : "…"}</dd>
          </div>
          <div>
            <dt>last fetch</dt>
            <dd>{secondsSince}s ago</dd>
          </div>
          <div>
            <dt>window receipts</dt>
            <dd>{totalReceipts}</dd>
          </div>
        </div>
      </div>
      <div className="liveFeedFilters" role="group" aria-label="Receipt filters">
        <div className="liveFeedFilterGroup">
          <span className="liveFeedFilterLabel">Outcome</span>
          {(["all", "copied", "blocked"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              className={`liveFeedFilterBtn${statusFilter === opt ? " active" : ""}`}
              onClick={() => setStatusFilter(opt)}
            >
              {opt === "all" ? "all" : opt}
            </button>
          ))}
        </div>
        {sourceOptions.length > 1 && (
          <div className="liveFeedFilterGroup">
            <span className="liveFeedFilterLabel">Agent</span>
            <button
              type="button"
              className={`liveFeedFilterBtn${sourceFilter === "all" ? " active" : ""}`}
              onClick={() => setSourceFilter("all")}
            >
              all
            </button>
            {sourceOptions.map(([addr, name]) => (
              <button
                key={addr}
                type="button"
                className={`liveFeedFilterBtn${sourceFilter === addr ? " active" : ""}`}
                onClick={() => setSourceFilter(addr)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        {statusFilter !== "copied" && reasonOptions.length > 0 && (
          <div className="liveFeedFilterGroup">
            <span className="liveFeedFilterLabel">Block reason</span>
            <button
              type="button"
              className={`liveFeedFilterBtn${reasonFilter === "all" ? " active" : ""}`}
              onClick={() => setReasonFilter("all")}
            >
              all
            </button>
            {reasonOptions.map((reason) => (
              <button
                key={reason}
                type="button"
                className={`liveFeedFilterBtn${reasonFilter === reason ? " active" : ""}`}
                onClick={() => setReasonFilter(reason)}
              >
                {reason}
              </button>
            ))}
          </div>
        )}
        <span className="liveFeedFilterCount">
          {filteredReceipts.length} of {receipts.length}
        </span>
      </div>
      <div className="liveFeedList">
        {filteredReceipts.length === 0 && (
          <div className="empty">
            {receipts.length === 0
              ? "No receipts yet. Cron fires every 10 minutes."
              : "No receipts match these filters."}
          </div>
        )}
        {filteredReceipts.map((receipt, index) => {
          const sourceName = sourceNameByAddress.get(receipt.sourceAgent.toLowerCase()) || shortAddress(receipt.sourceAgent);
          const blocksAgo = latestBlock && receipt.blockNumber ? Number(latestBlock - receipt.blockNumber) : 0;
          const receiptKey = `${receipt.follower.toLowerCase()}:${receipt.intentId.toString()}`;
          const linkedIntent = intentByKey.get(`${receipt.sourceAgent.toLowerCase()}:${receipt.intentId.toString()}`);
          const pilotRefusal = derivePilotRefusal(receipt, linkedIntent, reasoning);
          const canClose =
            receipt.status === "copied" &&
            Boolean(accountKey) &&
            receipt.follower.toLowerCase() === accountKey &&
            !closedByFollowerIntent.has(receiptKey);
          const isFresh = index === 0;
          return (
            <article className={`liveFeedRow ${receipt.status}${isFresh ? " fresh" : ""}`} key={`${receipt.transactionHash}-${receipt.follower}`}>
              <span className={`liveBadge ${receipt.status}`}>{receipt.status === "copied" ? "COPIED" : "BLOCKED"}</span>
              <div className="liveFeedSource">
                <strong>{sourceName}</strong>
                <span>intent {receipt.intentId.toString()}</span>
              </div>
              <div className="liveFeedFollower">
                <span>follower</span>
                <strong>{shortAddress(receipt.follower)}</strong>
              </div>
              <div className="liveFeedAmount">
                {receipt.status === "copied" ? (
                  <>
                    <strong>{formatUSDC(receipt.usdcAmount)} USDC</strong>
                    <span>for {formatAsset(receipt.assetAmountOut)} ARCETH</span>
                    {receipt.gatewaySettlement?.status === "settled" && (
                      <span className="gatewaySettlementLine">
                        fee {receipt.gatewaySettlement.feeUSDC} USDC settled · Gateway
                      </span>
                    )}
                  </>
                ) : (
                  pilotRefusal ? (
                    <div className="refusalStack">
                      <strong className="pilotRefusalLabel">{pilotRefusal.label}</strong>
                      <span>{pilotRefusal.detail}</span>
                      <span className="rawOnchainReason">raw onchain reason: {pilotRefusal.rawReason}</span>
                    </div>
                  ) : (
                    <>
                      <strong>{receipt.reason}</strong>
                      <span>{formatUSDC(receipt.usdcAmount)} USDC requested</span>
                    </>
                  )
                )}
              </div>
              <a className="liveFeedAge" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer noopener">
                block {receipt.blockNumber.toString()}
                <span>{blocksAgo > 0 ? `${blocksAgo} blocks ago` : "just now"}</span>
              </a>
              {canClose && (
                <button
                  className="closePositionButton"
                  type="button"
                  onClick={() => onClosePosition(receipt.intentId)}
                  disabled={closingIntentId === receipt.intentId}
                >
                  {closingIntentId === receipt.intentId ? "closing..." : "close position"}
                </button>
              )}
            </article>
          );
        })}
      </div>
      <div className="closeFeed">
        <div className="closeFeedHeader">
          <p className="eyebrow">realized close loop</p>
          <h3>Copied positions can round trip back into router USDC.</h3>
        </div>
        {latestCloses.length === 0 ? (
          <div className="empty">No PositionClosed events yet. Close one copied receipt to complete the realized PnL loop.</div>
        ) : (
          <div className="closeFeedList">
            {latestCloses.map((close) => {
              const sourceName = sourceNameByAddress.get(close.sourceAgent.toLowerCase()) || shortAddress(close.sourceAgent);
              const pnl = Number(close.pnlBps) / 100;
              return (
                <article className="closeFeedRow" key={`${close.transactionHash}-${close.follower}-${close.intentId.toString()}`}>
                  <div>
                    <strong>{sourceName}</strong>
                    <span>intent {close.intentId.toString()} closed by {shortAddress(close.follower)}</span>
                  </div>
                  <div>
                    <strong>{formatUSDC(close.usdcIn)} → {formatUSDC(close.usdcOut)} USDC</strong>
                    <span className={pnl >= 0 ? "pnlPositive" : "pnlNegative"}>{pnl.toFixed(2)}% realized PnL</span>
                  </div>
                  <a href={txUrl(close.transactionHash)} target="_blank" rel="noreferrer noopener">
                    {shortAddress(close.transactionHash)}
                  </a>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function VerifyResultPanel({ result }: { result: VerifyResponse }) {
  const verdictClass = result.ok ? "pass" : "fail";
  return (
    <article className={`liveVerifyResult ${verdictClass}`}>
      <header className="liveVerifyVerdict">
        <strong>{result.ok ? "PASS" : "FAIL"}</strong>
        {result.cached && <span className="cached">cached · next run in {result.retryAfter}s</span>}
      </header>
      <dl className="liveVerifyMeta">
        <div>
          <dt>tx</dt>
          <dd>
            <a href={txUrl(result.tx)} target="_blank" rel="noreferrer noopener">
              {shortAddress(result.tx)}
            </a>
          </dd>
        </div>
        {result.intentHash && (
          <div>
            <dt>reasoning hash</dt>
            <dd>{shortAddress(result.intentHash)}</dd>
          </div>
        )}
        <div>
          <dt>block</dt>
          <dd>{result.blockNumber}</dd>
        </div>
        <div>
          <dt>amountUSDC</dt>
          <dd>{result.amountUSDC}</dd>
        </div>
        <div>
          <dt>live quote</dt>
          <dd>{result.liveQuote} ARCETH</dd>
        </div>
        <div>
          <dt>minAmountOut</dt>
          <dd>{result.minAmountOut} ARCETH</dd>
        </div>
      </dl>
      <div className="liveVerifyOutcomes">
        <div className={`liveOutcome ${result.followerA.status === "BLOCKED" ? "blocked" : "copied"}`}>
          <strong>Follower A · {result.followerA.status}</strong>
          <span>reason: {result.followerA.reason}</span>
          <span>scaled min {result.scaledMinA} ARCETH</span>
        </div>
        <div className={`liveOutcome ${result.followerB.status === "COPIED" ? "copied" : "blocked"}`}>
          <strong>Follower B · {result.followerB.status}</strong>
          <span>
            {result.followerB.status === "COPIED"
              ? `received ${result.followerB.assetOut} ARCETH`
              : `reason: ${result.followerB.reason}`}
          </span>
          <span>scaled min {result.scaledMinB} ARCETH</span>
        </div>
      </div>
    </article>
  );
}

function SpotlightCard({
  verdict,
  kind,
  label,
  follower,
  receipt,
  detail,
}: {
  verdict: "BLOCKED" | "COPIED";
  kind: "blocked" | "copied";
  label: string;
  follower: Address;
  receipt: ReceiptLog;
  detail: string;
}) {
  return (
    <article className={`spotlightCard ${kind}`}>
      <div className="spotlightCardStamp">
        <span className="spotlightCardStampMark">{kind === "copied" ? "✓" : "✕"}</span>
        <span className="spotlightCardStampText">{verdict}</span>
      </div>
      <p className="spotlightCardLabel">{label}</p>
      <p className="spotlightCardFollower">{shortAddress(follower)}</p>
      <dl className="spotlightStats">
        <div>
          <dt>amount</dt>
          <dd className="spotlightCardAmount">
            {kind === "copied" ? formatUSDC(receipt.usdcAmount) : "…"}
            {kind === "copied" && <span className="spotlightCardAmountUnit">USDC</span>}
          </dd>
        </div>
        {receipt.status === "copied" && (
          <div>
            <dt>asset out</dt>
            <dd>{formatAsset(receipt.assetAmountOut)} ARCETH</dd>
          </div>
        )}
        {receipt.status === "copied" && receipt.mirrorFeeUSDC > 0n && (
          <div>
            <dt>mirror fee</dt>
            <dd>{formatUSDC(receipt.mirrorFeeUSDC)} USDC</dd>
          </div>
        )}
        {receipt.status === "copied" && receipt.gatewaySettlement?.status === "settled" && (
          <div>
            <dt>Gateway</dt>
            <dd>{receipt.gatewaySettlement.feeUSDC} USDC settled</dd>
          </div>
        )}
        {receipt.status === "blocked" && (
          <div>
            <dt>rule fired</dt>
            <dd>{receipt.reason}</dd>
          </div>
        )}
      </dl>
      <p className="spotlightDetail">{detail}</p>
      <a className="spotlightLink" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer noopener">
        on-chain receipt · {shortAddress(receipt.transactionHash)} →
      </a>
    </article>
  );
}

function totalMirrored(receipts: ReceiptLog[]): bigint {
  return receipts.reduce((total, receipt) => total + receipt.usdcAmount, 0n);
}

function totalKickbacks(state: ShadowState | null): bigint {
  return state?.sources.reduce((total, source) => total + source.kickbackUSDC, 0n) || 0n;
}

function BuilderFeesBanner({ state }: { state: ShadowState | null }) {
  const totalFees = totalKickbacks(state);
  const sourceCount = state?.sources.length || 0;
  const topSource = useMemo(() => {
    if (!state) return null;
    return [...state.sources].sort((a, b) =>
      a.kickbackUSDC === b.kickbackUSDC ? 0 : a.kickbackUSDC < b.kickbackUSDC ? 1 : -1,
    )[0];
  }, [state]);
  return (
    <section className="builderFees">
      <div className="builderFeesMain">
        <p className="eyebrow">source fees accrued onchain</p>
        <h2>
          <span className="builderFeesAmount">{formatUSDC(totalFees)}</span>
          <span className="builderFeesUnit">USDC</span>
        </h2>
        <p className="builderFeesCaption">
          70% of every mirror fee accrues to the source agent that routed the flow, settled by{" "}
          <code>MirrorRouter</code> at the receipt event from {sourceCount === 1 ? "one source" : `${sourceCount} sources`}.
          No off-chain accounting.
        </p>
        <p className="builderFeesReference">
          Shadow calls these <strong>mirror fees</strong>: source agents that route useful intent flow earn a share of the routed fee at the same moment followers receive copied or blocked receipts.
        </p>
      </div>
      {topSource && totalFees > 0n && (
        <div className="builderFeesTop">
          <p>top earner</p>
          <strong>{topSource.name}</strong>
          <span>{formatUSDC(topSource.kickbackUSDC)} USDC</span>
        </div>
      )}
    </section>
  );
}

const PILOT_STAGES: Array<{ label: string; at: number }> = [
  { label: "Reading onchain reputation for every source agent", at: 0 },
  { label: "Asking deepseek to allocate your deposit across the best fits", at: 2.5 },
  { label: "Normalizing weights and matching presets to risk", at: 18 },
  { label: "Hashing decision and preparing onchain attestation", at: 22 },
];

function PilotThinking() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 120);
    return () => clearInterval(id);
  }, []);
  const cappedPct = Math.min(95, (elapsed / 25) * 100);
  const activeIdx = PILOT_STAGES.reduce((acc, st, i) => (elapsed >= st.at ? i : acc), 0);
  return (
    <div className="pilotThinking" role="status" aria-live="polite">
      <div className="pilotThinkingHeader">
        <span className="pilotThinkingDot" />
        <strong>Pilot is reasoning</strong>
        <span className="pilotThinkingClock">{elapsed.toFixed(1)}s</span>
      </div>
      <div className="pilotThinkingBar">
        <span style={{ width: `${cappedPct}%` }} />
      </div>
      <ol className="pilotThinkingSteps">
        {PILOT_STAGES.map((st, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <li
              key={st.label}
              className={`pilotThinkingStep ${done ? "done" : ""} ${active ? "active" : ""}`}
            >
              <span className="pilotThinkingMark" aria-hidden>
                {done ? "✓" : active ? "" : ""}
              </span>
              <span>{st.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="pilotThinkingNote">
        Bankr LLM round trips take 20 to 25 seconds for structured allocations. Heuristic fallback runs if the model
        stalls.
      </p>
    </div>
  );
}

function PilotCard({
  amount,
  onAmountChange,
  risk,
  onRiskChange,
  plan,
  loading,
  error,
  executing,
  onRun,
  onExecute,
  sourcesCount,
}: {
  amount: string;
  onAmountChange: (v: string) => void;
  risk: PilotRisk;
  onRiskChange: (v: PilotRisk) => void;
  plan: PilotPlan | null;
  loading: boolean;
  error: string | null;
  executing: boolean;
  onRun: () => Promise<void>;
  onExecute: () => Promise<void>;
  sourcesCount: number;
}) {
  const riskOptions: Array<{ key: PilotRisk; label: string; sub: string }> = [
    { key: "low", label: "Low", sub: "Conservative slices, single source." },
    { key: "balanced", label: "Balanced", sub: "Diversify across 2 sources." },
    { key: "high", label: "High", sub: "Up to 3 sources, aggressive presets." },
  ];
  return (
    <section className="pilot" id="pilot">
      <header className="pilotHeader">
        <p className="eyebrow">AI pilot</p>
        <h2>Tell the AI your size and risk. It picks, weights, and watches.</h2>
        <p className="pilotLede">
          The Pilot reads every source agent's onchain reputation, allocates your USDC across the best fits, and writes
          watch signals you can act on. You stop manually picking and become a depositor with a goal.
        </p>
      </header>

      <div className="pilotControls">
        <label className="pilotField">
          <span>Deposit (USDC)</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder="1"
          />
        </label>
        <div className="pilotRiskGroup" role="radiogroup" aria-label="Risk profile">
          {riskOptions.map((opt) => (
            <button
              key={opt.key}
              className={`pilotRiskOption ${risk === opt.key ? "selected" : ""}`}
              onClick={() => onRiskChange(opt.key)}
              type="button"
              role="radio"
              aria-checked={risk === opt.key}
            >
              <strong>{opt.label}</strong>
              <span>{opt.sub}</span>
            </button>
          ))}
        </div>
        <button
          className="pilotRunBtn"
          onClick={onRun}
          disabled={loading || sourcesCount === 0}
          type="button"
        >
          {loading ? "asking the pilot…" : plan ? "regenerate plan" : "generate plan"}
        </button>
      </div>

      {loading && <PilotThinking />}

      {error && <div className="pilotError">pilot error: {error}</div>}

      {plan && (
        <div className="pilotPlan">
          <div className="pilotPlanHeader">
            <p className="pilotHeadline">{plan.headline}</p>
            <div className="pilotMeta">
              <span className="pilotConfidence">
                confidence <strong>{(plan.confidenceBps / 100).toFixed(0)}%</strong>
              </span>
              <span className="pilotModel">
                {plan.fellBack ? "heuristic fallback" : `model · ${plan.model}`}
              </span>
            </div>
          </div>

          <p className="pilotRationale">{plan.rationale}</p>

          <div className="pilotAllocation">
            {plan.allocation.map((slice) => (
              <article className="pilotSlice" key={slice.sourceAddress}>
                <header>
                  <strong>{slice.name}</strong>
                  <span className="pilotSlicePct">{(slice.weightBps / 100).toFixed(0)}%</span>
                </header>
                <div className="pilotSliceBar">
                  <span style={{ width: `${slice.weightBps / 100}%` }} />
                </div>
                <dl>
                  <div>
                    <dt>allocate</dt>
                    <dd>{slice.amountUSDC || "0"} USDC</dd>
                  </div>
                  <div>
                    <dt>preset</dt>
                    <dd className={`pilotPreset pilotPreset--${slice.preset}`}>{slice.preset}</dd>
                  </div>
                </dl>
                {slice.reason && <p className="pilotSliceReason">{slice.reason}</p>}
              </article>
            ))}
          </div>

          {plan.watchSignals.length > 0 && (
            <div className="pilotWatch">
              <p className="eyebrow">watch signals · the pilot will revisit if</p>
              <ul>
                {plan.watchSignals.map((sig, i) => (
                  <li key={i}>{sig}</li>
                ))}
              </ul>
            </div>
          )}

          <footer className="pilotFooter">
            <div className="pilotDecision">
              <span className="eyebrow">decision hash</span>
              <code>{plan.decisionHash}</code>
            </div>
            <button
              className="pilotExecBtn"
              onClick={onExecute}
              disabled={executing || plan.allocation.length === 0}
              type="button"
            >
              {executing ? "executing plan…" : "execute plan onchain"}
            </button>
          </footer>

          {plan.fellBack && plan.fellBackReason && (
            <p className="pilotFallbackNote">
              LLM unavailable ({plan.fellBackReason}); allocation produced by deterministic heuristic. Set
              BANKR_LLM_KEY to enable model reasoning.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

type SourceHealth = {
  source: SourceAgent;
  status: "healthy" | "watch" | "stop";
  recentCopies: number;
  recentBlocks: number;
  recentCopyRateBps: number;
  recentPnlAvgBps: number | null;
  signals: string[];
};

const HEALTH_WINDOW = 8;

function assessFollowedSources(
  state: ShadowState,
  account: Address,
  userFollows: Set<string>,
): SourceHealth[] {
  const acct = account.toLowerCase();
  return state.sources
    .filter((src) => userFollows.has(src.address.toLowerCase()))
    .map((source) => {
      const srcKey = source.address.toLowerCase();
      const myReceipts = state.receipts
        .filter((r) => r.sourceAgent.toLowerCase() === srcKey && r.follower.toLowerCase() === acct)
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, HEALTH_WINDOW);
      const recentCopies = myReceipts.filter((r) => r.status === "copied").length;
      const recentBlocks = myReceipts.filter((r) => r.status === "blocked").length;
      const totalRecent = recentCopies + recentBlocks;
      const recentCopyRateBps = totalRecent === 0 ? 0 : Math.round((recentCopies / totalRecent) * 10_000);

      const myCloses = state.positionCloses.filter(
        (c) => c.sourceAgent.toLowerCase() === srcKey && c.follower.toLowerCase() === acct,
      );
      const recentCloses = myCloses
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, HEALTH_WINDOW);
      const recentPnlAvgBps =
        recentCloses.length === 0
          ? null
          : Number(recentCloses.reduce((sum, c) => sum + c.pnlBps, 0n)) / recentCloses.length;

      const signals: string[] = [];
      let status: SourceHealth["status"] = "healthy";

      if (totalRecent === 0) {
        signals.push(`No recent receipts in the last ${HEALTH_WINDOW} intents for your wallet on this source.`);
      } else if (recentCopyRateBps < 5_000) {
        status = "watch";
        signals.push(
          `Only ${(recentCopyRateBps / 100).toFixed(0)}% of recent intents copied for your policy. Loosen minBpsOut or raise daily cap.`,
        );
      }
      if (recentPnlAvgBps !== null) {
        if (recentPnlAvgBps < -200) {
          status = "stop";
          signals.push(
            `Recent realized PnL is ${recentPnlAvgBps.toFixed(0)} bps over ${recentCloses.length} closes. Consider unfollowing.`,
          );
        } else if (recentPnlAvgBps < 0) {
          status = "watch";
          signals.push(
            `Recent realized PnL is ${recentPnlAvgBps.toFixed(0)} bps over ${recentCloses.length} closes. Watch the next close.`,
          );
        }
      }

      return {
        source,
        status,
        recentCopies,
        recentBlocks,
        recentCopyRateBps,
        recentPnlAvgBps,
        signals,
      };
    });
}

function PilotMonitor({
  state,
  account,
  userFollows,
  plan,
  onRerun,
  loading,
}: {
  state: ShadowState;
  account: Address;
  userFollows: Set<string>;
  plan: PilotPlan | null;
  onRerun: () => Promise<void>;
  loading: boolean;
}) {
  const assessments = useMemo(
    () => assessFollowedSources(state, account, userFollows),
    [state, account, userFollows],
  );
  if (assessments.length === 0) return null;
  const anyWatch = assessments.some((a) => a.status !== "healthy");
  const planAge = plan ? Math.max(0, Math.floor(Date.now() / 1000) - plan.generatedAt) : null;
  return (
    <section className="pilotMonitor">
      <header className="pilotMonitorHeader">
        <div>
          <p className="eyebrow">AI monitor · fresh look at your follows</p>
          <h2>The pilot watches every source you follow against live state.</h2>
          <p className="pilotMonitorLede">
            Each card reweighs the last {HEALTH_WINDOW} intents and any closed positions touching your wallet. When a
            slice drifts off plan, the monitor flags it and offers a re evaluation that bakes the latest receipts back
            into the next pilot decision.
          </p>
        </div>
        <button
          className="pilotMonitorRerun"
          onClick={onRerun}
          disabled={loading}
          type="button"
        >
          {loading ? "re-evaluating…" : anyWatch ? "re-evaluate plan" : "ask for a fresh plan"}
        </button>
      </header>

      <div className="pilotMonitorGrid">
        {assessments.map((a) => (
          <article className={`pilotMonitorCard pilotMonitorCard--${a.status}`} key={a.source.address}>
            <header>
              <strong>{a.source.name}</strong>
              <span className={`pilotMonitorBadge pilotMonitorBadge--${a.status}`}>{statusLabel(a.status)}</span>
            </header>
            <dl>
              <div>
                <dt>recent copies</dt>
                <dd>
                  {a.recentCopies}
                  <span className="pilotMonitorMuted"> / {a.recentCopies + a.recentBlocks}</span>
                </dd>
              </div>
              <div>
                <dt>copy rate</dt>
                <dd>{a.recentCopies + a.recentBlocks === 0 ? "…" : `${(a.recentCopyRateBps / 100).toFixed(0)}%`}</dd>
              </div>
              <div>
                <dt>recent PnL avg</dt>
                <dd>{a.recentPnlAvgBps === null ? "…" : `${a.recentPnlAvgBps.toFixed(0)} bps`}</dd>
              </div>
            </dl>
            {a.signals.length > 0 && (
              <ul className="pilotMonitorSignals">
                {a.signals.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>

      {plan && planAge !== null && (
        <footer className="pilotMonitorFooter">
          <span>
            anchored plan ·{" "}
            <code>
              {plan.decisionHash.slice(0, 10)}…{plan.decisionHash.slice(-6)}
            </code>{" "}
            · {ageLabel(planAge)} ago · confidence {(plan.confidenceBps / 100).toFixed(0)}%
          </span>
        </footer>
      )}
    </section>
  );
}

function statusLabel(status: SourceHealth["status"]): string {
  if (status === "healthy") return "healthy";
  if (status === "watch") return "watch";
  return "stop";
}

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function SplitMomentFallback() {
  return (
    <section className="spotlight spotlight--fallback" id="split">
      <p className="eyebrow">adapter one · same intent · two outcomes</p>
      <h2>One source intent lands. Policy decides whether capital moves.</h2>
      <p className="spotlightSummary">
        A source agent on Arc just published a 0.02 USDC intent. Two followers were watching with different rules.
        One had room. One didn&apos;t. This is the original receipt pattern now extended into Float and protocol mandates.
      </p>
      <div className="spotlightGrid">
        <article className="spotlightCard copied spotlightCard--demo">
          <div className="spotlightCardStamp">
            <span className="spotlightCardStampMark">✓</span>
            <span className="spotlightCardStampText">COPIED</span>
          </div>
          <p className="spotlightCardLabel">Copied follower · policy let it through</p>
          <p className="spotlightCardFollower">0x7A3F…3AcD</p>
          <dl className="spotlightStats">
            <div>
              <dt>amount</dt>
              <dd className="spotlightCardAmount">0.02 <span className="spotlightCardAmountUnit">USDC</span></dd>
            </div>
            <div>
              <dt>max per intent</dt>
              <dd>0.05 USDC</dd>
            </div>
            <div>
              <dt>slippage rule</dt>
              <dd>≥ 70 bps out</dd>
            </div>
          </dl>
          <p className="spotlightDetail">Within size, slippage, and daily cap. Swap went through, receipt on chain.</p>
        </article>
        <div className="spotlightVs" aria-hidden="true">
          <span className="spotlightVsLine" />
          <span className="spotlightVsLabel">VS</span>
          <span className="spotlightVsLine" />
        </div>
        <article className="spotlightCard blocked spotlightCard--demo">
          <div className="spotlightCardStamp">
            <span className="spotlightCardStampMark">✕</span>
            <span className="spotlightCardStampText">BLOCKED</span>
          </div>
          <p className="spotlightCardLabel">Blocked follower · policy refused</p>
          <p className="spotlightCardFollower">0x495c…8695</p>
          <dl className="spotlightStats">
            <div>
              <dt>amount</dt>
              <dd className="spotlightCardAmount">…</dd>
            </div>
            <div>
              <dt>max per intent</dt>
              <dd>0.01 USDC</dd>
            </div>
            <div>
              <dt>rule fired</dt>
              <dd>amount_too_high</dd>
            </div>
          </dl>
          <p className="spotlightDetail">Block receipt on chain, no debit. Follower stays exactly where they were.</p>
        </article>
      </div>
      <p className="spotlightFootnote">
        Live receipts populate this card once the next cron fires. The block reason on real receipts is whichever rule your
        policy hit first.
      </p>
    </section>
  );
}

function Shadow2ProofStrip({
  floatState,
  leptonState,
  copiedCount,
  blockedCount,
}: {
  floatState: FloatState | null;
  leptonState: LeptonState | null;
  copiedCount: number;
  blockedCount: number;
}) {
  const agentLoop = floatState?.sourceBreakdown?.agentLoop;
  const mirrorLoaded = copiedCount + blockedCount > 0;
  const cards = [
    {
      label: "Shadow Float",
      metric: agentLoop?.cycles !== undefined ? `${agentLoop.cycles}` : "syncing",
      unit: "agent-loop cycles",
      title: "Behavior becomes spending power",
      body: "A verified agent receives bounded USDC capacity, buys approved provider resources, opens debt, and gets blocked when it overreaches.",
      to: "/float",
      tone: "float",
    },
    {
      label: "Mandate Engine",
      metric: leptonState?.receiptCount !== undefined ? leptonState.receiptCount.toString() : "syncing",
      unit: "mandate receipts",
      title: "Capital moves only after policy clears",
      body: "The same engine gates swap-style and vault-style actions with ALLOW/BLOCK receipts and bonded enforcement.",
      to: "/lepton",
      tone: "mandate",
    },
    {
      label: "Mirror Adapter",
      metric: mirrorLoaded ? `${copiedCount}/${blockedCount}` : "syncing",
      unit: "copied / blocked",
      title: "The first production-style receipt rail",
      body: "Copy trading stays visible as historical demand context: one source intent, per-user policy, no cascade revert.",
      to: "/receipts",
      tone: "mirror",
    },
  ];

  return (
    <section className="shadow2Strip" aria-label="Shadow 2.0 product surfaces">
      <div className="shadow2StripHeader">
        <p className="eyebrow">Shadow Float product map</p>
        <h2>The Float product, with earlier receipt rails underneath.</h2>
      </div>
      <div className="shadow2StripGrid">
        {cards.map((card) => (
          <Link className={`shadow2ProofCard shadow2ProofCard--${card.tone}`} to={card.to} key={card.label}>
            <span className="shadow2ProofLabel">{card.label}</span>
            <strong className="shadow2ProofMetric">{card.metric}</strong>
            <span className="shadow2ProofUnit">{card.unit}</span>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
            <span className="shadow2ProofLink">open record →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function ShadowMark() {
  return (
    <svg className="shadowMark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" className="shadowMarkBack" />
      <rect x="11" y="11" width="16" height="16" rx="2" className="shadowMarkFront" />
      <rect x="15" y="15" width="8" height="8" className="shadowMarkCore" />
    </svg>
  );
}

function HeroDiagram() {
  return (
    <div className="heroLedger" aria-hidden="true">
      <div className="heroLedgerHeader">
        <span className="heroLedgerHeaderTitle">
          <span className="heroLedgerHeaderDot" />
          Shadow Float · external lifecycle
        </span>
        <span className="heroLedgerLive">
          <span className="heroLedgerLiveDot" />
          Arc · V2 receipt
        </span>
      </div>

      <div className="heroLedgerIntent">
        <span className="heroLedgerIntentLabel">Argus Alpha signed intent</span>
        <div className="heroLedgerIntentBody">
          <span className="agentTag">Argus</span>
          <span className="heroLedgerIntentVerb">buy</span>
          <span className="heroLedgerIntentNumber">CitePay answer</span>
          <span className="heroLedgerIntentArrow">→</span>
          <span className="heroLedgerIntentNumber">0.001&nbsp;USDC</span>
        </div>
      </div>

      <div className="heroLedgerSplit">
        <div className="heroLedgerCell copied">
          <div className="heroLedgerCellHead">
            <span className="heroLedgerCellStatus">
              <span className="heroLedgerCellDot" />
              PAID
            </span>
            <span className="heroLedgerCellAddr">CitePay provider</span>
          </div>
          <div className="heroLedgerCellMain">+0.001</div>
          <div className="heroLedgerCellUnit">USDC paid from sponsor reserve</div>
          <div className="heroLedgerCellMeta">
            <span className="heroLedgerCellMetaLabel">receipt</span>
            <span className="heroLedgerCellMetaValue">intent consumed · answer served · debt opened</span>
          </div>
        </div>
        <div className="heroLedgerCell settled">
          <div className="heroLedgerCellHead">
            <span className="heroLedgerCellStatus">
              <span className="heroLedgerCellDot" />
              REPAID
            </span>
            <span className="heroLedgerCellAddr">same agent line</span>
          </div>
          <div className="heroLedgerCellMain">0.001</div>
          <div className="heroLedgerCellUnit">USDC returned to Float</div>
          <div className="heroLedgerCellMeta">
            <span className="heroLedgerCellMetaLabel">line state</span>
            <span className="heroLedgerCellMetaValue">debt cleared · capacity restored · score refreshed</span>
          </div>
        </div>
      </div>

      <div className="heroLedgerProof">
        <span className="heroLedgerProofLabel">Float receipt</span>
        <span className="heroLedgerProofHash">Argus Alpha + CitePay + repayment</span>
        <span className="heroLedgerProofSep" />
        <span className="heroLedgerProofChain">chain&nbsp;5042002</span>
        <span className="heroLedgerProofVerify">live receipt</span>
      </div>
    </div>
  );
}

function SiteFooter() {
  const sections: Array<{ title: string; links: Array<{ label: string; href: string }> }> = [
    {
      title: "Product",
      links: [
        { label: "Home", href: "/" },
        { label: "Shadow Float", href: "/float" },
        { label: "Records", href: "/treasury" },
        { label: "Roadmap", href: "/roadmap" },
      ],
    },
    {
      title: "Resources",
      links: [
        { label: "V2 source match", href: FLOAT_V2_PROOF.sourcify },
        { label: "V2 spend tx", href: txUrl(FLOAT_V2_PROOF.directSpendTx) },
        { label: "Arc explorer", href: "https://testnet.arcscan.app" },
      ],
    },
    {
      title: "Builders",
      links: [
        { label: "Builder guide", href: "/builders" },
        { label: "Strict V2 verifier", href: "https://github.com/dolepee/shadow" },
        { label: "Source on GitHub", href: "https://github.com/dolepee/shadow" },
      ],
    },
  ];

  return (
    <footer className="siteFooter">
      <div className="siteFooterTop">
        <div className="siteFooterBrand">
          <Link className="brand brandFooter" to="/" aria-label="Shadow">
            <ShadowMark />
            <span>Shadow</span>
          </Link>
          <p className="siteFooterTagline">
            Sponsor-backed USDC capacity for agents on Arc, with signed intents, provider payment, repayment, and blocked
            overruns.
          </p>
          <div className="siteFooterBadge">
            <span className="heroBadgeDot" />
            live on arc testnet · chain 5042002
          </div>
        </div>
        <div className="siteFooterColumns">
          {sections.map((s) => (
            <div className="siteFooterColumn" key={s.title}>
              <span className="siteFooterColumnTitle">{s.title}</span>
              {s.links.map((l) => {
                if (l.href.startsWith("http") || l.href.startsWith("/api")) {
                  return (
                    <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                    </a>
                  );
                }
                return (
                  <Link key={l.label} to={l.href}>
                    {l.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="siteFooterBottom">
        <span>Built on Arc testnet with Circle USDC · 2026</span>
        <span>Shadow Float V2 · spending lines, controls, and receipts on Arc</span>
      </div>
    </footer>
  );
}

function HomeTruthStrip({
  floatState,
  deskState,
  deskLoading,
}: {
  floatState: FloatV2ActivityState | null;
  deskState: FloatDeskState | null;
  deskLoading: boolean;
}) {
  const deskCycles = deskState?.counts?.cycles;
  const externalLines = floatState?.summary?.registeredExternalLines;
  const showCount = (value: number | undefined, fallback: string) => (value === undefined ? fallback : String(value));
  const truths: Array<
    { label: string; value: string; body: string; to: string; href?: never } |
    { label: string; value: string; body: string; href: string; to?: never }
  > = [
    {
      label: "desk decides",
      value: showCount(deskCycles, deskLoading ? "reading" : "live"),
      body: "Rationale digest becomes the onchain requestHash.",
      to: "/float#desk-journal",
    },
    {
      label: "outside graph",
      value: showCount(externalLines, "9"),
      body: "External agents and external sponsors are visible.",
      to: "/float#v2-activity",
    },
    {
      label: "verifier",
      value: "26",
      body: "Live checks run against the public Arc RPC.",
      href: "https://github.com/dolepee/shadow",
    },
  ];

  return (
    <div className="homeTruthStrip" aria-label="Shadow Float live proof summary">
      {truths.map((truth) => {
        const content = (
          <>
            <span>{truth.label}</span>
            <strong>{truth.value}</strong>
            <p>{truth.body}</p>
          </>
        );
        return "href" in truth ? (
          <a className="homeTruthItem" href={truth.href} target="_blank" rel="noreferrer" key={truth.label}>
            {content}
          </a>
        ) : (
          <Link className="homeTruthItem" to={truth.to} key={truth.label}>
            {content}
          </Link>
        );
      })}
    </div>
  );
}

function HomeProofOverview({
  state,
  loading,
  error,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
  error: string | null;
}) {
  const summary = state?.summary;
  const topContractScore = (state?.agents || []).reduce((max, agent) => Math.max(max, agent.autonomousScore?.score ?? agent.score ?? 0), 0);
  const isSnapshot = state?.source === "verified-snapshot";
  const countValue = (value: number | undefined) => {
    if (value !== undefined) return String(value);
    if (error) return "unavailable";
    return loading ? "reading" : "not loaded";
  };
  const statusLabel = isSnapshot ? (loading ? "syncing live V2" : "verified snapshot") : error ? "V2 read failed" : loading && !state ? "reading V2" : "Float V2 live";
  const statusClass = error && !isSnapshot ? "error" : "live";
  const cards = [
    {
      eyebrow: "current contract",
      value: shortAddress(FLOAT_V2_CONTRACT),
      label: "Sourcify matched",
      body: "V2 source is matched to the deployed Arc bytecode, so the signed-intent checks are inspectable.",
      href: FLOAT_V2_PROOF.sourcify,
      external: true,
    },
    {
      eyebrow: "external lines",
      value: countValue(summary?.registeredExternalLines),
      label: "registered agents",
      body: "External builders can give their agents sponsor-backed capacity without sending keys, gas, or approvals to Shadow.",
      href: "/float#v2-activity",
      external: false,
    },
    {
      eyebrow: "external sponsor capital",
      value: "2",
      label: "external sponsors",
      body: "CitePay keeps a live external reserve open. Forum Tollgate completed sponsor, spend, repay, and reserve reclaim.",
      href: txUrl(FLOAT_V2_PROOF.citePaySponsorOpenTx),
      external: true,
    },
    {
      eyebrow: "closed loops",
      value: countValue(summary?.repaidLifecycles),
      label: "spend and repay",
      body: "Closed rows show signed intent, provider payment, debt, and repayment. Open debt is shown separately.",
      href: "/float#v2-activity",
      external: false,
    },
    {
      eyebrow: "open debt line",
      value: countValue(summary?.openDebtAgents),
      label: "open debt shown",
      body: "Open debt stays visible until the agent repays, so the board shows both completed loops and active exposure.",
      href: txUrl(FLOAT_V2_PROOF.obolSpendTx),
      external: true,
    },
    {
      eyebrow: "external agent fleet",
      value: "Argus x3",
      label: "four closed loops",
      body: "Argus Alpha, Beta, and Gamma ran the V2 path, then Alpha used Float again to buy a CitePay answer and repay.",
      href: txUrl(FLOAT_V2_PROOF.argusCitePayRepayTx),
      external: true,
    },
    {
      eyebrow: "autonomous scoring",
      value: topContractScore > 0 ? String(topContractScore) : countValue(undefined),
      label: "contract scored",
      body: "Sponsored lines are re-scored by ShadowFloat from paid, blocked, and repaid behavior, not by an owner script.",
      href: "/float#v2-activity",
      external: false,
    },
    {
      eyebrow: "provider proof",
      value: "CitePay",
      label: "provider paid by Float",
      body: "CitePay accepted an Argus-signed Float payment and returned a query receipt, then Argus repaid the line.",
      href: txUrl(FLOAT_V2_PROOF.argusCitePaySpendTx),
      external: true,
    },
  ];

  return (
    <section className="homeProofOverview" aria-label="Shadow Float live product activity">
      <div className="homeProofHeader">
        <div>
          <p className="eyebrow">live Float activity</p>
          <h2>External agents are using sponsor-backed lines on Float V2.</h2>
        </div>
        <div className={`homeProofStatus ${statusClass}`}>
          <span className="homeProofStatusDot" />
          {statusLabel}
        </div>
      </div>
      <div className="homeProofGrid">
        {cards.map((card) => {
          const content = (
            <>
              <span>{card.eyebrow}</span>
              <strong>{card.value}</strong>
              <em>{card.label}</em>
              <p>{card.body}</p>
            </>
          );
          return card.external ? (
            <a className="homeProofCard" href={card.href} target="_blank" rel="noreferrer" key={card.eyebrow}>
              {content}
            </a>
          ) : (
            <Link className="homeProofCard" to={card.href} key={card.eyebrow}>
              {content}
            </Link>
          );
        })}
      </div>
      <div className="homeProofLinks">
        <Link to="/float">Open Float</Link>
        <a href="/api/float?mode=v2" target="_blank" rel="noreferrer">Open V2 activity API</a>
        <a href={FLOAT_V2_PROOF.sourcify} target="_blank" rel="noreferrer">View source match</a>
        <a href="https://github.com/dolepee/shadow" target="_blank" rel="noreferrer">View repository</a>
      </div>
    </section>
  );
}

function HeroMetrics({
  state,
  loading,
  error,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
  error: string | null;
}) {
  const summary = state?.summary;
  const isSnapshot = state?.source === "verified-snapshot";
  const countValue = (value: number | undefined) => {
    if (value !== undefined) return String(value);
    if (error) return "n/a";
    return loading ? "..." : "n/a";
  };
  const items: Array<{ label: string; value: string }> = [
    { label: "external lines", value: countValue(summary?.registeredExternalLines) },
    { label: "signed intents", value: countValue(summary?.signedIntents) },
    { label: "closed loops", value: countValue(summary?.repaidLifecycles) },
    { label: "open debt lines", value: countValue(summary?.openDebtAgents) },
  ];

  return (
    <div className="heroMetricsWrap" role="group" aria-label="Current Shadow Float V2 anchors on Arc testnet">
      <div className="heroMetrics">
        {items.map((m) => (
          <div className="heroMetric" key={m.label}>
            <span className="heroMetricValue">{m.value}</span>
            <span className="heroMetricLabel">{m.label}</span>
          </div>
        ))}
      </div>
      <span className="heroMetricsNote">
        {isSnapshot
          ? "Showing the last verified V2 snapshot while the live feed syncs."
          : error
            ? "Float V2 counters are temporarily unavailable."
            : "Live counters come from the current Float V2 activity feed."}
      </span>
    </div>
  );
}

function TractionStrip({ state }: { state: ShadowState | null }) {
  const metrics = state?.lifetime;
  const recent = state?.recentWindow;

  const metricsList: Array<{ label: string; value: string; sub: string }> = [
    {
      label: "Follower wallets",
      value: metrics?.followerWallets.toLocaleString() ?? "0",
      sub: "since launch, snapshot-anchored",
    },
    {
      label: "USDC mirrored",
      value: metrics ? formatUSDC(metrics.mirroredUsdcAtomic) : "0",
      sub: `${metrics?.copied.toLocaleString() ?? "0"} copied · ${metrics?.blocked.toLocaleString() ?? "0"} blocked`,
    },
    {
      label: "Source agents",
      value: metrics?.sourceAgents.toLocaleString() ?? "0",
      sub: "registered source agents",
    },
    {
      label: "Receipts onchain",
      value: metrics?.receipts.toLocaleString() ?? "0",
      sub: "copy and block, no offchain truth",
    },
    {
      label: "Positions closed",
      value: metrics?.closedPositions.toLocaleString() ?? "0",
      sub: "realized close receipts",
    },
  ];

  const hasAnyTraction = Boolean(metrics && metrics.receipts > 0);

  if (!hasAnyTraction) {
    return null;
  }

  return (
    <section className="traction" aria-label="Live traction">
      <div className="tractionHeader">
        <p className="eyebrow">the full picture · lifetime floor plus live deltas</p>
        <span className="tractionDot" /> <span className="tractionLive">snapshot anchored</span>
      </div>
      <div className="tractionGrid">
        {metricsList.map((m) => (
          <article className="tractionCard" key={m.label}>
            <span className="tractionLabel">{m.label}</span>
            <strong className="tractionValue">{m.value}</strong>
            <span className="tractionSub">{m.sub}</span>
          </article>
        ))}
      </div>
      <p className="tractionFootnote">
        Lifetime totals use the May 24, 2026 submission snapshot as a floor, then add receipts after block{" "}
        {metrics?.snapshotBlock}. The live feed is intentionally recent-window only
        {recent
          ? ` (${recent.receipts.toLocaleString()} receipts from blocks ${recent.fromBlock}-${recent.toBlock}${
              recent.historyTruncated ? ", pruned history hidden" : ""
            })`
          : ""}
        .
      </p>
    </section>
  );
}

function TechnicalPrimitive({ state }: { state: ShadowState | null }) {
  const copiedReceipts = state?.receipts.filter((r) => r.status === "copied").length || 0;
  const blockedReceipts = state?.receipts.filter((r) => r.status === "blocked").length || 0;
  const closedPositions = state?.positionCloses.length || 0;
  const sourcesRegistered = state?.sources.length || 0;
  const cards = [
    {
      eyebrow: "primitive · per follower slippage",
      title: "Two outcomes, one transaction",
      body: "Every follower carries their own minBpsOut policy onchain. The router fans out one source intent and decides copy or block per follower in the same call. No cascade reverts, no off chain matcher.",
      metric: `${copiedReceipts} copied · ${blockedReceipts} blocked`,
      contract: "ShadowRouter.fanOut",
    },
    {
      eyebrow: "primitive · ERC 8004-style source reference",
      title: "Source agents are first class onchain",
      body: "Each source agent registers an onchain identity with a public address, name, and fee split. Reputation is computable from chain state alone, no centralized leaderboard.",
      metric: `${sourcesRegistered} source agent${sourcesRegistered === 1 ? "" : "s"} registered`,
      contract: "ShadowRegistry.registerSource",
    },
    {
      eyebrow: "primitive · canonical receipts",
      title: "MirrorReceipt is the source of truth",
      body: "Both copied and blocked outcomes emit onchain receipts with usdcAmount, minBps applied, and the kickback paid. Every decision is independently verifiable by reading chain state.",
      metric: `${copiedReceipts + blockedReceipts} receipts indexed`,
      contract: "MirrorReceipt event",
    },
    {
      eyebrow: "primitive · onchain PnL",
      title: "PositionClosed carries pnlBps",
      body: "When a follower closes a mirrored position, the router emits PositionClosed with the realized pnlBps. Source agent track records resolve directly from chain logs.",
      metric: `${closedPositions} position${closedPositions === 1 ? "" : "s"} closed`,
      contract: "PositionClosed event",
    },
  ];
  return (
    <section className="primitive" id="technical">
      <header className="primitiveHeader">
        <p className="eyebrow">why Shadow</p>
        <h2>The novelty is the reusable receipt engine, not the adapter.</h2>
        <p className="primitiveLede">
          The original router turns one AI intent into per-follower outcomes, but Shadow 2.0 carries the same pattern into
          float, x402 spend control, and protocol mandates. Every surface below is useful because it creates verifiable
          behavior that later capital can trust.
        </p>
      </header>
      <div className="primitiveGrid">
        {cards.map((card) => (
          <article className="primitiveCard" key={card.title}>
            <p className="eyebrow">{card.eyebrow}</p>
            <h3>{card.title}</h3>
            <p className="primitiveBody">{card.body}</p>
            <footer className="primitiveFooter">
              <span className="primitiveMetric">{card.metric}</span>
              <code className="primitiveContract">{card.contract}</code>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function LeptonM1Panel({
  state,
  loading,
  error,
  compact = false,
}: {
  state: LeptonState | null;
  loading: boolean;
  error: string | null;
  compact?: boolean;
}) {
  const configured = Boolean(isLeptonConfigured && state?.configured);
  const addressRows = [
    { label: "MandateRegistry", value: leptonAddresses.mandateRegistry },
    { label: "MandateAttestor", value: leptonAddresses.mandateAttestor },
    { label: "BondedEnforcer", value: leptonAddresses.bondedEnforcer },
    { label: "V4StyleArcAdapter", value: leptonAddresses.v4StyleAdapter },
    { label: "MandateVaultSink", value: state?.liquiditySink },
    { label: "MorphoStyleAdapter", value: leptonAddresses.morphoStyleAdapter },
    { label: "MorphoVaultSink", value: state?.morphoVaultSink },
  ];
  const proofSteps = [
    "Circle wallet is the scoped capital account",
    "MandateRegistry checks USDC, target, size, day cap, risk, expiry, and slippage",
    "MandateAttestor records ALLOW or BLOCK against the action hash",
    "V4StyleArcAdapter is swap-only and moves USDC only after an ALLOW receipt",
    "MandateVaultSink records the receipt-linked deposit",
    "Committed missing receipts can be challenged against the enforcer bond",
  ];
  const adapterSurfaces = [
    {
      name: "Uniswap v4-style swaps",
      status: configured ? "live" : "deploy pending",
      detail: "Pool-key execution refs bind currency pair, fee tier, tick spacing, hooks, and route salt.",
    },
    {
      name: "Morpho-style vault deposits",
      status: configured && state?.morphoConfigured ? "live" : "deploy pending",
      detail: "Deposit-only adapter gates USDC before vault movement through the same bonded enforcer.",
    },
  ];
  const circlePasskeyProof = {
    smartAccount: "0x6994ebdef63aa0e665e3c781ed54e2e181869a7a" as Address,
    txHash: "0x98b8b175d4ec8bf6d457d653383932e69d74300bd0b8a7e324e0cae3ac35a529" as `0x${string}`,
    mandateId: "2",
    amount: "0.01 USDC",
  };
  const morphoProof = {
    adapter: "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5" as Address,
    vault: "0x110f79c5617797b199d3d6e2abb855c34fbc5e58" as Address,
    mandateId: "3",
    allowTx: "0x9836e74ee95907847fac464f3a65554cf314adab9efe7141f4644022b3e09c17" as `0x${string}`,
    blockTx: "0x7d3dddd89dc50ea5b410564c7f1134ce1350fd3687e8cefec74192d9e9b4bd23" as `0x${string}`,
  };
  const updated = state ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <section className={`leptonPanel${compact ? " leptonPanelCompact" : ""}`} id="lepton-m1">
      <div className="leptonHeader">
        <div>
          <p className="eyebrow">Lepton M1 · protocol mandates</p>
          <h2>Mandates decide before USDC moves.</h2>
          <p className="leptonLede">
            The reusable primitive is simple: register a mandate, evaluate the action before USDC moves, write an ALLOW or
            BLOCK receipt, and keep the enforcer accountable across swap and vault-style adapters.
          </p>
        </div>
        <div className={`leptonStatus ${configured ? "configured" : "pending"}`}>
          <span className="leptonStatusDot" />
          {configured ? "live contract reads" : "deploy pending"}
          {loading && <small>syncing</small>}
        </div>
      </div>

      <div className="leptonMetricGrid">
        <LeptonMetric label="mandates" value={configured ? state!.mandateCount.toString() : "pending"} />
        <LeptonMetric label="receipts" value={configured ? state!.receiptCount.toString() : "pending"} />
        <LeptonMetric label="adapter bond" value={configured ? `${formatUSDC(state!.adapterBondUSDC)} USDC` : "pending"} />
        <LeptonMetric
          label="vault bond"
          value={
            configured && state!.morphoAdapterBondUSDC !== undefined
              ? `${formatUSDC(state!.morphoAdapterBondUSDC)} USDC`
              : "pending"
          }
        />
        <LeptonMetric label="minimum bond" value={configured ? `${formatUSDC(state!.minBondUSDC)} USDC` : "pending"} />
        <LeptonMetric label="allowed USDC" value={configured ? formatUSDC(state!.executedUSDC) : "0"} tone="allow" />
        <LeptonMetric
          label="vault recorded"
          value={configured && state!.vaultDepositedUSDC !== undefined ? formatUSDC(state!.vaultDepositedUSDC) : "pending"}
          tone="allow"
        />
        <LeptonMetric
          label="morpho allowed"
          value={configured && state!.morphoDepositedUSDC !== undefined ? formatUSDC(state!.morphoDepositedUSDC) : "pending"}
          tone="allow"
        />
        <LeptonMetric label="blocked USDC" value={configured ? formatUSDC(state!.blockedUSDC) : "0"} tone="block" />
        <LeptonMetric
          label="morpho blocked"
          value={configured && state!.morphoBlockedUSDC !== undefined ? formatUSDC(state!.morphoBlockedUSDC) : "pending"}
          tone="block"
        />
      </div>

      <div className="leptonGrid">
        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>contracts</span>
            {updated && <small>updated {updated}</small>}
          </div>
          <div className="leptonAddressList">
            {addressRows.map((row) => (
              <div className="leptonAddressRow" key={row.label}>
                <span>{row.label}</span>
                <code>{row.value ? shortAddress(row.value) : "not deployed"}</code>
              </div>
            ))}
          </div>
        </article>

        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>receipt chain</span>
            <small>{configured ? `next #${state!.nextReceiptId.toString()}` : "waiting for deploy"}</small>
          </div>
          <ol className="leptonProofList">
            {proofSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </article>

        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>protocol adapters</span>
            <small>one mandate engine</small>
          </div>
          <div className="leptonSurfaceList">
            {adapterSurfaces.map((surface) => (
              <div className="leptonSurfaceRow" key={surface.name}>
                <div>
                  <strong>{surface.name}</strong>
                  <p>{surface.detail}</p>
                </div>
                <code>{surface.status}</code>
              </div>
            ))}
          </div>
        </article>
      </div>

      {!compact && (
        <article className="leptonPasskeyProof">
          <div className="leptonBoxHeader">
            <span>Circle passkey transaction</span>
            <small>sponsored UserOp</small>
          </div>
          <div className="leptonProofFacts">
            <div>
              <span>Smart account</span>
              <code title={circlePasskeyProof.smartAccount}>{shortAddress(circlePasskeyProof.smartAccount)}</code>
            </div>
            <div>
              <span>Mandate</span>
              <strong>#{circlePasskeyProof.mandateId}</strong>
            </div>
            <div>
              <span>Allowed</span>
              <strong>{circlePasskeyProof.amount}</strong>
            </div>
            <div>
              <span>Tx</span>
              <a href={txUrl(circlePasskeyProof.txHash)} target="_blank" rel="noreferrer">
                {shortAddress(circlePasskeyProof.txHash)}
              </a>
            </div>
          </div>
          <p>
            Circle Gas Station sponsored one passkey-owned account to approve USDC, create a Lepton mandate, and execute
            the allowed adapter action that raised the receipt count and vault-recorded USDC.
          </p>
        </article>
      )}

      {!compact && (
        <article className="leptonPasskeyProof">
          <div className="leptonBoxHeader">
            <span>Morpho-style vault transaction</span>
            <small>live adapter</small>
          </div>
          <div className="leptonProofFacts">
            <div>
              <span>Adapter</span>
              <code title={morphoProof.adapter}>{shortAddress(morphoProof.adapter)}</code>
            </div>
            <div>
              <span>Mandate</span>
              <strong>#{morphoProof.mandateId}</strong>
            </div>
            <div>
              <span>Allowed / blocked</span>
              <strong>
                {configured && state!.morphoDepositedUSDC !== undefined && state!.morphoBlockedUSDC !== undefined
                  ? `${formatUSDC(state!.morphoDepositedUSDC)} / ${formatUSDC(state!.morphoBlockedUSDC)} USDC`
                  : "0.1 / 0.3 USDC"}
              </strong>
            </div>
            <div>
              <span>Txs</span>
              <a href={txUrl(morphoProof.allowTx)} target="_blank" rel="noreferrer">
                allow
              </a>
              {" / "}
              <a href={txUrl(morphoProof.blockTx)} target="_blank" rel="noreferrer">
                block
              </a>
            </div>
          </div>
          <p>
            The second protocol surface uses the same bonded enforcer as the v4-style adapter: one deposit-shaped action
            moved USDC after an ALLOW receipt, and one oversized deposit wrote a BLOCK receipt without moving funds.
          </p>
        </article>
      )}

      {error && <div className="leptonError">Lepton read failed: {error}</div>}

      {!compact && (
        <div className="leptonBoundaries">
          <span>v4-style adapter, not a claimed Uniswap hook</span>
          <span>Morpho-style adapter, not a claimed Morpho partnership</span>
          <span>objective missing-receipt slashing only</span>
          <span>deterministic policy; no LLM override</span>
        </div>
      )}
    </section>
  );
}

function LeptonMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`leptonMetric${tone ? ` ${tone}` : ""}`}>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function score(value: number): string {
  return `${(value / 100).toFixed(0)}%`;
}

type TraderPersona = { tagline: string; accent: string; tone: "cat" | "lobster" | "otter" | "neutral" };

function traderPersona(name: string): TraderPersona {
  const key = name.toLowerCase();
  if (key.includes("cat")) {
    return {
      tagline: "Spot arbitrage on the USDC / ARCETH pool",
      accent: "#c8ff5a",
      tone: "cat",
    };
  }
  if (key.includes("lobster")) {
    return {
      tagline: "Risk managed copy with tighter slippage",
      accent: "#ffb347",
      tone: "lobster",
    };
  }
  if (key.includes("otter") || key.includes("momentum")) {
    return {
      tagline: "LLM reasoned momentum, regime read every intent",
      accent: "#6ad1ff",
      tone: "otter",
    };
  }
  return { tagline: "Onchain source", accent: "#d8ff79", tone: "neutral" };
}

const SIGNAL_LABEL: Record<AgentSignal, string> = {
  healthy: "Healthy",
  watch: "Watch",
  stop: "Stop",
  warming: "Warming up",
};

function SignalBadge({ level, reason, compact = false }: { level: AgentSignal; reason?: string; compact?: boolean }) {
  return (
    <span className={`signalBadge signalBadge--${level}${compact ? " signalBadge--compact" : ""}`} title={reason}>
      <span className="signalBadgeDot" />
      {SIGNAL_LABEL[level]}
    </span>
  );
}

function SignalStrip({ rows }: { rows: EarnedReputation[] }) {
  if (rows.length === 0) return null;
  const signals = rows.map((row) => ({ row, ...agentSignal(row) }));
  return (
    <div className="signalStrip" role="group" aria-label="Per agent trust signal">
      <div className="signalStripHeader">
        <span className="signalStripDot" />
        <strong>Signal monitor</strong>
        <span className="signalStripHint">
          Shadow does not just copy agents. It watches when an agent stops being worth copying. Computed live from receipts and closes.
        </span>
      </div>
      <div className="signalStripGrid">
        {signals.map(({ row, level, reason }) => (
          <div className={`signalStripItem signalStripItem--${level}`} key={row.source.address}>
            <SignalBadge level={level} compact />
            <span className="signalStripName">{row.source.name}</span>
            <span className="signalStripReason">{reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EarnedReputationPanel({ rows, onFollow }: { rows: EarnedReputation[]; onFollow?: (addr: Address) => void }) {
  if (rows.length === 0) {
    return (
      <section className="reputationPanel reputationPanelEmpty">
        <Header eyebrow="meet the agents" title="Source agents appear when the registry syncs." />
        <p className="reputationCaption">
          Shadow keeps this page useful even before live source rows arrive: the reputation model is receipt-first, not
          profile-first.
        </p>
        <div className="emptyProofGrid" aria-label="Reputation inputs">
          <span>copied intents</span>
          <span>blocked attempts</span>
          <span>repayments</span>
          <span>x402-bound receipts</span>
        </div>
      </section>
    );
  }
  const totalIntents = rows.reduce((sum, r) => sum + r.intentsPublished, 0);
  const totalCopies = rows.reduce((sum, r) => sum + r.copyCount, 0);
  const totalRouted = rows.reduce((sum, r) => sum + r.routedUSDC, 0n);
  return (
    <section className="reputationPanel" id="sources">
      <Header eyebrow="meet the agents" title="AI source agents you can follow. Profiles, not metrics." />
      <p className="reputationCaption">
        These three agents publish intents on Arc every 10 minutes. Each card shows what their intents actually did,
        who copied, who got blocked, and what they earned. Nothing self-reported.
      </p>
      <SignalStrip rows={rows} />
      <div className="reputationTotals">
        <span>{totalIntents} intents published</span>
        <span>{totalCopies} copies executed</span>
        <span>{formatUSDC(totalRouted)} USDC routed through followers</span>
      </div>
      <div className="reputationGrid">
        {rows.map((row, index) => {
          const persona = traderPersona(row.source.name);
          const signal = agentSignal(row);
          return (
          <article className={`reputationCard reputationCard--${persona.tone}`} key={row.source.address} style={{ ["--trader-accent" as string]: persona.accent }}>
            <header className="reputationCardHeader">
              <span className="reputationRank">#{index + 1}</span>
              <div className="reputationName">
                <strong>{row.source.name}</strong>
                <span className="reputationTagline">{persona.tagline}</span>
                <span className="reputationAddr">{shortAddress(row.source.address)}</span>
              </div>
              <div className="reputationHeaderRight">
                <SignalBadge level={signal.level} reason={signal.reason} />
                <span className="reputationRegistry">
                  registry score {score(row.source.reputationScore)}
                </span>
              </div>
            </header>
            <p className="reputationSignalReason">{signal.reason}</p>
            {row.lastIntent && (
              <div className="reputationLastIntent">
                <span className="reputationLastIntentLabel">Last intent</span>
                <span className="reputationLastIntentValue">
                  swap <strong>{formatUSDC(row.lastIntent.amountUSDC)} USDC</strong> · risk L{row.lastIntent.riskLevel}
                </span>
                <span className="reputationLastIntentBlock">block {row.lastIntent.blockNumber.toString()}</span>
              </div>
            )}
            <div className="reputationStats">
              <ReputationStat label="intents" value={String(row.intentsPublished)} />
              <ReputationStat
                label="copy rate"
                value={
                  row.copyCount + row.blockCount === 0
                    ? "…"
                    : `${(row.copyRateBps / 100).toFixed(1)}%`
                }
                subtext={`${row.copyCount} copied / ${row.blockCount} blocked`}
              />
              <ReputationStat
                label="USDC routed"
                value={formatUSDC(row.routedUSDC)}
              />
              <ReputationStat
                label="source fees earned"
                value={formatUSDC(row.source.kickbackUSDC)}
                subtext={`${formatUSDC(row.mirrorFeesUSDC)} USDC mirror fees · 70% accrued to source`}
              />
              <ReputationStat
                label="follow records"
                value={row.source.followerCount.toString()}
              />
              <ReputationStat
                label="realized PnL"
                value={
                  row.realizedPnlAvgBps === null
                    ? "no closes"
                    : `${(row.realizedPnlAvgBps / 100).toFixed(2)}%`
                }
                subtext={
                  row.closedCount === 0 ? "…" : `avg over ${row.closedCount} closed positions`
                }
                tone={
                  row.realizedPnlAvgBps === null
                    ? undefined
                    : row.realizedPnlAvgBps >= 0
                      ? "positive"
                      : "negative"
                }
              />
            </div>
            {onFollow && (
              <button
                className="reputationFollowCta"
                type="button"
                onClick={() => onFollow(row.source.address)}
              >
                Follow {row.source.name}
                <span className="reputationFollowArrow">→</span>
              </button>
            )}
          </article>
          );
        })}
      </div>
    </section>
  );
}

function ReputationStat({
  label,
  value,
  subtext,
  tone,
}: {
  label: string;
  value: string;
  subtext?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className={`reputationStat${tone ? ` tone-${tone}` : ""}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      {subtext && <span>{subtext}</span>}
    </div>
  );
}

function CircleStackPanel() {
  return (
    <section id="circle-stack" className="circleStackPanel">
      <Header
        eyebrow="arc agentic workflow stack"
        title="Identity, settlement, controls, and the missing capital layer"
      />
      <p className="circleStackCaption">
        Arc&apos;s agentic workflow framing is agents that transact with identity, stablecoin settlement, and programmable
        controls. Shadow fits that lane and adds the capital primitive: sponsor-backed USDC capacity that can be drawn,
        repaid, blocked, and verified from receipts.
      </p>
      <div className="circleStackGrid">
        <article className="circleTierCard primary">
          <span>identity</span>
          <strong>Agent signer · bounded intent</strong>
          <p>The V2 line is bound to the wallet that signs the EIP-712 intent; capacity is visible before a sponsor pays.</p>
        </article>
        <article className="circleTierCard">
          <span>settlement</span>
          <strong>Arc USDC · direct provider pay</strong>
          <p>
            V2 pays the signed provider directly from contract custody. The payment rail is Arc USDC, with x402-style
            provider workflows layered above it.
          </p>
        </article>
        <article className="circleTierCard">
          <span>programmable controls</span>
          <strong>Provider · endpoint · max debt</strong>
          <p>Provider, endpoint hash, amount, max cumulative debt, nonce, expiry, and executor are enforced before funds move.</p>
        </article>
        <article className="circleTierCard">
          <span>capital layer</span>
          <strong>Sponsor reserve · debt · repay</strong>
          <p>Shadow&apos;s delta is reserved capacity: draw against sponsor-backed USDC, open debt, repay, or get blocked.</p>
        </article>
      </div>
    </section>
  );
}

type ModularWalletState =
  | { kind: "idle" }
  | { kind: "configMissing"; reason: string }
  | { kind: "registering" }
  | { kind: "loggingIn" }
  | { kind: "deriving" }
  | { kind: "ready"; address: Address; mode: "Register" | "Login" }
  | { kind: "funding"; address: Address }
  | { kind: "funded"; address: Address; tx?: string; alreadyFunded?: boolean }
  | { kind: "sending"; stage: string; address: Address }
  | { kind: "sent"; address: Address; userOpHash: string; txHash?: string; mode?: "follow" | "lepton"; mandateId?: bigint; amountUSDC?: bigint }
  | { kind: "error"; message: string; address?: Address };

const CREDENTIAL_STORAGE_KEY = "shadow:circleModularCredential";

const SOURCE_AGENTS: ReadonlyArray<{
  address: Address;
  name: string;
  tagline: string;
}> = [
  {
    address: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
    name: "CatArb",
    tagline: "spot arbitrage on USDC / ARCETH",
  },
  {
    address: "0xFF3BDb60E16538333C9A290BB80bE52b3b82D2f3" as Address,
    name: "LobsterRisk",
    tagline: "risk managed copy, tighter slippage",
  },
  {
    address: "0xe2f079d0aBe68a9CA0A9875e254fD976EaC0696B" as Address,
    name: "MomentumOtter",
    tagline: "LLM reasoned momentum, regime read per intent",
  },
];

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const mod = b64.length % 4;
  const padded = mod === 0 ? b64 : b64 + "=".repeat(4 - mod);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ModularWalletCard() {
  const clientKey = (import.meta.env.VITE_CIRCLE_CLIENT_KEY || "").trim();
  const clientUrl = (import.meta.env.VITE_CIRCLE_CLIENT_URL || "").trim();

  const initial: ModularWalletState =
    !clientKey || !clientUrl
      ? {
          kind: "configMissing",
          reason:
            "Set VITE_CIRCLE_CLIENT_KEY and VITE_CIRCLE_CLIENT_URL in your env (Circle Console → Modular Wallets) to enable passkey onboarding + Gas Station.",
        }
      : { kind: "idle" };

  const [state, setState] = useState<ModularWalletState>(initial);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState(0);
  const selectedSource = SOURCE_AGENTS[selectedSourceIndex];
  const [followerPolicy, setFollowerPolicy] = useState<{
    active: boolean;
    maxPerIntent: bigint;
    dailyCap: bigint;
    spentToday: bigint;
  } | null>(null);

  const trackedAddress: Address | undefined = (state as any).address;
  useEffect(() => {
    if (!trackedAddress || !addresses.router) {
      setFollowerPolicy(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const policy = (await publicClient.readContract({
          address: addresses.router!,
          abi: routerAbi,
          functionName: "getPolicy",
          args: [trackedAddress, selectedSource.address],
        })) as readonly [bigint, bigint, Address, number, number, bigint, bigint, boolean];
        if (cancelled) return;
        setFollowerPolicy({
          active: policy[7],
          maxPerIntent: policy[0],
          dailyCap: policy[1],
          spentToday: policy[5],
        });
      } catch {
        if (!cancelled) setFollowerPolicy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trackedAddress, state.kind, selectedSource.address]);

  useEffect(() => {
    if (state.kind !== "ready" || !addresses.usdc) return;
    const addr = state.address;
    let cancelled = false;
    void (async () => {
      try {
        const balance = (await publicClient.readContract({
          address: addresses.usdc!,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [addr],
        })) as bigint;
        if (cancelled) return;
        if (balance >= parseUnits("0.04", 6)) {
          setState({ kind: "funded", address: addr, alreadyFunded: true });
        }
      } catch {
        // leave state as ready; user can still click Fund manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.kind, (state as any).address]);

  async function loadCredential(): Promise<WebAuthnCredential | null> {
    try {
      const raw =
        localStorage.getItem(CREDENTIAL_STORAGE_KEY) ??
        sessionStorage.getItem(CREDENTIAL_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as WebAuthnCredential;
    } catch {
      return null;
    }
  }

  function persistCredential(cred: WebAuthnCredential) {
    try {
      localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(cred));
    } catch {
      try {
        sessionStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(cred));
      } catch {
        // Both stores blocked (private mode + quota). Credential reconstructable via Login.
      }
    }
  }

  async function withSmartAccount(cred: WebAuthnCredential) {
    const modularTransport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
    const client = createClient({
      chain: arcTestnet,
      transport: modularTransport,
    }) as any;
    const owner = toWebAuthnAccount({ credential: cred, rpId: cred.rpId });
    const smartAccount = await toCircleSmartAccount({ client, owner });
    const bundler = createBundlerClient({
      account: smartAccount,
      chain: arcTestnet,
      transport: modularTransport,
      paymaster: true,
      paymasterContext: {},
      userOperation: {
        estimateFeesPerGas: async () => {
          const prices: any = await getUserOperationGasPrice(client);
          const tier = prices?.medium ?? prices?.high ?? prices?.low;
          return {
            maxFeePerGas: BigInt(tier.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tier.maxPriorityFeePerGas),
          };
        },
      },
    } as any);
    return { smartAccount, bundler };
  }

  async function onRegister() {
    setState({ kind: "registering" });
    let restoreCreate: (() => void) | null = null;
    try {
      const existing = await loadCredential();
      let excludeId: Uint8Array | null = null;
      if (existing?.id) {
        try {
          excludeId = base64UrlToBytes(existing.id);
        } catch {
          excludeId = null;
        }
      }
      if (excludeId) {
        const originalCreate = navigator.credentials.create.bind(
          navigator.credentials,
        );
        const id = excludeId;
        (navigator.credentials as any).create = async (opts: any) => {
          if (opts?.publicKey) {
            opts.publicKey.excludeCredentials = [
              ...(opts.publicKey.excludeCredentials ?? []),
              { type: "public-key", id },
            ];
          }
          return originalCreate(opts);
        };
        restoreCreate = () => {
          (navigator.credentials as any).create = originalCreate;
        };
      }

      const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
      const credential = await toWebAuthnCredential({
        transport: passkeyTransport,
        mode: WebAuthnMode.Register,
        username: `shadow-${Date.now()}`,
      });
      persistCredential(credential);
      setState({ kind: "deriving" });
      const { smartAccount } = await withSmartAccount(credential);
      setState({ kind: "ready", address: smartAccount.address, mode: "Register" });
    } catch (err: any) {
      const msg = err?.message || String(err);
      const name = err?.name || "";
      const explicitDuplicate =
        name === "InvalidStateError" ||
        /InvalidStateError|already.*passkey|already.*registered|already.*enrolled/i.test(
          msg,
        );
      const browserDedupCloak =
        name === "NotAllowedError" ||
        /timed out or was not allowed|talking to the credential manager|operation.*not allowed/i.test(
          msg,
        );
      const blockedByExisting =
        restoreCreate !== null && (explicitDuplicate || browserDedupCloak);
      setState({
        kind: "error",
        message: blockedByExisting
          ? "This device already has a Shadow passkey (or the prompt was cancelled). Tap Login to use the existing passkey, or register from a different device for a new account."
          : explicitDuplicate
            ? "This device already has a Shadow passkey. Tap Login to use it, or register from a different device for a new account."
            : msg,
      });
    } finally {
      restoreCreate?.();
    }
  }

  async function onLogin() {
    setState({ kind: "loggingIn" });
    try {
      const stored = await loadCredential();
      const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
      const credential = stored
        ? stored
        : await toWebAuthnCredential({
            transport: passkeyTransport,
            mode: WebAuthnMode.Login,
          });
      persistCredential(credential);
      setState({ kind: "deriving" });
      const { smartAccount } = await withSmartAccount(credential);
      setState({ kind: "ready", address: smartAccount.address, mode: "Login" });
    } catch (err: any) {
      setState({ kind: "error", message: err?.message || String(err) });
    }
  }

  async function onFund() {
    const addr =
      state.kind === "ready" || state.kind === "funded" || state.kind === "sent" || state.kind === "error"
        ? (state as any).address
        : undefined;
    if (!addr) return;
    setState({ kind: "funding", address: addr });
    try {
      const demoCode = ((import.meta as any).env?.VITE_SHADOW_DEMO_CODE as string | undefined) || "";
      const res = await fetch("/api/fund-smart-account", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shadow-demo-code": demoCode },
        body: JSON.stringify({ address: addr, demoCode }),
      });
      const json = (await res.json()) as {
        funded?: boolean;
        skipped?: boolean;
        cached?: boolean;
        tx?: string;
        previousTx?: string;
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error || `fund failed (HTTP ${res.status})`);
      }
      setState({
        kind: "funded",
        address: addr,
        tx: json.tx || json.previousTx,
        alreadyFunded: Boolean(json.skipped || json.cached),
      });
    } catch (err: any) {
      setState({
        kind: "error",
        message: err?.shortMessage || err?.message || "fund failed",
        address: addr,
      });
    }
  }

  async function onSponsoredFollow() {
    if (state.kind !== "ready" && state.kind !== "funded") return;
    const accountAddress = state.address;
    if (!addresses.router || !addresses.usdc || !addresses.arceth) {
      setState({
        kind: "error",
        message: "Shadow router/usdc/arceth env not set; cannot onboard follower.",
        address: accountAddress,
      });
      return;
    }
    setState({ kind: "sending", stage: "loading passkey credential", address: accountAddress });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      setState({ kind: "sending", stage: "encoding follow batch", address: accountAddress });
      const { smartAccount, bundler } = await withSmartAccount(credential);

      const depositAmount = parseUnits("0.04", 6);
      const maxAmountPerIntent = parseUnits("0.02", 6);
      const dailyCap = parseUnits("0.04", 6);
      const minBpsOut = 9500;
      const maxRiskLevel = 2;

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [addresses.router as Address, depositAmount],
      });
      const depositData = encodeFunctionData({
        abi: routerAbi,
        functionName: "depositUSDC",
        args: [depositAmount],
      });
      const followData = encodeFunctionData({
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource.address,
          maxAmountPerIntent,
          dailyCap,
          addresses.arceth as Address,
          maxRiskLevel,
          minBpsOut,
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor", address: accountAddress });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [
          { to: addresses.usdc as Address, value: 0n, data: approveData },
          { to: addresses.router as Address, value: 0n, data: depositData },
          { to: addresses.router as Address, value: 0n, data: followData },
        ],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for receipt", address: accountAddress });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({
        kind: "sent",
        address: accountAddress,
        userOpHash,
        txHash: receipt?.receipt?.transactionHash,
        mode: "follow",
      });
    } catch (err: any) {
      const parts: string[] = [];
      let current: any = err;
      let depth = 0;
      while (current && depth < 8) {
        const msg = current.shortMessage || current.message;
        if (msg && !parts.includes(msg)) parts.push(msg);
        if (current.details && typeof current.details === "string" && !parts.includes(current.details)) {
          parts.push(current.details);
        }
        if (current.metaMessages && Array.isArray(current.metaMessages)) {
          for (const m of current.metaMessages) {
            if (typeof m === "string" && !parts.includes(m)) parts.push(m);
          }
        }
        current = current.cause;
        depth += 1;
      }
      const raw = parts.join(" | ") || String(err);
      console.error("[sponsoredFollow] full error chain", err);
      const insufficient = /transfer amount exceeds balance|insufficient.*balance/i.test(raw);
      setState({
        kind: "error",
        message: insufficient
          ? `Smart account needs USDC first. Click "Fund smart account" (deployer sends 0.05 USDC) and retry.`
          : raw,
        address: accountAddress,
      });
    }
  }

  async function onSponsoredLeptonMandate() {
    const accountAddress = (state as any).address as Address | undefined;
    if (!accountAddress || state.kind === "funding" || state.kind === "sending") return;
    if (!addresses.usdc || !isLeptonConfigured || !leptonAddresses.mandateRegistry || !leptonAddresses.v4StyleAdapter) {
      setState({
        kind: "error",
        message: "Lepton registry/adapter/usdc addresses are not configured.",
        address: accountAddress,
      });
      return;
    }

    setState({ kind: "sending", stage: "loading passkey credential", address: accountAddress });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      const { smartAccount, bundler } = await withSmartAccount(credential);
      const smartAddress = smartAccount.address as Address;
      const amountUSDC = parseUnits("0.01", 6);
      const dailyCap = parseUnits("0.02", 6);

      setState({ kind: "sending", stage: "checking passkey USDC balance", address: smartAddress });
      const balance = (await publicClient.readContract({
        address: addresses.usdc as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [smartAddress],
      })) as bigint;
      if (balance < amountUSDC) {
        throw new Error(`Smart account needs at least ${formatUSDC(amountUSDC)} USDC. Click "Fund smart account" and retry.`);
      }

      setState({ kind: "sending", stage: "reading next mandate id", address: smartAddress });
      const mandateId = (await publicClient.readContract({
        address: leptonAddresses.mandateRegistry,
        abi: mandateRegistryAbi,
        functionName: "nextMandateId",
      })) as bigint;
      const now = Math.floor(Date.now() / 1000);

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [leptonAddresses.v4StyleAdapter, amountUSDC],
      });
      const createMandateData = encodeFunctionData({
        abi: mandateRegistryAbi,
        functionName: "createMandate",
        args: [
          smartAddress,
          addresses.usdc as Address,
          leptonAddresses.v4StyleAdapter,
          1,
          amountUSDC,
          dailyCap,
          3,
          9_900,
          keccak256(stringToBytes(`shadow-lepton-passkey-${smartAddress}-${now}`)),
        ],
      });
      const actionData = encodeFunctionData({
        abi: v4StyleArcAdapterAbi,
        functionName: "beforeSwapStyleAction",
        args: [
          {
            mandateId,
            actor: smartAddress,
            circleAccount: smartAddress,
            settlementAsset: addresses.usdc as Address,
            target: leptonAddresses.v4StyleAdapter,
            actionType: 1,
            amountUSDC,
            riskLevel: 2,
            minBpsOut: 9_950,
            expiry: BigInt(now + 86_400),
            intentHash: keccak256(stringToBytes(`shadow-lepton-passkey-allow-${now}`)),
            executionRef: keccak256(stringToBytes("circle-passkey-lepton-allow")),
          },
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor Lepton batch", address: smartAddress });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [
          { to: addresses.usdc as Address, value: 0n, data: approveData },
          { to: leptonAddresses.mandateRegistry, value: 0n, data: createMandateData },
          { to: leptonAddresses.v4StyleAdapter, value: 0n, data: actionData },
        ],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for Lepton receipt", address: smartAddress });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({
        kind: "sent",
        address: smartAddress,
        userOpHash,
        txHash: receipt?.receipt?.transactionHash,
        mode: "lepton",
        mandateId,
        amountUSDC,
      });
    } catch (err: any) {
      const parts: string[] = [];
      let current: any = err;
      let depth = 0;
      while (current && depth < 8) {
        const msg = current.shortMessage || current.message;
        if (msg && !parts.includes(msg)) parts.push(msg);
        if (current.details && typeof current.details === "string" && !parts.includes(current.details)) {
          parts.push(current.details);
        }
        if (current.metaMessages && Array.isArray(current.metaMessages)) {
          for (const m of current.metaMessages) {
            if (typeof m === "string" && !parts.includes(m)) parts.push(m);
          }
        }
        current = current.cause;
        depth += 1;
      }
      console.error("[sponsoredLeptonMandate] full error chain", err);
      setState({
        kind: "error",
        message: parts.join(" | ") || String(err),
        address: accountAddress,
      });
    }
  }

  async function onTunePolicy() {
    const addr = (state as any).address as Address | undefined;
    if (!addr) return;
    if (!addresses.router || !addresses.arceth) {
      setState({ kind: "error", message: "router/arceth env not set", address: addr });
      return;
    }
    setState({ kind: "sending", stage: "loading passkey credential", address: addr });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      setState({ kind: "sending", stage: "encoding looser minBpsOut", address: addr });
      const { smartAccount, bundler } = await withSmartAccount(credential);

      const maxAmountPerIntent = parseUnits("0.02", 6);
      const dailyCap = parseUnits("0.04", 6);
      const minBpsOut = 9000;
      const maxRiskLevel = 2;

      const followData = encodeFunctionData({
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource.address,
          maxAmountPerIntent,
          dailyCap,
          addresses.arceth as Address,
          maxRiskLevel,
          minBpsOut,
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor tune", address: addr });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [{ to: addresses.router as Address, value: 0n, data: followData }],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for receipt", address: addr });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({ kind: "sent", address: addr, userOpHash, txHash: receipt?.receipt?.transactionHash });
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.error("[tunePolicy] error", err);
      setState({ kind: "error", message: msg, address: addr });
    }
  }

  return (
    <div className="modularCard">
      <div className="modularHeader">
        <span className="modularBadge">Modular Wallets · MSCA · ERC-4337</span>
        <h3>One click follower onboarding, gas sponsored by Circle</h3>
      </div>
      {followerPolicy && (
        <div className="modularStatusRow">
          <span className={followerPolicy.active ? "modularChipOk" : "modularChipMuted"}>
            Sponsored onboards: {followerPolicy.active ? 1 : 0}
          </span>
          {followerPolicy.active && (
            <>
              <span className="modularChipOk">Following {selectedSource.name}</span>
              <span className="modularChipMuted">0 ETH gas from your wallet</span>
            </>
          )}
        </div>
      )}
      {state.kind === "configMissing" ? (
        <p className="modularEmpty">{(state as any).reason}</p>
      ) : (
        <>
          <p className="modularBody">
            Create a Circle MSCA owned by your device passkey, fund it with 0.05
            USDC (one click below), then approve, deposit, and call{" "}
            <code>followSource</code> on the source agent you pick in a single batched
            UserOp with <code>paymaster: true</code>. The smart account becomes a real
            Shadow follower with its own minBpsOut policy. Circle Gas Station pays the
            gas, so a new follower can start mirroring on Arc without ever holding
            native gas first.
          </p>
          <div className="modularButtons">
            <button
              type="button"
              className="modularBtnPrimary"
              onClick={onRegister}
              disabled={state.kind === "registering" || state.kind === "loggingIn" || state.kind === "deriving" || state.kind === "sending"}
            >
              {state.kind === "registering" ? "Registering…" : "Register passkey"}
            </button>
            <button
              type="button"
              className="modularBtnSecondary"
              onClick={onLogin}
              disabled={state.kind === "registering" || state.kind === "loggingIn" || state.kind === "deriving" || state.kind === "sending"}
            >
              {state.kind === "loggingIn" ? "Logging in…" : "Login with passkey"}
            </button>
          </div>
          {state.kind === "deriving" && <p className="modularInfo">Deriving smart account address…</p>}
          {(state.kind === "ready" ||
            state.kind === "funding" ||
            state.kind === "funded" ||
            state.kind === "sending" ||
            state.kind === "sent" ||
            (state.kind === "error" && (state as any).address)) && (
            <div className="modularAccount">
              <p>
                <span>Smart account</span>{" "}
                <code title={(state as any).address}>{(state as any).address}</code>{" "}
                <button
                  type="button"
                  className="modularCopyBtn"
                  onClick={() => navigator.clipboard?.writeText((state as any).address)}
                  title="Copy address"
                >
                  copy
                </button>
              </p>
              <div className="modularSourcePicker">
                <span className="modularSourcePickerLabel">Source agent:</span>
                {SOURCE_AGENTS.map((src, i) => (
                  <button
                    key={src.address}
                    type="button"
                    className={
                      i === selectedSourceIndex
                        ? "modularBtnPrimary"
                        : "modularBtnSecondary"
                    }
                    onClick={() => setSelectedSourceIndex(i)}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                    title={src.tagline}
                  >
                    {src.name}
                  </button>
                ))}
              </div>
              <div className="modularButtons">
                <button
                  type="button"
                  className="modularBtnSecondary"
                  onClick={onFund}
                  disabled={state.kind === "funding" || state.kind === "sending"}
                >
                  {state.kind === "funding"
                    ? "Funding…"
                    : state.kind === "funded"
                      ? state.alreadyFunded
                        ? "Already funded ✓"
                        : "Funded ✓, re-fund"
                      : "Fund smart account (0.05 USDC)"}
                </button>
                {followerPolicy?.active ? (
                  <span className="modularChipOk modularAlreadyFollowing">
                    Already following {selectedSource.name} ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    className="modularBtnPrimary"
                    onClick={onSponsoredFollow}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                  >
                    {state.kind === "sending"
                      ? `Following… ${state.stage}`
                      : `Follow ${selectedSource.name} (approve, deposit, followSource, sponsored)`}
                  </button>
                )}
                {(followerPolicy?.active || state.kind === "sent") && (
                  <button
                    type="button"
                    className="modularBtnSecondary"
                    onClick={onTunePolicy}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                  >
                    {state.kind === "sending"
                      ? `Updating slippage… ${state.stage}`
                      : "Accept up to 10% slippage (was 5%, sponsored)"}
                  </button>
                )}
                <button
                  type="button"
                  className="modularBtnPrimary"
                  onClick={onSponsoredLeptonMandate}
                  disabled={state.kind === "sending" || state.kind === "funding"}
                  title="Create a Lepton mandate and execute an allowed USDC movement through the bonded adapter"
                >
                  {state.kind === "sending"
                    ? `Lepton… ${state.stage}`
                    : "Run Lepton mandate action (sponsored)"}
                </button>
              </div>
              {state.kind === "funded" && state.tx && (
                <p className="modularInfo">
                  Faucet tx{" "}
                  <a href={txUrl(state.tx as `0x${string}`)} target="_blank" rel="noreferrer">
                    {state.tx.slice(0, 10)}…
                  </a>
                  . Now click follow {selectedSource.name}. Circle Gas Station
                  sponsors all three calls in one batched UserOp.
                </p>
              )}
            </div>
          )}
          {state.kind === "sent" && (
            <p className="modularOk">
              <strong>Zero gas paid by your wallet.</strong>{" "}
              {state.mode === "lepton" ? (
                <>
                  Circle Gas Station sponsored the Lepton batch: approve USDC,
                  create mandate #{state.mandateId?.toString()}, then execute{" "}
                  {state.amountUSDC ? formatUSDC(state.amountUSDC) : "0.01"} USDC
                  through the bonded adapter with an ALLOW receipt and vault record.{" "}
                </>
              ) : (
                <>
                  Circle Gas Station sponsored the entire batched UserOp (approve + deposit +
                  followSource). Smart account is now a live {selectedSource.name}{" "}
                  follower with its own minBpsOut policy.{" "}
                </>
              )}
              {state.txHash ? (
                <a href={txUrl(state.txHash as `0x${string}`)} target="_blank" rel="noreferrer">
                  view batched tx
                </a>
              ) : (
                <span>UserOp hash: <code>{state.userOpHash.slice(0, 10)}…</code></span>
              )}
            </p>
          )}
          {state.kind === "error" && <p className="modularErr">{state.message}</p>}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
