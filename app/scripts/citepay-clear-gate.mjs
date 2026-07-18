import { createHash } from "node:crypto";

const DEFAULT_API_BASE = "https://citepay-markets.vercel.app";
const DEFAULT_TIMEOUT_MS = 15_000;
const CLEAR_DECISIONS = new Set([
  "CLEARED",
  "UNSUPPORTED",
  "BLOCKED_LICENSE",
  "BLOCKED_POLICY",
  "OVER_CAP",
  "PENDING",
]);

export class CitePayClearGateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CitePayClearGateError";
    this.code = code;
    this.details = details;
  }
}

export async function runCitePayClearGate({
  env,
  payload,
  requestHash,
  signedReason,
  provider,
  endpointHash,
  amountUSDC,
  fetchImpl = globalThis.fetch,
}) {
  if (clean(env.CITEPAY_CLEAR_ENABLED) !== "1") {
    return { enabled: false, status: "disabled" };
  }

  if (typeof fetchImpl !== "function") {
    throw new CitePayClearGateError("fetch_unavailable", "CitePay Clear requires a fetch implementation");
  }

  const apiKey = clean(env.CITEPAY_API_KEY);
  if (!apiKey?.startsWith("cpk_")) {
    throw new CitePayClearGateError(
      "api_key_missing",
      "CITEPAY_API_KEY must contain the scoped cpk_ key when CitePay Clear is enabled",
    );
  }

  const mandateConfigId = clean(env.CITEPAY_CLEAR_MANDATE_ID);
  if (!mandateConfigId?.startsWith("mnd_")) {
    throw new CitePayClearGateError(
      "mandate_missing",
      "CITEPAY_CLEAR_MANDATE_ID must contain the server-owned mnd_ mandate when CitePay Clear is enabled",
    );
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(requestHash || "")) {
    throw new CitePayClearGateError("request_hash_invalid", "Float requestHash must be a bytes32 hex value");
  }

  const clearInput = normalizeClearInput(payload?.citepayClear);
  const inputCommitment = commitmentForNormalizedInput(clearInput);
  const expectedReason = `citepay-clear:${inputCommitment}`;
  if (signedReason !== expectedReason) {
    throw new CitePayClearGateError(
      "input_unbound",
      "signed intent.reason does not commit to the supplied CitePay Clear input",
      { expectedReason },
    );
  }

  const expectedProvider = normalizeAddress(env.CITEPAY_CLEAR_PROVIDER, "CITEPAY_CLEAR_PROVIDER");
  if (normalizeAddress(provider, "intent.provider") !== expectedProvider) {
    throw new CitePayClearGateError(
      "provider_mismatch",
      `CitePay Clear is enabled only for provider ${expectedProvider}`,
    );
  }

  const expectedEndpointHash = normalizeBytes32(env.CITEPAY_CLEAR_ENDPOINT_HASH, "CITEPAY_CLEAR_ENDPOINT_HASH");
  if (normalizeBytes32(endpointHash, "intent.endpointHash") !== expectedEndpointHash) {
    throw new CitePayClearGateError(
      "endpoint_mismatch",
      `CitePay Clear is enabled only for endpoint hash ${expectedEndpointHash}`,
    );
  }

  const paymentAmount = normalizeAtomicAmount(amountUSDC);
  const baseUrl = normalizeBaseUrl(clean(env.CITEPAY_CLEAR_API_BASE) || DEFAULT_API_BASE);
  const requestTimeoutMs = timeoutMs(env.CITEPAY_CLEAR_TIMEOUT_MS);
  const requestBody = {
    claim: clearInput.claim,
    quote: clearInput.quote,
    source: clearInput.source,
    policy: { mandateConfigId },
    externalRef: requestHash,
    visibility: normalizeVisibility(env.CITEPAY_CLEAR_VISIBILITY),
  };

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/clear/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new CitePayClearGateError(
      "request_failed",
      `CitePay Clear request failed before any Float write: ${safeMessage(error, apiKey)}`,
    );
  }

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CitePayClearGateError(
      "api_rejected",
      `CitePay Clear rejected the request with HTTP ${response.status}: ${safeError(body, apiKey)}`,
      { httpStatus: response.status },
    );
  }

  if (!CLEAR_DECISIONS.has(body?.decision)) {
    throw new CitePayClearGateError(
      "response_invalid",
      "CitePay Clear returned an unknown or missing decision",
    );
  }

  if (body.decision !== "CLEARED") {
    throw new CitePayClearGateError(
      "not_cleared",
      `CitePay Clear decision ${body.decision}; refusing the Float spend before any on-chain write`,
      {
        decision: body.decision,
        clearanceId: stringOrNull(body.clearanceId),
        receiptUrl: stringOrNull(body.receiptUrl),
      },
    );
  }

  if (body?.checks?.quoteVerified !== true) {
    throw new CitePayClearGateError(
      "quote_unverified",
      "CitePay returned CLEARED without verifying the exact quote; refusing the Float spend",
      {
        clearanceId: stringOrNull(body.clearanceId),
        supportScore: Number.isFinite(body?.checks?.supportScore) ? Number(body.checks.supportScore) : null,
      },
    );
  }

  const clearedPrice = body?.checks?.priceMicro;
  if (!Number.isSafeInteger(clearedPrice) || BigInt(clearedPrice) !== paymentAmount) {
    throw new CitePayClearGateError(
      "amount_mismatch",
      "CitePay clearance price does not equal the signed Float payment amount",
      {
        signedAmountUSDC: paymentAmount.toString(),
        clearedPriceMicro: Number.isSafeInteger(clearedPrice) ? clearedPrice : null,
      },
    );
  }

  const returnedExternalRef = stringOrNull(body.externalRef);
  if (returnedExternalRef?.toLowerCase() !== requestHash.toLowerCase()) {
    throw new CitePayClearGateError(
      "clearance_unbound",
      "CitePay Clear did not return the exact Float requestHash as externalRef; refusing an unbound clearance",
      {
        clearanceId: stringOrNull(body.clearanceId),
        expectedExternalRef: requestHash,
        returnedExternalRef,
      },
    );
  }

  const clearanceId = stringOrNull(body.clearanceId);
  const receiptUrl = stringOrNull(body.receiptUrl);
  const contentHash = stringOrNull(body.contentHash);
  if (
    !clearanceId?.startsWith("clr_")
    || !receiptUrl
    || !/^sha256:[0-9a-fA-F]{64}$/.test(contentHash || "")
  ) {
    throw new CitePayClearGateError(
      "response_invalid",
      "CitePay Clear returned CLEARED without a complete clearance receipt",
    );
  }

  const persisted = await verifyPersistedClearance({
    baseUrl,
    clearanceId,
    contentHash,
    externalRef: requestHash,
    paymentAmount,
    fetchImpl,
    requestTimeoutMs,
  });

  return {
    enabled: true,
    status: "cleared",
    decision: "CLEARED",
    clearanceId,
    receiptUrl,
    contentHash,
    clearanceHash: contentHash,
    externalRef: returnedExternalRef,
    inputCommitment,
    persisted,
    checks: sanitizeChecks(body.checks),
  };
}

