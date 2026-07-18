# CitePay Clear Gate

Shadow can optionally require a CitePay Clear receipt before binding an external builder's signed
`FloatSpendIntent`. This is a citation-specific, pre-payment policy gate. It does not change
`ShadowFloat`, move funds itself, or count as external pilot traction.

## Safety boundary

- Disabled by default with `CITEPAY_CLEAR_ENABLED=0`.
- The `cpk_` API key and `mnd_` mandate id are server/local secrets, never browser variables.
- Signature recovery and request-hash derivation happen before the Clear call.
- The Clear call happens before every on-chain write, including provider-mandate refreshes.
- Only `decision: CLEARED` can proceed.
- CitePay must report `checks.quoteVerified: true`; a support score never overrides an exact-quote failure.
- The signed `intent.reason` must commit to the canonical Clear input hash.
- Provider, endpoint hash, and micro-USDC amount must match server-owned configuration and receipt fields.
- The returned clearance must include `externalRef` equal to the exact Float `requestHash`.
- Shadow re-reads the persisted clearance from public `GET /api/clear/{clearanceId}` and requires the same
  decision, clearance id, content hash, external reference, quote result, amount, and `settlement: null`.
- Before any Float write, Shadow atomically stores a mode-600 checkpoint containing only intent bindings,
  clearance identifiers, and hashes. Claim/source text and credentials are never journaled.
- Timeouts, HTTP errors, malformed replies, missing bindings, and all refusal decisions fail closed.

The code path remains disabled by default. A live pilot is blocked until CitePay revokes the key exposed
in the prior coordination channel, delivers a fresh scoped key securely, and Shadow independently verifies
that CitePay's self-funded sponsored Float line has been renewed. The last read-only verification found the
0.05 USDC reserve intact with zero debt, but the line itself expired on 2026-07-09.

## Signed-intent input

When enabled, the JSON passed to `float:v2-bind-intent` must add:

```json
{
  "citepayClear": {
    "claim": "The exact claim the agent intends to rely on.",
    "quote": "The exact quoted span.",
    "source": {
      "text": "The source text containing the exact quoted span.",
      "label": "Source label",
      "licenseClass": "standard",
      "priceMicro": 5000
    }
  }
}
```

`source` may instead contain one numeric-string `onChainId`. The policy id is never accepted from
the signed-intent file; Shadow injects `CITEPAY_CLEAR_MANDATE_ID` so a caller cannot weaken policy.
The Float request hash is sent as `externalRef` and must be returned unchanged.

Before signing the intent, derive the signed reason from the draft JSON:

```bash
npm run float:v2-clear-commit -- signed-intent-draft.json
```

Set `intent.reason` to the returned `reason`, then sign. The binder recomputes the commitment, so a
relayer cannot replace the claim, quote, or source after the agent signs.

## Configuration

```bash
CITEPAY_CLEAR_ENABLED=1
CITEPAY_CLEAR_API_BASE=https://citepay-markets.vercel.app
CITEPAY_API_KEY=cpk_...
CITEPAY_CLEAR_MANDATE_ID=mnd_...
CITEPAY_CLEAR_PROVIDER=0x...
CITEPAY_CLEAR_ENDPOINT_HASH=0x...
CITEPAY_CLEAR_VISIBILITY=private_hash_only
CITEPAY_CLEAR_TIMEOUT_MS=15000
CITEPAY_CLEAR_CHECKPOINT_DIR=.tmp/citepay-clearances
```

Create the mandate once with CitePay's authenticated `POST /api/clear/mandate` endpoint. The
approved pilot policy is `standard`, 5,000 micro-USDC per citation, and 500,000 micro-USDC total.
The replacement key must have only `mandate:create,clear:check`; it must not have settlement authority.

The checkpoint is local operational evidence and is ignored by Git. Its state is
`cleared_not_submitted` before the first chain write and changes to `confirmed` only after the Float
receipt contains the exact provider transfer and the contract exposes a nonzero paid-spend commitment.
The provider's surrounding wallet balance is diagnostic only because unrelated transfers may occur. A
successful blocked transaction is instead
recorded as `blocked_no_payment`; it never confirms the clearance as paid. A conflicting checkpoint for
the same request hash fails closed. If the process stops after the on-chain transaction but before this
final update, a retry repairs the pending checkpoint from `receiptByRequestHash` and
`paidSpendCommitments` before reporting the already-bound result; it never resubmits the spend.

A mode-600 per-request lock serializes checkpoint creation and terminal transitions across binder
processes. A competing process fails closed with `checkpoint_locked` before any Float write. If a process
is killed while holding the lock, confirm that no binder is active and inspect the checkpoint before
manually removing the adjacent `.lock` file; the code never guesses that a lock is stale.

## Settlement boundary

This integration does not call `settle_clearance`. CitePay's settlement tool initiates its own
creator payment, while `ShadowFloat.requestSignedSpend` already pays the configured provider. Until
the parties define which payment leg CitePay settlement replaces and how duplicate payment is
prevented, invoking both would be an accounting error.

Run the local gate tests with:

```bash
npm run float:v2-clear-gate:test
```

The V1-V4 compatibility cases are based on CitePay's public `docs/AGENTS.md`: exact-quote clearance,
idempotent retry by `externalRef`, unsupported quote, and over-cap refusal. Tests use fakes only and make
no production request. The adapter was checked against CitePay's public commit
`d7b5aa11a8b628e9abc7bdc4b41d4756f555b2a2`; revalidate the response contract before enabling a canary.
