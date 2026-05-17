// AI Pilot: takes a follower's deposit and risk profile, returns a weighted
// allocation across registered source agents with reasoning. Selects which
// sources to follow, weights how much USDC to send to each, and emits watch
// signals the monitor can use to detect drift.
//
// Aligns Shadow with Canteen RFB 06 (Social Trading Intelligence): the AI
// selects, weights, and monitors. The follower stops being a manual picker
// and becomes a depositor with a goal; the Pilot is the agent that acts.
//
// Safety: the model output is parsed strictly, weights are normalized to sum
// to exactly 10000 bps, and amounts are clamped so the largest single follow
// can never exceed the user's deposit. If Bankr is unreachable, a heuristic
// fallback ranks sources by mirror fees earned and realized PnL.

export const config = { maxDuration: 60 };

const LLM_TIMEOUT_MS = 50000;

const BANKR_URL = "https://llm.bankr.bot/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-v3.2";
const PRESETS = ["conservative", "balanced", "aggressive"] as const;
type Preset = (typeof PRESETS)[number];

type SourceInput = {
  address: string;
  name: string;
  intentsPublished: number;
  copyCount: number;
  blockCount: number;
  copyRateBps: number;
  routedUSDC: string;
  mirrorFeesUSDC: string;
  closedCount: number;
  realizedPnlAvgBps: number | null;
};

type PilotRequest = {
  amountUSDC: string;
  risk: "low" | "balanced" | "high";
  sources: SourceInput[];
};

type Slice = {
  sourceAddress: string;
  name: string;
  weightBps: number;
  preset: Preset;
  amountUSDC: string;
  reason: string;
};

type PilotResponse = {
  model: string;
  fellBack: boolean;
  fellBackReason?: string;
  headline: string;
  confidenceBps: number;
  rationale: string;
  watchSignals: string[];
  allocation: Slice[];
  generatedAt: number;
  decisionHash: string;
};

type VercelLikeRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type VercelLikeResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
};

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if ((req.method || "POST") !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method not allowed, use POST" });
    return;
  }

  let parsed: PilotRequest;
  try {
    parsed = parseBody(req.body);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const amount = Number(parsed.amountUSDC);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amountUSDC must be a positive decimal" });
    return;
  }
  if (parsed.sources.length === 0) {
    res.status(400).json({ error: "no sources to allocate across" });
    return;
  }

  try {
    const llm = await decideWithLLM(parsed);
    const response: PilotResponse = {
      ...llm,
      generatedAt: Math.floor(Date.now() / 1000),
      decisionHash: await hashDecision(parsed, llm.allocation),
    };
    res.status(200).json(response);
  } catch (error) {
    const fallback = heuristic(parsed, `pilot error ${(error as Error).message}`);
    const response: PilotResponse = {
      ...fallback,
      generatedAt: Math.floor(Date.now() / 1000),
      decisionHash: await hashDecision(parsed, fallback.allocation),
    };
    res.status(200).json(response);
  }
}

function parseBody(raw: unknown): PilotRequest {
  const body = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!body || typeof body !== "object") throw new Error("body must be JSON");
  const obj = body as Record<string, unknown>;
  const amountUSDC = String(obj.amountUSDC || "");
  const risk = obj.risk;
  if (risk !== "low" && risk !== "balanced" && risk !== "high") {
    throw new Error("risk must be one of low | balanced | high");
  }
  if (!Array.isArray(obj.sources)) throw new Error("sources must be an array");
  const sources: SourceInput[] = obj.sources.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`sources[${i}] not an object`);
    const item = s as Record<string, unknown>;
    return {
      address: String(item.address || ""),
      name: String(item.name || `source-${i}`),
      intentsPublished: Number(item.intentsPublished || 0),
      copyCount: Number(item.copyCount || 0),
      blockCount: Number(item.blockCount || 0),
      copyRateBps: Number(item.copyRateBps || 0),
      routedUSDC: String(item.routedUSDC || "0"),
      mirrorFeesUSDC: String(item.mirrorFeesUSDC || "0"),
      closedCount: Number(item.closedCount || 0),
      realizedPnlAvgBps: item.realizedPnlAvgBps == null ? null : Number(item.realizedPnlAvgBps),
    };
  });
  return { amountUSDC, risk, sources };
}

