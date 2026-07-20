export type FloatV2OperationalAgent = {
  label: string;
  agent: string;
  activeDebtUSDC: string;
  sponsorReserveUSDC: string;
  sponsorState?: string;
  statusName: string;
};

export type FloatV2OperationalAlert = {
  code:
    | "DATA_DEGRADED"
    | "RESERVE_SCOPE_INCOMPLETE"
    | "RESERVE_INVARIANT_BREACH"
    | "DEFAULTED_LINE"
    | "EXPIRED_DEBT_OPEN"
    | "OPEN_DEBT"
    | "RESERVE_RECLAIMABLE";
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  agents: Array<{ label: string; agent: string }>;
};

export type FloatV2OperationalHealth = {
  status: "healthy" | "attention" | "degraded" | "critical";
  source: "live-rpc" | "verified-checkpoint" | string;
  reserve: {
    solvent: boolean | null;
    scopeComplete: boolean;
    observedFloorCovered: boolean;
    treasuryBalanceUSDC: string;
    sponsoredReserveUSDC: string;
    observedSponsoredReserveUSDC: string;
    sponsoredDebtDeployedUSDC: string;
    custodialReserveFloorUSDC: string;
    surplusUSDC: string;
  };
  counts: {
    openDebt: number;
    expiredDebtOpen: number;
    reclaimable: number;
    defaulted: number;
  };
  alerts: FloatV2OperationalAlert[];
};

export type BuildFloatV2OperationalHealthInput = {
  source: string;
  degraded: boolean;
  treasuryBalanceUSDC: string;
  totalSponsoredReserveUSDC: string;
  agents: FloatV2OperationalAgent[];
};

export function buildFloatV2OperationalHealth(
  input: BuildFloatV2OperationalHealthInput,
): FloatV2OperationalHealth;
