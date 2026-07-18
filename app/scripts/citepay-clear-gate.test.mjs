import assert from "node:assert/strict";
import test from "node:test";
import {
  CitePayClearGateError,
  citePayClearCommitment,
  runCitePayClearGate,
} from "./citepay-clear-gate.mjs";

const requestHash = `0x${"ab".repeat(32)}`;
const contentHash = `sha256:${"11".repeat(32)}`;
const clearanceId = "clr_shadow_test";
const enabledEnv = {
  CITEPAY_CLEAR_ENABLED: "1",
  CITEPAY_API_KEY: "cpk_shadow_test_key",
  CITEPAY_CLEAR_MANDATE_ID: "mnd_shadow_test",
  CITEPAY_CLEAR_PROVIDER: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
  CITEPAY_CLEAR_ENDPOINT_HASH: `0x${"cd".repeat(32)}`,
};
const payload = {
  citepayClear: {
    claim: "USDC settles instantly on Base.",
    quote: "USDC is a fully reserved, dollar-backed stablecoin that settles instantly on Base.",
    source: {
      text: "USDC is a fully reserved, dollar-backed stablecoin that settles instantly on Base.",
      label: "Shadow vector V1",
      licenseClass: "standard",
      priceMicro: 1_000,
    },
  },
};
const binding = {
  signedReason: `citepay-clear:${citePayClearCommitment(payload.citepayClear)}`,
  provider: enabledEnv.CITEPAY_CLEAR_PROVIDER,
  endpointHash: enabledEnv.CITEPAY_CLEAR_ENDPOINT_HASH,
  amountUSDC: 1_000n,
};

test("disabled gate does not call CitePay", async () => {
  let called = false;
  const result = await runCitePayClearGate({
    env: {},
    payload: {},
    requestHash,
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected");
    },
  });
  assert.deepEqual(result, { enabled: false, status: "disabled" });
  assert.equal(called, false);
});

test("V1 clears only after an exact POST receipt and public GET persistence check", async () => {
  const calls = [];
  const result = await runCitePayClearGate({
    env: enabledEnv,
    payload,
    requestHash,
    ...binding,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/api/clear/check")) return clearResponse();
      if (url.endsWith(`/api/clear/${clearanceId}`)) return persistedResponse();
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(result.status, "cleared");
  assert.equal(result.externalRef, requestHash);
  assert.equal(result.clearanceHash, contentHash);
  assert.equal(result.persisted.verified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://citepay-markets.vercel.app/api/clear/check");
  assert.equal(calls[0].init.headers.Authorization, "Bearer cpk_shadow_test_key");
  assert.deepEqual(calls[0].body.policy, { mandateConfigId: "mnd_shadow_test" });
  assert.equal(calls[0].body.externalRef, requestHash);
  assert.equal(calls[0].body.visibility, "private_hash_only");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.headers.Authorization, undefined);
});

test("V2 retry reuses the original clearance for the same externalRef", async () => {
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/clear/check")) {
      posts += 1;
      return clearResponse();
    }
    return persistedResponse();
  };
  const first = await runCitePayClearGate({ env: enabledEnv, payload, requestHash, ...binding, fetchImpl });
  const second = await runCitePayClearGate({ env: enabledEnv, payload, requestHash, ...binding, fetchImpl });
  assert.equal(posts, 2);
  assert.equal(first.clearanceId, clearanceId);
  assert.equal(second.clearanceId, clearanceId);
  assert.equal(first.contentHash, second.contentHash);
});

test("fails closed when CLEARED is not exact-quote verified", async () => {
  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      fetchImpl: async () => clearResponse({ checks: { quoteVerified: false, supportScore: 100, priceMicro: 1_000 } }),
    }),
    "quote_unverified",
  );
});

test("fails closed when CitePay drops the Float request binding", async () => {
  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      fetchImpl: async () => clearResponse({ externalRef: undefined }),
    }),
    "clearance_unbound",
  );
});

test("V3/V4 and every documented refusal decision fail closed", async () => {
  for (const decision of ["UNSUPPORTED", "BLOCKED_LICENSE", "BLOCKED_POLICY", "OVER_CAP", "PENDING"]) {
    await rejectsWithCode(
      runCitePayClearGate({
        env: enabledEnv,
        payload,
        requestHash,
        ...binding,
        fetchImpl: async () => response(200, {
          decision,
          clearanceId: `clr_${decision.toLowerCase()}`,
          receiptUrl: "https://citepay.test/clearance/test",
          externalRef: requestHash,
        }),
      }),
      "not_cleared",
    );
  }
});

