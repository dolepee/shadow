# Shadow Float Underwriting

This document describes the current judged underwriting path first, then labels the older v0 owner-run score path separately.

## Current V2 Sponsored Lines

Shadow Float V2 uses sponsor-backed lines. A sponsor reserves Arc USDC for a specific agent, and `ShadowFloat` caps that line by the smaller of:

- the sponsor's reserve; and
- the contract's deterministic limit recommendation for the agent's behavior score.

Safe claim:

> Shadow Float V2 provides permissionless sponsor-funded lines with contract-enforced signed spends and contract-scored refresh from recorded behavior.

Unsafe claims:

- "open-ended public credit";
- "unreserved borrowing";
- "anyone can submit evidence";
- "public lending market."

Sponsors supply the capital at risk. The contract supplies the signed-spend checks, behavior counters, deterministic scoring, and reserve-capped line refresh.

## V2 Evidence Inputs

The V2 contract stores `behaviorStats(agent)` and updates those counters only through contract-verified line activity:

- paid-bound behavior;
- signed external paid behavior;
- repayment behavior;
- blocked overrun behavior;
- denied behavior;
- execution error behavior.

The signed spend path checks signer, nonce, expiry, provider, endpoint, amount, executor, and max cumulative debt before payment. When a spend, block, or repay occurs, the contract refreshes the sponsored line from the stored behavior counters.

Public inspection:

```bash
cast call 0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
  "autonomousLineScore(address)(uint16,uint256,uint256)" \
  0x5c0b33b209f510868E07792Edc46c3792B0b92EC \
  --rpc-url https://rpc.testnet.arc.network
```

Anyone can also call:

```text
refreshSponsoredLineFromBehavior(address agent, bytes32 reasonHash)
```

Normal spend, blocked-spend, and repay paths call the same internal refresh logic automatically.

## Deterministic Formula

The V2 formula is exposed in the contract through `deterministicScore(...)` and `recommendedLimitUSDC(score)`.

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
  score >= 9000: 1.00 USDC recommended line
  score >= 8000: 0.05 USDC recommended line
  score >= 7500: 0.025 USDC recommended line
  otherwise: 0
```

For sponsored lines, the spendable cap is still limited by sponsor reserve.

## Owner Controls And Sponsored Lines

The owner-run V1/v0 line-management functions are not the current external-line refresh mechanism. For sponsored V2 lines, owner scoring functions such as `grantFloatFromScore`, `reduceLimit`, and `revoke` revert with the sponsored-line guard. The sponsor path is intentionally narrower: the sponsor funds reserve and provider mandate; the contract scores recorded behavior and caps spendable capacity by reserve.

## Historical V1/v0 Score Proof

The older score endpoint and `npm run float:score-proof` remain useful historical context. They recompute receipt-derived standing-board evidence from prior Float receipts and can explain how the score formula evolved.

Historical surfaces:

- `GET /api/float` for the old V1 receipt API;
- `GET /api/float-tools?action=score&address=0x...` for score recomputation;
- `npm run float:score-proof` for the standing-board score proof;
- `npm run float:autounderwrite` for the old owner-run proposal flow.

Do not present these as the current permissionless V2 sponsored-line mechanism. The current judge path is:

```bash
npm run float:v2-verify-live
curl -s https://shadow-arc.vercel.app/api/float?mode=v2
```

## What Is Not Claimed

- The contract does not judge subjective provider service quality by itself.
- One provider delivery receipt is recorded live for the Driplet to CitePay request. The standard verifier still focuses on payment, debt, repayment, and block behavior.
- Invited builder activity is integration testing unless the other team explicitly approves stronger wording.
