# Shadow Float Pilot Operations

This runbook covers the Arc testnet self-serve pilot. It is an operational guide, not an authorization service. The deployed `ShadowFloat` V2 contract remains the source of truth for sponsor ownership, reserve custody, provider policy, debt, expiry, nonce use, repayment, and reserve reclaim.

## Operating rule

Reconcile before retrying. A wallet timeout, RPC timeout, or missing UI confirmation does not prove that a transaction failed. Record the transaction hash when available, check its receipt and relevant contract state, and only then decide whether another transaction is necessary.

Never ask a participant for a private key. Sponsors and agents sign with their own wallets. Shadow does not repay an external agent's debt or reclaim an external sponsor's reserve on their behalf.

## Public monitor

The Builders page derives a pilot posture from `GET /api/float?mode=v2`:

- treasury custody compared with the current custodial reserve floor: nominal sponsored reserve minus sponsored debt already deployed to providers;
- open-debt line count;
- expired lines with open debt;
- expired debt-free reserves available for sponsor reclaim;
- defaulted line count;
- live-RPC versus verified-checkpoint data source.

Ordinary open debt is visible exposure, not automatically an incident. It reduces both contract custody and the reserve still returnable to the sponsor, so the monitor shows nominal reserve, deployed sponsored debt, and the resulting custodial floor separately. An expired line with debt is a warning because the sponsor cannot reclaim or renew it. A default or reserve invariant breach is critical.

The verified checkpoint is a degraded evidence fallback. It must never be treated as fresh authorization for a write. Every Builders-page write re-reads current contract state before opening a wallet prompt.

## Response matrix

| Signal | Immediate response | Write policy |
| --- | --- | --- |
| `DATA_DEGRADED` | Check Arc RPC and `/api/float?mode=v2`; compare a second RPC if available. | Do not tell participants to rely on checkpoint values. Browser actions may proceed only after their own live preflight succeeds. |
| `RESERVE_INVARIANT_BREACH` | Stop pilot onboarding, preserve logs, verify token balance and `totalSponsoredReserveUSDC` at one block. | No new lines, mandate changes, spends, defaults, or reclaims until reconciled. |
| `DEFAULTED_LINE` | Confirm the default transaction, remaining sponsor reserve, and recipient transfer. Notify the affected sponsor and agent with transaction evidence. | Do not reopen or restage the line as successful usage. |
| `EXPIRED_DEBT_OPEN` | Notify the agent that repayment is required before reclaim or renewal. Keep the debt visible. | Do not repay for the agent and do not ask the sponsor to retry close. |
| `OPEN_DEBT` | Track amount, age, agent, and sponsor. Confirm that available capacity reflects the debt. | No intervention unless the agreed pilot window or policy is breached. |
| `RESERVE_RECLAIMABLE` | Tell the sponsor it may close the line and select its reserve recipient. | Only the sponsor signs `closeSponsoredLine`; re-read zero debt immediately before submission. |

## Ambiguous transaction recovery

1. Capture the wallet's transaction hash. If no hash exists, inspect wallet activity before opening another prompt.
2. Read the transaction receipt from Arc testnet.
3. Read the contract state at or after the receipt block:
   - sponsor action: `lineSponsors`, `lines`, `lineExpiries`, and the provider mandate;
   - spend: `intentNonceUsed`, the request receipt, provider balance evidence, and line debt;
   - repayment: line debt and repayment receipt;
   - reclaim: cleared sponsor record, zero line capacity, and recipient transfer.
4. If the transaction succeeded, update the public view and do not resubmit.
5. If it reverted, surface the contract reason and rebuild from fresh state.
6. If the receipt remains unavailable, stop. Do not convert uncertainty into a second value-moving request.

Signed spends have contract-enforced nonce and request bindings. Browser sponsor and repayment actions also require explicit wallet confirmation. Those controls reduce duplicate execution risk but do not replace receipt reconciliation after an RPC failure.

## Pilot evidence

For each external cycle, retain only public-safe evidence:

- sponsor, agent, provider, and executor addresses;
- policy bounds and expiries;
- intent digest and nonce;
- transaction hashes and block numbers;
- provider-paid, debt-opened, blocked, repaid, defaulted, or reclaimed outcome;
- elapsed time from sponsor preflight to line opening;
- whether Shadow operated any participant transaction.

Do not label a Shadow-controlled sponsor as external sponsor traction. Do not label an invited integration test as organic demand. One open-debt exhibit may remain visible, but it must not be counted as a closed lifecycle.

## Incident closeout

An incident is closed only when contract state, token transfers, API state, and public wording agree. Document the root cause, affected request hashes, remediation, and whether a contract redeployment is required. A UI or indexer correction does not silently rewrite onchain history.
