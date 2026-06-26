#!/usr/bin/env node

const DEFAULT_BASE_URL = "https://shadow-arc.vercel.app";
const baseUrl = (process.env.SHADOW_APP_URL || process.env.VITE_APP_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

const checks = [];

function addCheck(name, pass, detail = undefined) {
  checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
}

async function fetchJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  }
  return json;
}

function atomicToFloat(value) {
  const atomic = BigInt(String(value || "0"));
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const floatState = await fetchJson("/api/float");
const agents = Array.isArray(floatState?.standingBoard?.agents) ? floatState.standingBoard.agents : [];
addCheck("float_api_configured", floatState?.configured === true, { receiptCount: floatState?.receiptCount });
addCheck("standing_board_has_agents", agents.length > 0, { agents: agents.length });

const scoreRows = [];
for (const agent of agents) {
  const address = agent.agent;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) continue;
  const score = await fetchJson(`/api/float-tools?action=score&address=${address}`);
  const row = {
    agent: address,
    label: score.label,
    status: agent.status,
    currentScore: score.currentLine?.score,
    computedScore: score.computed?.score,
    recommendedLimit: atomicToFloat(score.computed?.recommendedLimitUSDC),
    evidenceMode: score.evidenceMode,
    paidBound: score.evidence?.paidBound ?? 0,
    signedExternalPaidBound: score.evidence?.signedExternalPaidBound ?? 0,
    repaid: score.evidence?.repaid ?? 0,
    blocked: score.evidence?.blocked ?? 0,
    denied: score.evidence?.denied ?? 0,
    lineSupported: score.supportCheck?.currentLineSupportedByComputedV0 === true,
    receiptLogsIndexed: score.evidenceCompleteness?.receiptLogsIndexed,
    logFetchComplete: score.evidenceCompleteness?.logFetchComplete === true,
    receiptCountMatchesChain: score.evidenceCompleteness?.indexedReceiptCountMatchesChain === true,
  };
  scoreRows.push(row);
}

const scored = scoreRows.length > 0;
const receiptDerived = scoreRows.every((row) => row.evidenceMode === "receipt-derived");
const complete = scoreRows.every((row) => row.logFetchComplete && row.receiptCountMatchesChain);
const supportedRows = scoreRows.filter((row) => row.lineSupported);
const repaidExternalRows = scoreRows.filter((row) => row.label === "invited" && row.status === "REPAID");
const repaidEvidenceRows = repaidExternalRows.filter((row) => row.repaid > 0);

addCheck("score_endpoint_returns_rows", scored, { rows: scoreRows.length });
addCheck("score_evidence_is_receipt_derived", receiptDerived, {
  modes: [...new Set(scoreRows.map((row) => row.evidenceMode || "missing"))],
});
addCheck("score_receipt_index_complete", complete, {
  incomplete: scoreRows
    .filter((row) => !row.logFetchComplete || !row.receiptCountMatchesChain)
    .map((row) => row.agent),
});
addCheck("current_lines_supported_by_computed_v0", supportedRows.length === scoreRows.length, {
  supported: supportedRows.length,
  total: scoreRows.length,
  unsupported: scoreRows.filter((row) => !row.lineSupported).map((row) => row.agent),
});
addCheck("repaid_external_agents_counted_from_receipts", repaidExternalRows.length === 0 || repaidEvidenceRows.length === repaidExternalRows.length, {
  repaidExternalAgents: repaidExternalRows.length,
  countedWithRepaidEvidence: repaidEvidenceRows.length,
});

const ok = checks.every((check) => check.pass);
const output = {
  ok,
  baseUrl,
  float: floatState?.float,
  receiptCount: floatState?.receiptCount,
  checks,
  scoreRows,
  generatedAt: new Date().toISOString(),
};

console.log(JSON.stringify(output, null, 2));
if (!ok) process.exit(1);
