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

export declare const FLOAT_V2_CONTRACT: Address;
export declare const FLOAT_V2_DEPLOY_BLOCK: bigint;
export declare const FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE: bigint;
export declare const FLOAT_V2_ACTIVITY_CHECKPOINT: FloatV2ActivityCheckpoint;
export declare const FLOAT_V2_STATUS_NAMES: readonly ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];
export declare const FLOAT_V2_SHADOW_CONTROLLED_SPONSORS: readonly Address[];
export declare const FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS: readonly Address[];
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
