import type { Address, Hash, Hex } from "viem";

export type LeptonWriteReasonCode =
  | "NOT_CONFIGURED"
  | "RPC_READ_FAILED"
  | "ADAPTER_CODE_MISSING"
  | "SINK_CODE_MISSING"
  | "BOND_ZERO"
  | "BOND_BELOW_MINIMUM"
  | "GENERATION_NOT_ALLOWLISTED"
  | "SOURCE_NOT_VERIFIED"
  | "WRONG_ENFORCER"
  | "WRONG_SINK_BINDING"
  | "SINK_NOT_RECOVERABLE";

export type LeptonV4Readiness = {
  readConfigured: boolean;
  writeReady: boolean;
  reasonCodes: readonly LeptonWriteReasonCode[];
  userCopy: string;
};

export type LeptonV4ReadinessInput = {
  readConfigured: boolean;
  rpcOk: boolean;
  adapterHasCode: boolean;
  sinkHasCode: boolean;
  adapterBondUSDC: bigint;
  minBondUSDC: bigint;
  generationWriteAllowlisted: boolean;
  generationSourceVerified: boolean;
  actualEnforcer?: Address;
  expectedEnforcer?: Address;
  actualSink?: Address;
  expectedSink?: Address;
  sinkAdapter?: Address;
  expectedAdapter?: Address;
  sinkRecoverable: boolean;
};

export const LEPTON_M1_DEPLOYMENTS: {
  readonly currentRead: {
    readonly generation: string;
    readonly mandateRegistry: Address;
    readonly mandateAttestor: Address;
    readonly bondedEnforcer: Address;
    readonly v4StyleAdapter: Address;
    readonly v4StyleSink: Address;
    readonly morphoStyleAdapter: Address;
    readonly morphoStyleSink: Address;
    readonly sourceVerified: boolean;
    readonly canonicalWriteAllowlisted: boolean;
    readonly sinkRecoverable: boolean;
  };
  readonly historicalProofs: {
    readonly circlePasskey: {
      readonly generation: string;
      readonly label: string;
      readonly txHash: Hash;
      readonly mandateRegistry: Address;
      readonly bondedEnforcer: Address;
      readonly v4StyleAdapter: Address;
      readonly v4StyleSink: Address;
    };
    readonly morphoStyle: {
      readonly generation: string;
      readonly label: string;
      readonly adapter: Address;
      readonly sink: Address;
      readonly allowTx: Hash;
      readonly blockTx: Hash;
    };
  };
};

export const LEPTON_WRITE_REASON: Readonly<Record<LeptonWriteReasonCode, LeptonWriteReasonCode>>;
export function classifyLeptonV4Readiness(input: LeptonV4ReadinessInput): LeptonV4Readiness;
export function runLeptonWalletAction<T>(readiness: LeptonV4Readiness | null | undefined, action: () => Promise<T> | T): Promise<T>;
export function transactionInputContainsAddress(input: Hex | string | null | undefined, address: Address | string): boolean;
