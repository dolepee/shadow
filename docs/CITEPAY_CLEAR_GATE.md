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
`paidSpendCommitments`, then locates the original `FloatIntentConsumed` transaction and requires the
same exact Float-to-provider USDC transfer before reporting the already-bound result. An x402
facilitator reimbursement does not satisfy this direct-payment proof. Recovery fails closed if the
transaction receipt cannot be located; it never resubmits the spend.

A mode-600 per-request lock serializes checkpoint creation and terminal transitions across binder
processes. A competing process fails closed with `checkpoint_locked` before any Float write. If a process
is killed while holding the lock, confirm that no binder is active and inspect the checkpoint before
manually removing the adjacent `.lock` file; the code never guesses that a lock is stale.

After creation, `cleared_not_submitted` is also exclusive: another binder for the same request fails with
`checkpoint_in_progress` instead of reusing the clearance and racing a second on-chain submission. If the
first process stops after a receipt lands, rerunning the binder follows the receipt-recovery path above. If
it stops before any receipt exists, inspect the request hash and nonce on-chain before archiving and
removing the abandoned checkpoint; pending checkpoints are never cleared automatically.

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

## Closed Arc testnet canary

The bounded external integration pilot completed on 2026-07-20:

- CitePay Clear returned `CLEARED`, verified the exact quote, echoed the Float request hash as `externalRef`, and served the same persisted clearance with `settlement: null`.
- Shadow stored a secret-free pre-submit checkpoint before the contract call.
- `ShadowFloat` consumed the external agent's EIP-712 intent once and paid exactly `0.001 USDC` directly to CitePay.
- CitePay's controlled agent repaid exactly `0.001 USDC` itself. Debt returned to zero and the full `0.05 USDC` capacity was restored.
- No `settle_clearance` call occurred. The Clear integration remains disabled by default.

| Evidence | Value |
| --- | --- |
| Agent | `0x236652EAd43fbb0948173fC4dDF23BC0971B274d` |
| External sponsor and provider | `0x5389688243328c26a92b301faEEAb5fbf9AFf105` |
| Float request hash | `0xc5ec357843228cf3cef338016f35938734c6ab6b0602035449f575bb6bee591a` |
| Clearance | `clr_fc7aa568fde6640b99f4e8ad1425d54c` |
| Spend | [`0x74c1fa...57927`](https://testnet.arcscan.app/tx/0x74c1fa0782dd8c70586bd8a87cb014a1bda6080df794250766720d527fe57927) |
| Repayment | [`0x1e0279...527f`](https://testnet.arcscan.app/tx/0x1e0279903aba3e728385825e983bc840f9db804142e6314662df33afec54527f) |
| Public proof | [`citepay-clear-canary.json`](https://shadow-arc.vercel.app/proofs/citepay-clear-canary.json) |

This is bounded external integration evidence, not production routing, organic adoption, lending revenue, or creator settlement.