test("fails before a network call when configuration or signed input is incomplete", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(500, {});
  };

  await rejectsWithCode(
    runCitePayClearGate({
      env: { ...enabledEnv, CITEPAY_API_KEY: "" },
      payload,
      requestHash,
      ...binding,
      fetchImpl,
    }),
    "api_key_missing",
  );
  await rejectsWithCode(
    runCitePayClearGate({ env: enabledEnv, payload: {}, requestHash, ...binding, fetchImpl }),
    "input_missing",
  );
  assert.equal(calls, 0);
});

test("fails closed on HTTP, network, and malformed response errors without exposing the key", async () => {
  await assert.rejects(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      fetchImpl: async () => response(429, { error: "rate limited" }),
    }),
    (error) => error.code === "api_rejected" && !error.message.includes(enabledEnv.CITEPAY_API_KEY),
  );
  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not-json" }),
    }),
    "response_invalid",
  );
  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      fetchImpl: async () => { throw new Error("offline"); },
    }),
    "request_failed",
  );
  await assert.rejects(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      fetchImpl: async () => { throw new Error(`failed with ${enabledEnv.CITEPAY_API_KEY}`); },
    }),
    (error) => error.code === "request_failed" && !error.message.includes(enabledEnv.CITEPAY_API_KEY),
  );
});

test("rejects evidence, provider, and endpoint substitution before calling CitePay", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(500, {});
  };

  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload: { citepayClear: { ...payload.citepayClear, quote: "substituted quote" } },
      requestHash,
      ...binding,
      fetchImpl,
    }),
    "input_unbound",
  );
  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      provider: "0x0000000000000000000000000000000000000001",
      fetchImpl,
    }),
    "provider_mismatch",
  );
  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      endpointHash: `0x${"ef".repeat(32)}`,
      fetchImpl,
    }),
    "endpoint_mismatch",
  );
  assert.equal(calls, 0);
});

test("rejects amount substitution before the public clearance lookup", async () => {
  let calls = 0;
  await rejectsWithCode(
    runCitePayClearGate({
      env: enabledEnv,
      payload,
      requestHash,
      ...binding,
      amountUSDC: 2_000n,
      fetchImpl: async () => {
        calls += 1;
        return clearResponse();
      },
    }),
    "amount_mismatch",
  );
  assert.equal(calls, 1);
});

test("fails closed when public persistence is unavailable or disagrees with POST", async () => {
  for (const persisted of [
    response(503, { error: "offline" }),
    persistedResponse({ externalRef: `0x${"ef".repeat(32)}` }),
    persistedResponse({ settlement: { txHash: `0x${"99".repeat(32)}` } }),
    persistedResponse({ clearance: { quoteVerified: false } }),
  ]) {
    let calls = 0;
    await assert.rejects(
      runCitePayClearGate({
        env: enabledEnv,
        payload,
        requestHash,
        ...binding,
        fetchImpl: async () => {
          calls += 1;
          return calls === 1 ? clearResponse() : persisted;
        },
      }),
      (error) => error.code === "clearance_lookup_failed" || error.code === "clearance_persistence_mismatch",
    );
    assert.equal(calls, 2);
  }
});

function clearResponse(overrides = {}) {
  return response(200, {
    decision: "CLEARED",
    clearanceId,
    receiptUrl: `https://citepay-markets.vercel.app/clearance/${clearanceId}`,
    contentHash,
    externalRef: requestHash,
    checks: { quoteVerified: true, supportScore: 100, priceMicro: 1_000 },
    ...overrides,
  });
}

function persistedResponse(overrides = {}) {
  const nestedOverrides = overrides.clearance ?? {};
  const { clearance: _clearance, ...topLevelOverrides } = overrides;
  return response(200, {
    decision: "CLEARED",
    contentHash,
    externalRef: requestHash,
    settlement: null,
    clearance: {
      clearanceId,
      externalRef: requestHash,
      decision: "CLEARED",
      quoteVerified: true,
      amountDueMicro: 1_000,
      ...nestedOverrides,
    },
    ...topLevelOverrides,
  });
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof CitePayClearGateError && error.code === code,
  );
}
