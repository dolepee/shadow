# Shadow Float Underwriting

Shadow Float currently uses **receipt-derived behavior evidence** plus a deterministic v0 score formula exposed in both the contract and the public API.

That means the score endpoint derives behavior counts from `FloatReceipt` logs wherever the behavior is onchain-visible. The contract exposes `deterministicScore(...)`, `recommendedLimitUSDC(score)`, and `grantFloatFromScore(...)`; the API at `GET /api/float-tools?action=score&address=0x...` recomputes the same suggested score and line from the current Float evidence window.

The remaining trust assumption is execution: in the Lepton version, an owner/operator still submits the evidence counts to `grantFloatFromScore` and performs line changes. A reviewer can recompute the receipt-derived counts from chain logs, compare the API result to the current line, and verify signed external spends through the signed-intent verifier links. `npm run float:autounderwrite` turns those public counts into proposed line raises/cuts, and can apply them only when explicitly run by the contract owner. This is deterministic v0 underwriting over public receipts, not permissionless lending yet.

## Current Inputs

For Lepton, v0 scoring inputs are:

- line label: lab, invited, self-test, or demo;
- paid-bound Float runs;
- signed external x402 Float runs;
- repayments;
- blocked overreach;
- denied attempts;
- execution errors.

The contract records the resulting `score`, `creditLimitUSDC`, `availableCreditUSDC`, `activeDebtUSDC`, and `status` in `lines(address)`.

## Evidence Sources

| Input | Source | Trust label |
| --- | --- | --- |
| line label | configured lab / invited / self-test / demo address sets | operator-configured |
| paid-bound runs | Float receipts with `SPEND_ALLOWED`, `PROVIDER_PAID`, `DEBT_OPENED`, and matching `X402PaymentBound` | receipt-derived |
| signed external paid runs | signed-intent metadata plus matching receipt-derived paid-bound evidence | externally signed + onchain verified |
| repayments | Float receipts and line state | onchain-derived |
| blocked overreach | Float receipts with `SPEND_BLOCKED` / `AMOUNT_TOO_HIGH` | onchain-derived |
| denied attempts | Float receipts with `CREDIT_DENIED` | onchain-derived |
| current line | `ShadowFloat.lines(address)` | onchain-derived |

The score endpoint returns `evidenceMode`, `evidenceCompleteness`, `evidenceSources`, `currentLine`, `computed`, `supportCheck`, and `trustAssumption` so the limitation is visible in the same API response as the score.

## Deterministic v0 Formula

```text
base:
  lab       8500
  invited   7500
  self-test 6500
  demo      5000

adjustments:
  +150 per PAID_BOUND run, max 5
  +350 per signed external PAID_BOUND run, max 3
  +400 per REPAID run, max 3
  -250 per BLOCKED run, max 5
  -900 per DENIED run, max 3
  -300 per ERROR run, max 3

limit bands:
  score >= 9000: 1.00 USDC line
  score >= 8000: 0.05 USDC line
  score >= 7500: 0.025 USDC line
  otherwise: 0
```

The verifier returns `supportCheck.scoreSupported` and `supportCheck.limitSupported`, so a reviewer can see whether the public score supports the current onchain line.

## Current Safe Claim

> Shadow Float gives receipt-derived, behavior-backed USDC spending lines to autonomous agents on Arc, with owner/operator-controlled line execution in v0.

## Claims We Do Not Make Yet

- The evidence window is receipt-derived, but current Lepton lines are not permissionlessly auto-updated.
- The contract does not independently judge subjective service quality.
- Invited builder signatures are external usage tests, not partnerships.

## Verifiable Surfaces

- `GET /api/float` shows treasury, receipts, standing board, and source breakdown.
- `GET /api/float-tools?action=agent&address=0x...` reads a single line.
- `GET /api/float-tools?action=score&address=0x...` recomputes the deterministic v0 score.
- `GET /api/float-tools?action=verify&hash=0x...` verifies an external signed Float intent.
- `ShadowFloat.lines(address)` is the canonical onchain line state.
- `ShadowFloat.deterministicScore(...)` and `ShadowFloat.recommendedLimitUSDC(...)` expose the v0 formula onchain.
- `ShadowFloat.grantFloatFromScore(...)` grants a line from the deterministic formula once receipt-derived evidence counts are submitted.
- `npm run float:score-proof` checks score evidence across the standing board.
- `npm run float:autounderwrite` dry-runs line updates from receipt-derived evidence; `FLOAT_AUTOUNDERWRITE_APPLY=1` applies them with the owner key.

## Next Step

The mainnet-ready version should move from owner-run automation to a policy-controlled verifier module that submits the receipt-derived score input window automatically and adjusts lines without manual review.
