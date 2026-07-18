import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CitePay clearance and checkpoint stay before every Float write", async () => {
  const binder = await readFile(new URL("./float-v2-bind-intent.mjs", import.meta.url), "utf8");
  const gate = binder.indexOf("const citepayClearance = await runCitePayClearGate");
  const checkpoint = binder.indexOf("const citepayCheckpoint = await persistCitePayClearanceCheckpoint");
  const mandateWrite = binder.indexOf("const providerMandateTx = await maybeRefreshSponsoredProviderMandate");
  const spendWrite = binder.indexOf("const txHash = await wallet.writeContract");

  assert.ok(gate >= 0, "CitePay gate call is missing");
  assert.ok(checkpoint > gate, "checkpoint must follow the verified clearance");
  assert.ok(mandateWrite > checkpoint, "provider-mandate writes must follow the checkpoint");
  assert.ok(spendWrite > mandateWrite, "Float spend must follow gate, checkpoint, and preview setup");
});

test("production activation stays disabled and no settlement route is callable", async () => {
  const [envExample, gate, checkpoint, binder] = await Promise.all([
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
    readFile(new URL("./citepay-clear-gate.mjs", import.meta.url), "utf8"),
    readFile(new URL("./citepay-clear-checkpoint.mjs", import.meta.url), "utf8"),
    readFile(new URL("./float-v2-bind-intent.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(envExample, /^CITEPAY_CLEAR_ENABLED=0$/m);
  for (const source of [gate, checkpoint, binder]) {
    assert.equal(source.includes("settle_clearance"), false);
    assert.equal(source.includes("/api/clear/settle"), false);
  }
});