export function citePayClearCommitment(value) {
  return commitmentForNormalizedInput(normalizeClearInput(value));
}

function normalizeClearInput(value) {
  if (!isObject(value)) {
    throw new CitePayClearGateError(
      "input_missing",
      "signed intent JSON must include citepayClear when CitePay Clear is enabled",
    );
  }

  const claim = requiredString(value.claim, "citepayClear.claim", 1_000);
  const quote = requiredString(value.quote, "citepayClear.quote", 2_000);
  if (!isObject(value.source)) {
    throw new CitePayClearGateError("source_invalid", "citepayClear.source must be an object");
  }

  const hasOnChainId = value.source.onChainId !== undefined && value.source.onChainId !== null && value.source.onChainId !== "";
  const hasText = typeof value.source.text === "string" && value.source.text.trim().length > 0;
  if (hasOnChainId === hasText) {
    throw new CitePayClearGateError(
      "source_invalid",
      "citepayClear.source must contain exactly one of onChainId or text",
    );
  }

  if (hasOnChainId) {
    const onChainId = String(value.source.onChainId).trim();
    if (!/^\d+$/.test(onChainId)) {
      throw new CitePayClearGateError("source_invalid", "citepayClear.source.onChainId must be numeric");
    }
    return { claim, quote, source: { onChainId } };
  }

  const source = {
    text: requiredString(value.source.text, "citepayClear.source.text", 20_000),
  };
  const label = optionalString(value.source.label, "citepayClear.source.label", 200);
  const licenseClass = optionalString(value.source.licenseClass, "citepayClear.source.licenseClass", 64);
  if (label) source.label = label;
  if (licenseClass) source.licenseClass = licenseClass;
  if (value.source.priceMicro !== undefined) {
    if (!Number.isInteger(value.source.priceMicro) || value.source.priceMicro < 0 || value.source.priceMicro > 1_000_000_000) {
      throw new CitePayClearGateError(
        "source_invalid",
        "citepayClear.source.priceMicro must be a non-negative integer micro-USDC amount",
      );
    }
    source.priceMicro = value.source.priceMicro;
  }
  return { claim, quote, source };
}

