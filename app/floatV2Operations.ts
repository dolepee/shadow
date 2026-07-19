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
    solvent: boolean;
    treasuryBalanceUSDC: string;
    sponsoredReserveUSDC: string;
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

type BuildFloatV2OperationalHealthInput = {
  source: string;
  degraded: boolean;
  treasuryBalanceUSDC: string;
  totalSponsoredReserveUSDC: string;
  agents: FloatV2OperationalAgent[];
};

function atomicUSDC(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a non-negative atomic USDC amount`);
  return BigInt(value);
}

function agentRefs(agents: FloatV2OperationalAgent[]) {
  return agents.map(({ label, agent }) => ({ label, agent }));
}

export function buildFloatV2OperationalHealth(
  input: BuildFloatV2OperationalHealthInput,
): FloatV2OperationalHealth {
  const treasury = atomicUSDC(input.treasuryBalanceUSDC, "treasuryBalanceUSDC");
  const sponsoredReserve = atomicUSDC(input.totalSponsoredReserveUSDC, "totalSponsoredReserveUSDC");
  const solvent = treasury >= sponsoredReserve;
  const openDebt = input.agents.filter((agent) => atomicUSDC(agent.activeDebtUSDC, `${agent.label} activeDebtUSDC`) > 0n);
  const expiredDebtOpen = input.agents.filter((agent) => agent.sponsorState === "expired-debt-open");
  const reclaimable = input.agents.filter((agent) => agent.sponsorState === "expired-reserve-reclaimable");
  const defaulted = input.agents.filter((agent) => agent.statusName === "DEFAULTED");
  const alerts: FloatV2OperationalAlert[] = [];

  if (input.degraded) {
    alerts.push({
      code: "DATA_DEGRADED",
      severity: "warning",
      title: "Live RPC view unavailable",
      detail: "The page is showing a verified checkpoint. Do not use it as fresh authorization for a new transaction.",
      agents: [],
    });
  }
  if (!solvent) {
    alerts.push({
      code: "RESERVE_INVARIANT_BREACH",
      severity: "critical",
      title: "Sponsored reserve exceeds treasury custody",
      detail: "Stop new line activity and reconcile contract balances before any further sponsor transaction.",
      agents: [],
    });
  }
  if (defaulted.length > 0) {
    alerts.push({
      code: "DEFAULTED_LINE",
      severity: "critical",
      title: `${defaulted.length} defaulted line${defaulted.length === 1 ? "" : "s"}`,
      detail: "Default is an explicit loss-bearing state. Confirm reserve accounting and do not present the line as active capacity.",
      agents: agentRefs(defaulted),
    });
  }
  if (expiredDebtOpen.length > 0) {
    alerts.push({
      code: "EXPIRED_DEBT_OPEN",
      severity: "warning",
      title: `${expiredDebtOpen.length} expired line${expiredDebtOpen.length === 1 ? " has" : "s have"} open debt`,
      detail: "The sponsor cannot reclaim or renew this reserve until debt is resolved under the existing line policy.",
      agents: agentRefs(expiredDebtOpen),
    });
  } else if (openDebt.length > 0) {
    alerts.push({
      code: "OPEN_DEBT",
      severity: "info",
      title: `${openDebt.length} line${openDebt.length === 1 ? " has" : "s have"} open debt`,
      detail: "Open debt is visible exposure, not a failure by itself. Capacity remains reduced until repayment or default resolution.",
      agents: agentRefs(openDebt),
    });
  }
  if (reclaimable.length > 0) {
    alerts.push({
      code: "RESERVE_RECLAIMABLE",
      severity: "info",
      title: `${reclaimable.length} reserve${reclaimable.length === 1 ? " is" : "s are"} reclaimable`,
      detail: "The line is expired with zero debt. Only its sponsor can close the line and choose the reserve recipient.",
      agents: agentRefs(reclaimable),
    });
  }

  const status = !solvent || defaulted.length > 0
    ? "critical"
    : input.degraded
      ? "degraded"
      : expiredDebtOpen.length > 0
        ? "attention"
        : "healthy";

  return {
    status,
    source: input.source,
    reserve: {
      solvent,
      treasuryBalanceUSDC: treasury.toString(),
      sponsoredReserveUSDC: sponsoredReserve.toString(),
      surplusUSDC: (treasury > sponsoredReserve ? treasury - sponsoredReserve : 0n).toString(),
    },
    counts: {
      openDebt: openDebt.length,
      expiredDebtOpen: expiredDebtOpen.length,
      reclaimable: reclaimable.length,
      defaulted: defaulted.length,
    },
    alerts,
  };
}
