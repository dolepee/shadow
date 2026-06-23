# Shadow Float Underwriting

Shadow Float currently uses **operator-reviewed behavior-backed lines** plus a deterministic v0 score formula exposed in both the contract and the public API.

That means a line is granted only after public onchain behavior is reviewed. The contract exposes `deterministicScore(...)`, `recommendedLimitUSDC(score)`, and `grantFloatFromScore(...)`; the API at `GET /api/float-tools?action=score&address=0x...` recomputes the same suggested score and line from the current Float evidence window.

The remaining trust assumption is the evidence window: in the Lepton version, an operator reviews and submits the evidence counts to `grantFloatFromScore`. A reviewer can recompute those counts from receipts, KV-published loop metadata, and signed-intent verifier links, then compare the contract's score/limit with the API result. This is a deterministic v0 formula over operator-reviewed evidence, not permissionless autonomous underwriting.

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
| line label | configured lab / invited / self-test / demo address sets | operator-reviewed |
| paid-bound runs | `float:loop:runs` metadata plus matching Float receipts | KV-derived + onchain receipts |
| signed external paid runs | signed-intent metadata plus `GET /api/float-tools?action=verify&hash=...` | externally signed + onchain verified |
| repayments | Float receipts and line state | onchain-derived |
| blocked overreach | Float receipts with `SPEND_BLOCKED` / `AMOUNT_TOO_HIGH` | onchain-derived |
| denied attempts | Float receipts with `CREDIT_DENIED` | onchain-derived |
| current line | `ShadowFloat.lines(address)` | onchain-derived |

The score endpoint returns `evidenceSources`, `currentLine`, `computed`, `supportCheck`, and `trustAssumption` so the limitation is visible in the same API response as the score.

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

> Shadow Float gives operator-reviewed, behavior-backed USDC spending lines to autonomous agents on Arc.

## Claims We Do Not Make Yet

- The evidence window is operator-reviewed; current Lepton lines are not permissionlessly auto-updated.
- The contract does not independently judge subjective service quality.
- Invited builder signatures are external usage tests, not partnerships.

## Verifiable Surfaces

- `GET /api/float` shows treasury, receipts, standing board, and source breakdown.
- `GET /api/float-tools?action=agent&address=0x...` reads a single line.
- `GET /api/float-tools?action=score&address=0x...` recomputes the deterministic v0 score.
- `GET /api/float-tools?action=verify&hash=0x...` verifies an external signed Float intent.
- `ShadowFloat.lines(address)` is the canonical onchain line state.
- `ShadowFloat.deterministicScore(...)` and `ShadowFloat.recommendedLimitUSDC(...)` expose the v0 formula onchain.
- `ShadowFloat.grantFloatFromScore(...)` grants a line from the deterministic formula once the evidence counts are submitted.

## Next Step

The mainnet-ready version should move the evidence window from operator-reviewed counts to a policy-controlled indexer or verifier module that submits the score input window automatically.