async function decideWithLLM(req: PilotRequest): Promise<Omit<PilotResponse, "generatedAt" | "decisionHash">> {
  const apiKey = process.env.BANKR_LLM_KEY?.trim();
  if (!apiKey) return heuristic(req, "BANKR_LLM_KEY missing");
  const model = (process.env.BANKR_LLM_MODEL || DEFAULT_MODEL).trim();
  const prompt = buildPrompt(req);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(BANKR_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a copy-trade portfolio manager allocating a follower's USDC across registered source agents. Reply with ONE JSON object only, no prose. Schema: {\"headline\":string, \"confidenceBps\":number, \"rationale\":string, \"watchSignals\":string[], \"allocation\":[{\"sourceAddress\":string,\"weightBps\":number,\"preset\":\"conservative\"|\"balanced\"|\"aggressive\",\"reason\":string}]}. weightBps for each slice is 0-10000; sum across allocation must equal 10000. confidenceBps is 0-10000. watchSignals is 0-4 short imperative sentences describing what would invalidate the plan. allocation MUST only reference sources you were given.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 700,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return heuristic(req, `bankr http ${res.status}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return heuristic(req, "empty completion");
    const parsed = safeParse(raw);
    if (!parsed) return heuristic(req, "non-JSON completion");
    return clamp(parsed, req, model);
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "bankr timeout" : `bankr error ${(err as Error).message}`;
    return heuristic(req, msg);
  } finally {
    clearTimeout(abortTimer);
  }
}

function buildPrompt(req: PilotRequest): string {
  const lines: string[] = [
    `Follower deposit: ${req.amountUSDC} USDC.`,
    `Risk profile: ${req.risk}.`,
    `Available source agents (${req.sources.length}):`,
  ];
  for (const s of req.sources) {
    const pnl = s.realizedPnlAvgBps == null ? "no closed positions yet" : `${s.realizedPnlAvgBps.toFixed(1)} bps avg`;
    lines.push(
      `- ${s.name} sourceAddress=${s.address}: ${s.intentsPublished} intents, ${s.copyCount} copies, ${s.blockCount} blocks, copyRate=${(s.copyRateBps / 100).toFixed(1)}%, routed=${s.routedUSDC} USDC, mirrorFees=${s.mirrorFeesUSDC} USDC, closes=${s.closedCount}, realizedPnL=${pnl}.`,
    );
  }
  lines.push("", "When you echo sourceAddress in the allocation, copy the EXACT 0x... value above. Do not truncate.");
  lines.push(
    "",
    "Pick 1 to 3 sources to allocate across. The sum of weightBps MUST equal 10000.",
    "Match each slice to a preset:",
    "- conservative: maxRisk=1, minBpsOut tight, daily cap conservative.",
    "- balanced: maxRisk=2, moderate slippage tolerance.",
    "- aggressive: maxRisk=3, wider slippage and larger daily caps.",
    "Risk profile maps roughly: low -> mostly conservative, balanced -> balanced, high -> mostly aggressive.",
    "Penalize sources with no closes (no proof of realized PnL) by reducing weight or skipping.",
    "If only one source is acceptable, return a single-slice allocation with weightBps=10000.",
    "Headline is 1 short sentence summarizing the plan.",
    "Rationale is 2-4 sentences explaining the picks.",
    "watchSignals are 1-3 short triggers that would make the follower want to revisit (e.g., 'rebalance if CatAgent realized PnL drops below 0 over next 3 closes').",
  );
  return lines.join("\n");
}

