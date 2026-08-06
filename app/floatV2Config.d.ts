import type { Abi, AbiEvent, Address, Hash } from "viem";

export type FloatV2TrackedAgent = {
  label: string;
  agent: Address;
  category: "external" | "system";
  agentProvenance: "verified-external-signer" | "shadow-controlled-signer";
  verifiedSponsor?: Address;
  retired?: boolean;
  spendTx?: Hash;
  repayTx?: Hash;
};

export type FloatV2TrackedExternalAgent = FloatV2TrackedAgent & {
  category: "external";
  agentProvenance: "verified-external-signer";
};

export type FloatV2ActivityCheckpointEntry = {
  agent: Address;
  signedIntents: number;
  providerPaidCount: number;
  repaidCount: number;
  blockedCount: number;
  providerPaidUSDC: string;
  repaidUSDC: string;
  blockedUSDC: string;
  latestTxHash?: Hash;
};

export type FloatV2ActivityCheckpoint = {
  blockNumber: bigint;
  checkedAt: string;
  agents: readonly FloatV2ActivityCheckpointEntry[];
};

export type FloatV2VerifiedPostReclaimState = {
  blockNumber: bigint;
  checkedAt: string;
  treasuryBalanceUSDC: string;
  totalAvailableCreditUSDC: string;
  totalSponsoredReserveUSDC: string;
  trackedExternalAgentLines: number;
  externallySponsoredLines: number;
  operatorSponsoredLines: number;
  citePayRenewedLine: {
    agent: Address;
    wallet: Address;
    score: number;
    creditLimitUSDC: string;
    availableCreditUSDC: string;
    activeDebtUSDC: string;
    status: number;
    statusName: string;
    lastReview: string;
    lineExpiry: string;
    sponsor: Address;
    sponsorReserveUSDC: string;
    sponsorState: string;
    preReclaimLatestTxHash: Hash;
    closeTxHash: Hash;
    autonomousScore: { score: number; recommendedLimitUSDC: string; cappedLimitUSDC: string };
  };
};

export declare const FLOAT_V2_CONTRACT: Address;
export declare const FLOAT_V2_DEPLOY_BLOCK: bigint;
export declare const FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE: bigint;
export declare const FLOAT_V2_SOURCE_CHECKPOINT_SCAN_LIMIT: bigint;
export declare const FLOAT_V2_VERIFIED_POST_RECLAIM_STATE: Readonly<FloatV2VerifiedPostReclaimState>;
export declare function shouldUseFloatV2VerifiedSnapshot(
  checkpointSource: string,
  checkpointBlock: bigint,
  latestBlock: bigint,
): boolean;
export declare function reconcileFloatV2CheckpointLatestTx(
  checkpointBlock: bigint,
  agent: Address | string,
  latestTxHash?: Hash,
): Hash | undefined;
export declare const FLOAT_V2_ACTIVITY_CHECKPOINT: FloatV2ActivityCheckpoint;
export declare const FLOAT_V2_STATUS_NAMES: readonly ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];
export declare const FLOAT_V2_SHADOW_CONTROLLED_SPONSORS: readonly Address[];
export declare const FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS: readonly Address[];
export declare function countFloatV2VerifiedReturningAgents(
  agents: readonly {
    sponsor?: Address;
    verifiedSponsor?: Address;
    sponsorProvenance?: "verified-external" | "shadow-controlled" | "unverified" | "none";
    signedIntents: number;
  }[],
): number;
export declare function countFloatV2VerifiedReturningSponsors(
  agents: readonly {
    sponsor?: Address;
    verifiedSponsor?: Address;
    sponsorProvenance?: "verified-external" | "shadow-controlled" | "unverified" | "none";
    signedIntents: number;
  }[],
): number;
export declare const FLOAT_V2_TRACKED_EXTERNAL_AGENTS: readonly FloatV2TrackedExternalAgent[];
export declare const FLOAT_V2_TRACKED_SYSTEM_AGENTS: readonly FloatV2TrackedAgent[];
export declare const FLOAT_V2_TRACKED_AGENTS: readonly FloatV2TrackedAgent[];
export declare const floatV2Abi: Abi;
export declare const floatV2IntentConsumedEvent: AbiEvent;
export declare const floatV2ReceiptEvent: AbiEvent;