function commitmentForNormalizedInput(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function parseJsonResponse(response) {
  if (!response || typeof response.text !== "function") {
    throw new CitePayClearGateError("response_invalid", "CitePay Clear returned an invalid HTTP response");
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new CitePayClearGateError("response_invalid", "CitePay Clear response body could not be read");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CitePayClearGateError("response_invalid", "CitePay Clear returned non-JSON data");
  }
}

async function verifyPersistedClearance({
  baseUrl,
  clearanceId,
  contentHash,
  externalRef,
  paymentAmount,
  fetchImpl,
  requestTimeoutMs,
}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/clear/${encodeURIComponent(clearanceId)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new CitePayClearGateError(
      "clearance_lookup_failed",
      `CitePay persisted-clearance lookup failed before any Float write: ${error instanceof Error ? error.message : String(error)}`,
      { clearanceId },
    );
  }

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CitePayClearGateError(
      "clearance_lookup_failed",
      `CitePay persisted-clearance lookup returned HTTP ${response.status}: ${safeError(body)}`,
      { clearanceId, httpStatus: response.status },
    );
  }

  const persisted = body?.clearance;
  const persistedExternalRef = stringOrNull(body?.externalRef);
  const persistedContentHash = stringOrNull(body?.contentHash);
  const persistedAmount = persisted?.amountDueMicro;
  const matches =
    body?.decision === "CLEARED"
    && persisted?.decision === "CLEARED"
    && persisted?.clearanceId === clearanceId
    && persisted?.quoteVerified === true
    && Number.isSafeInteger(persistedAmount)
    && BigInt(persistedAmount) === paymentAmount
    && persistedExternalRef?.toLowerCase() === externalRef.toLowerCase()
    && stringOrNull(persisted?.externalRef)?.toLowerCase() === externalRef.toLowerCase()
    && persistedContentHash?.toLowerCase() === contentHash.toLowerCase()
    && body?.settlement === null;

  if (!matches) {
    throw new CitePayClearGateError(
      "clearance_persistence_mismatch",
      "CitePay public clearance does not exactly match the cleared Float request",
      { clearanceId },
    );
  }

  return {
    verified: true,
    clearanceId,
    decision: "CLEARED",
    externalRef: persistedExternalRef,
    contentHash: persistedContentHash,
    quoteVerified: true,
    amountDueMicro: persistedAmount,
    settlement: null,
  };
}

function sanitizeChecks(value) {
  if (!isObject(value)) return null;
  return {
    quoteVerified: value.quoteVerified === true,
    supportScore: Number.isFinite(value.supportScore) ? Number(value.supportScore) : null,
    supportScoreMethod: stringOrNull(value.supportScoreMethod),
    licenseClass: stringOrNull(value.licenseClass),
    priceMicro: Number.isInteger(value.priceMicro) ? value.priceMicro : null,
    budgetRemainingMicro: Number.isInteger(value.budgetRemainingMicro) ? value.budgetRemainingMicro : null,
  };
}

function safeError(body, apiKey = null) {
  if (typeof body?.error !== "string") return "unknown error";
  let value = body.error.slice(0, 300).replace(/cpk_[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (apiKey) value = value.replaceAll(apiKey, "[REDACTED]");
  return value;
}

function safeMessage(error, apiKey = null) {
  const raw = error instanceof Error ? error.message : String(error);
  let value = raw.slice(0, 300).replace(/cpk_[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (apiKey) value = value.replaceAll(apiKey, "[REDACTED]");
  return value;
}

function requiredString(value, field, max) {
  const result = optionalString(value, field, max);
  if (!result) throw new CitePayClearGateError("input_invalid", `${field} is required`);
  return result;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new CitePayClearGateError("input_invalid", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new CitePayClearGateError("input_invalid", `${field} exceeds ${max} characters`);
  return trimmed;
}

function normalizeVisibility(value) {
  const visibility = clean(value) || "private_hash_only";
  if (visibility !== "private_hash_only" && visibility !== "public") {
    throw new CitePayClearGateError(
      "visibility_invalid",
      "CITEPAY_CLEAR_VISIBILITY must be private_hash_only or public",
    );
  }
  return visibility;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CitePayClearGateError("api_url_invalid", "CITEPAY_CLEAR_API_BASE must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new CitePayClearGateError("api_url_invalid", "CITEPAY_CLEAR_API_BASE must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeAddress(value, field) {
  const normalized = clean(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(normalized || "")) {
    throw new CitePayClearGateError("binding_config_invalid", `${field} must be a 20-byte hex address`);
  }
  return normalized.toLowerCase();
}

function normalizeBytes32(value, field) {
  const normalized = clean(value);
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized || "")) {
    throw new CitePayClearGateError("binding_config_invalid", `${field} must be a bytes32 hex value`);
  }
  return normalized.toLowerCase();
}

function normalizeAtomicAmount(value) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new CitePayClearGateError("amount_invalid", "intent.amountUSDC must be an integer micro-USDC amount");
  }
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CitePayClearGateError("amount_invalid", "intent.amountUSDC is outside the supported Clear range");
  }
  return parsed;
}

function timeoutMs(value) {
  const parsed = Number(clean(value) || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new CitePayClearGateError(
      "timeout_invalid",
      "CITEPAY_CLEAR_TIMEOUT_MS must be an integer between 1000 and 60000",
    );
  }
  return parsed;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}
