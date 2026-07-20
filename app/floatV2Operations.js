function atomicUSDC(value, field) {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a non-negative atomic USDC amount`);
  return BigInt(value);
}

function agentRefs(agents) {
  return agents.map(({ label, agent }) => ({ label, agent }));
}

export function buildFloatV2OperationalHealth(input) {
  const treasury = atomicUSDC(input.treasuryBalanceUSDC, "treasuryBalanceUSDC");
  const sponsoredReserve = atomicUSDC(input.totalSponsoredReserveUSDC, "totalSponsoredReserveUSDC");
  const observedSponsoredReserve = input.agents.reduce(
    (total, agent) => total + atomicUSDC(agent.sponsorReserveUSDC, `${agent.label} sponsorReserveUSDC`),
    0n,
  );
  const sponsoredDebtDeployed = input.agents.reduce((total, agent) => {
    const reserve = atomicUSDC(agent.sponsorReserveUSDC, `${agent.label} sponsorReserveUSDC`);
    const debt = atomicUSDC(agent.activeDebtUSDC, `${agent.label} activeDebtUSDC`);
    return total + (debt < reserve ? debt : reserve);
  }, 0n);
  const custodialReserveFloor = observedSponsoredReserve > sponsoredDebtDeployed
    ? observedSponsoredReserve - sponsoredDebtDeployed
    : 0n;
  const scopeComplete = observedSponsoredReserve === sponsoredReserve;
  const observedFloorCovered = treasury >= custodialReserveFloor;
  const solvent = scopeComplete ? observedFloorCovered : null;
  const openDebt = input.agents.filter(
    (agent) => atomicUSDC(agent.activeDebtUSDC, `${agent.label} activeDebtUSDC`) > 0n,
  );
  const expiredDebtOpen = input.agents.filter((agent) => agent.sponsorState === "expired-debt-open");
  const reclaimable = input.agents.filter((agent) => agent.sponsorState === "expired-reserve-reclaimable");
  const defaulted = input.agents.filter((agent) => agent.statusName === "DEFAULTED");
  const alerts = [];

  if (input.degraded) {
    alerts.push({
      code: "DATA_DEGRADED",
      severity: "warning",
      title: "Live RPC view unavailable",
      detail: "The page is showing a verified checkpoint. Do not use it as fresh authorization for a new transaction.",
      agents: [],
    });
  }
  if (!scopeComplete) {
    alerts.push({
      code: "RESERVE_SCOPE_INCOMPLETE",
      severity: "warning",
      title: "Sponsored-line tracking scope is incomplete",
      detail: "The contract-wide reserve does not equal the reserve on tracked lines. Global solvency is withheld until the missing line state is indexed and reconciled.",
      agents: [],
    });
  }
  if (!observedFloorCovered) {
    alerts.push({
      code: "RESERVE_INVARIANT_BREACH",
      severity: "critical",
      title: "Custodial reserve floor exceeds treasury custody",
      detail: "The reserve floor excludes sponsored debt already deployed to providers. Stop new line activity and reconcile contract balances before any further sponsor transaction.",
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

  const status = !observedFloorCovered || defaulted.length > 0
    ? "critical"
    : input.degraded || !scopeComplete
      ? "degraded"
      : expiredDebtOpen.length > 0
        ? "attention"
        : "healthy";

  return {
    status,
    source: input.source,
    reserve: {
      solvent,
      scopeComplete,
      observedFloorCovered,
      treasuryBalanceUSDC: treasury.toString(),
      sponsoredReserveUSDC: sponsoredReserve.toString(),
      observedSponsoredReserveUSDC: observedSponsoredReserve.toString(),
      sponsoredDebtDeployedUSDC: sponsoredDebtDeployed.toString(),
      custodialReserveFloorUSDC: custodialReserveFloor.toString(),
      surplusUSDC: (treasury > custodialReserveFloor ? treasury - custodialReserveFloor : 0n).toString(),
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
