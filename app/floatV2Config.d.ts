import type { Abi, AbiEvent, Address, Hash } from "viem";

export type FloatV2TrackedExternalAgent = {
  label: string;
  agent: Address;
  spendTx?: Hash;
  repayTx?: Hash;
};

export declare const FLOAT_V2_CONTRACT: Address;
export declare const FLOAT_V2_DEPLOY_BLOCK: bigint;
export declare const FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE: bigint;
export declare const FLOAT_V2_STATUS_NAMES: readonly ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];
export declare const FLOAT_V2_TRACKED_EXTERNAL_AGENTS: readonly FloatV2TrackedExternalAgent[];
export declare const floatV2Abi: Abi;
export declare const floatV2IntentConsumedEvent: AbiEvent;
export declare const floatV2ReceiptEvent: AbiEvent;