function safeParse(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clamp(
  parsed: Record<string, unknown>,
  req: PilotRequest,
  model: string,
): Omit<PilotResponse, "generatedAt" | "decisionHash"> {
  const allocationRaw = Array.isArray(parsed.allocation) ? parsed.allocation : [];
  const addressSet = new Map(req.sources.map((s) => [s.address.toLowerCase(), s]));
  const slicesRaw: Array<{ source: SourceInput; weightBps: number; preset: Preset; reason: string }> = [];
  for (const entry of allocationRaw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const addr = String(item.sourceAddress || "").toLowerCase();
    const source = addressSet.get(addr);
    if (!source) continue;
    const w = Number(item.weightBps);
    if (!Number.isFinite(w) || w <= 0) continue;
    const presetRaw = String(item.preset || "balanced").toLowerCase();
    const preset = (PRESETS as readonly string[]).includes(presetRaw)
      ? (presetRaw as Preset)
      : presetForRisk(req.risk);
    const reason = typeof item.reason === "string" ? item.reason.slice(0, 240) : "";
    slicesRaw.push({ source, weightBps: Math.min(10_000, Math.round(w)), preset, reason });
  }
  if (slicesRaw.length === 0) {
    return heuristic(req, "model returned no valid allocation");
  }
  // Normalize weights to sum to 10_000.
  const totalRaw = slicesRaw.reduce((sum, s) => sum + s.weightBps, 0) || 1;
  let allocated = 0;
  const allocation: Slice[] = slicesRaw.map((s, idx, all) => {
    const isLast = idx === all.length - 1;
    const weightBps = isLast
      ? 10_000 - allocated
      : Math.max(1, Math.round((s.weightBps / totalRaw) * 10_000));
    allocated += weightBps;
    const amountUSDC = ((Number(req.amountUSDC) * weightBps) / 10_000).toFixed(4).replace(/\.?0+$/, "");
    return {
      sourceAddress: s.source.address,
      name: s.source.name,
      weightBps,
      preset: s.preset,
      amountUSDC: amountUSDC || "0",
      reason: s.reason,
    };
  });
  const headline =
    typeof parsed.headline === "string" && parsed.headline.trim().length > 0
      ? parsed.headline.slice(0, 240)
      : defaultHeadline(allocation);
  const rationale =
    typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
      ? parsed.rationale.slice(0, 800)
      : "AI provided no rationale; allocation derived from weights only.";
  const confidenceRaw = Number(parsed.confidenceBps);
  const modelConfidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(10_000, Math.round(confidenceRaw)))
    : 5_000;
  const derivedConfidence = weightedCopyRate(allocation, req.sources);
  // deepseek consistently stubs confidenceBps at 0 even on solid allocations.
  // When the model gives us a near zero, prefer the weighted copy rate of the
  // chosen sources so the UI shows a number grounded in onchain truth.
  const confidenceBps = modelConfidence < 1_000 && derivedConfidence > 0 ? derivedConfidence : modelConfidence;
  const watchSignalsRaw = Array.isArray(parsed.watchSignals) ? parsed.watchSignals : [];
  const watchSignals = watchSignalsRaw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .slice(0, 4)
    .map((x) => x.slice(0, 240));
  return {
    model,
    fellBack: false,
    headline,
    confidenceBps,
    rationale,
    watchSignals,
    allocation,
  };
}

function weightedCopyRate(allocation: Slice[], sources: SourceInput[]): number {
  if (allocation.length === 0) return 0;
  const byAddr = new Map(sources.map((s) => [s.address.toLowerCase(), s]));
  let totalWeight = 0;
  let weightedRate = 0;
  for (const slice of allocation) {
    const src = byAddr.get(slice.sourceAddress.toLowerCase());
    if (!src) continue;
    const sample = src.copyCount + src.blockCount;
    if (sample === 0) continue;
    totalWeight += slice.weightBps;
    weightedRate += src.copyRateBps * slice.weightBps;
  }
  return totalWeight > 0 ? Math.round(weightedRate / totalWeight) : 0;
}

