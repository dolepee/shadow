// Real LLM reasoning for source agents. Wraps the Bankr LLM gateway
// (OpenAI-compatible) and returns a constrained decision the publisher can use.
//
// Safety: the model's numeric choices are clamped to operational ranges so a
// hallucinated value can't push an oversized trade or a meaningless slippage
// bound. If the call fails or the JSON is unusable, the caller falls back to
// the env defaults — the agent still publishes, just without LLM reasoning.

const BANKR_URL = "https://llm.bankr.bot/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-v3.2";

export type LLMContext = {
  sourceName: string;
  mandate: string;
  reserveUSDC: bigint;
  reserveAsset: bigint;
  liveQuote: bigint;
  defaultAmountUSDC: string;
  defaultMinBps: number;
  defaultRiskLevel: number;
  amountFloor: string;
  amountCeiling: string;
  minBpsFloor: number;
  minBpsCeiling: number;
};

export type LLMDecision = {
  amountUSDC: string;
  minBps: number;
  riskLevel: number;
  regime: string;
  rationale: string;
  model: string;
  fellBack: boolean;
};

export async function decideWithLLM(ctx: LLMContext): Promise<LLMDecision> {
  const apiKey = process.env.BANKR_LLM_KEY;
  if (!apiKey) {
    return fallback(ctx, "BANKR_LLM_KEY missing");
  }
  const model = (process.env.BANKR_LLM_MODEL || DEFAULT_MODEL).trim();
  const prompt = buildPrompt(ctx);
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
              "You are a quant agent publishing trade intents on a small testnet AMM. Reply with ONE JSON object only, no prose. Schema: {\"amountUSDC\":string, \"minBps\":number, \"riskLevel\":number, \"regime\":string, \"rationale\":string}. amountUSDC is a decimal string. minBps is an integer between 9000 and 10500. riskLevel is 1, 2, or 3. regime is a short label like 'thin-liquidity' or 'mean-revert'. rationale is one sentence.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 400,
        temperature: 0.4,
      }),
    });
    if (!res.ok) {
      return fallback(ctx, `bankr http ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return fallback(ctx, "empty completion");
    const parsed = safeParse(raw);
    if (!parsed) return fallback(ctx, "non-JSON completion");
    return clamp(parsed, ctx, model);
  } catch (err) {
    return fallback(ctx, `bankr error ${(err as Error).message}`);
  }
}

function buildPrompt(ctx: LLMContext): string {
  const spot = Number(ctx.reserveAsset) / 1e18 / (Number(ctx.reserveUSDC) / 1e6 || 1);
  const poolUSDC = Number(ctx.reserveUSDC) / 1e6;
  const quote = Number(ctx.liveQuote) / 1e18;
  return [
    `Source agent: ${ctx.sourceName}`,
    `Mandate: ${ctx.mandate}`,
    `Pool reserves: ${poolUSDC.toFixed(4)} USDC, ${(Number(ctx.reserveAsset) / 1e18).toFixed(6)} ARCETH.`,
    `Spot: 1 USDC ≈ ${spot.toFixed(8)} ARCETH.`,
    `Quote for default ${ctx.defaultAmountUSDC} USDC trade: ${quote.toFixed(8)} ARCETH.`,
    `Choose amountUSDC in [${ctx.amountFloor}, ${ctx.amountCeiling}] (must keep within pool depth).`,
    `Choose minBps in [${ctx.minBpsFloor}, ${ctx.minBpsCeiling}] (10000 = no slippage, 9500 = 5% allowed).`,
    `Pick riskLevel 1 (safe), 2 (balanced), or 3 (aggressive) consistent with your mandate.`,
    `Write a one-sentence rationale that names the regime you see and how it justifies your numbers.`,
  ].join("\n");
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

function clamp(parsed: Record<string, unknown>, ctx: LLMContext, model: string): LLMDecision {
  const amountUSDC = clampAmount(
    typeof parsed.amountUSDC === "string" ? parsed.amountUSDC : String(parsed.amountUSDC ?? ctx.defaultAmountUSDC),
    ctx,
  );
  const minBpsRaw = Number(parsed.minBps ?? ctx.defaultMinBps);
  const minBps = Number.isFinite(minBpsRaw)
    ? Math.max(ctx.minBpsFloor, Math.min(ctx.minBpsCeiling, Math.round(minBpsRaw)))
    : ctx.defaultMinBps;
  const riskRaw = Number(parsed.riskLevel ?? ctx.defaultRiskLevel);
  const riskLevel = Number.isFinite(riskRaw) ? Math.max(1, Math.min(3, Math.round(riskRaw))) : ctx.defaultRiskLevel;
  const regime = typeof parsed.regime === "string" ? parsed.regime.slice(0, 64) : "unspecified";
  const rationale =
    typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
      ? parsed.rationale.slice(0, 320)
      : `${ctx.sourceName} acted on default policy (LLM did not produce a rationale).`;
  return { amountUSDC, minBps, riskLevel, regime, rationale, model, fellBack: false };
}

function clampAmount(value: string, ctx: LLMContext): string {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return ctx.defaultAmountUSDC;
  const floor = Number(ctx.amountFloor);
  const ceiling = Number(ctx.amountCeiling);
  const clamped = Math.max(floor, Math.min(ceiling, v));
  // Round to 4 decimal places (USDC has 6, but trim noise from LLM output).
  return clamped.toFixed(4).replace(/\.?0+$/, "") || ctx.defaultAmountUSDC;
}

function fallback(ctx: LLMContext, reason: string): LLMDecision {
  return {
    amountUSDC: ctx.defaultAmountUSDC,
    minBps: ctx.defaultMinBps,
    riskLevel: ctx.defaultRiskLevel,
    regime: "fallback",
    rationale: `${ctx.sourceName} used default policy (${reason}).`,
    model: "fallback",
    fellBack: true,
  };
}