function heuristic(req: PilotRequest, reason: string): Omit<PilotResponse, "generatedAt" | "decisionHash"> {
  // Rank sources by a composite score, then pick top 1-3 with proportional weights.
  // Score components:
  //   - copy rate scaled by sample size (sigmoid-ish)
  //   - realized PnL (positive only; negatives drag toward zero weight)
  //   - mirror fees earned (proxy for trust)
  const scored = req.sources
    .map((s) => {
      const sample = s.copyCount + s.blockCount;
      const trust = sample === 0 ? 0 : (s.copyRateBps / 10_000) * Math.min(1, sample / 8);
      const pnl = s.realizedPnlAvgBps == null ? 0 : Math.max(-1, Math.min(1, s.realizedPnlAvgBps / 200));
      const fees = Number(s.mirrorFeesUSDC) || 0;
      const score = trust * 0.5 + pnl * 0.3 + Math.min(1, fees / 1) * 0.2;
      return { source: s, score: Math.max(0.01, score) };
    })
    .sort((a, b) => b.score - a.score);

  const topN = req.risk === "high" ? 3 : req.risk === "balanced" ? 2 : 1;
  const picks = scored.slice(0, Math.min(topN, scored.length));
  const totalScore = picks.reduce((sum, p) => sum + p.score, 0) || 1;

  let allocated = 0;
  const allocation: Slice[] = picks.map((p, idx, all) => {
    const isLast = idx === all.length - 1;
    const weightBps = isLast
      ? 10_000 - allocated
      : Math.max(500, Math.round((p.score / totalScore) * 10_000));
    allocated += weightBps;
    const preset = presetForRisk(req.risk);
    const amountUSDC = ((Number(req.amountUSDC) * weightBps) / 10_000).toFixed(4).replace(/\.?0+$/, "");
    return {
      sourceAddress: p.source.address,
      name: p.source.name,
      weightBps,
      preset,
      amountUSDC: amountUSDC || "0",
      reason: heuristicReason(p.source),
    };
  });
  return {
    model: "heuristic",
    fellBack: true,
    fellBackReason: reason,
    headline: defaultHeadline(allocation),
    confidenceBps: 4_000,
    rationale:
      "Heuristic ranking used: composite of follower copy rate (scaled by sample size), realized PnL trend, and mirror fees earned. The LLM was unavailable or returned an unusable response.",
    watchSignals: [
      "Rebalance if the top source's realized PnL turns negative over 3 closes.",
      "Pause a slice if its copy rate drops below 50% over the next 5 intents.",
    ],
    allocation,
  };
}

function presetForRisk(risk: PilotRequest["risk"]): Preset {
  if (risk === "low") return "conservative";
  if (risk === "high") return "aggressive";
  return "balanced";
}

function heuristicReason(s: SourceInput): string {
  const parts: string[] = [];
  parts.push(`${s.copyCount} copies / ${s.blockCount} blocks`);
  if (s.closedCount > 0 && s.realizedPnlAvgBps != null) {
    parts.push(`realized PnL ${s.realizedPnlAvgBps.toFixed(1)} bps over ${s.closedCount} closes`);
  } else {
    parts.push("no closed positions yet");
  }
  return parts.join("; ");
}

function defaultHeadline(allocation: Slice[]): string {
  if (allocation.length === 1) return `Concentrate 100% in ${allocation[0].name}.`;
  return `Allocate across ${allocation.map((a) => `${a.name} (${(a.weightBps / 100).toFixed(0)}%)`).join(", ")}.`;
}

function shortAddr(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function hashDecision(req: PilotRequest, allocation: Slice[]): Promise<string> {
  const canon = JSON.stringify({
    amountUSDC: req.amountUSDC,
    risk: req.risk,
    sources: req.sources.map((s) => s.address.toLowerCase()).sort(),
    allocation: allocation.map((a) => ({
      addr: a.sourceAddress.toLowerCase(),
      weightBps: a.weightBps,
      preset: a.preset,
    })),
  });
  const cryptoApi: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoApi || !cryptoApi.subtle) {
    return "0x" + simpleHash(canon);
  }
  const bytes = new TextEncoder().encode(canon);
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function simpleHash(s: string): string {
  // Tiny fallback if Web Crypto is unavailable in the runtime.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
