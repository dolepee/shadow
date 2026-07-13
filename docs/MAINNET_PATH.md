# Shadow Float Mainnet Path

Shadow Float's current product is a sponsor-backed USDC spending line for autonomous agents on Arc testnet. A sponsor can open a line without Shadow owner approval, the agent signs each bounded spend, `ShadowFloat` pays the approved provider directly, debt opens onchain, and repayment restores capacity.

The next milestone is not another contract or adapter. It is making this deployed loop self-serve and proving repeat, unassisted use before Arc mainnet.

## Current Testnet Baseline

The deployed V2 contract at `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` currently provides:

- public `openSponsoredLine(...)` creation funded by the caller's Arc USDC;
- sponsor-specific provider, endpoint, per-request, daily, and expiry policy;
- EIP-712 `FloatSpendIntent` verification for signer, provider, endpoint, amount, cumulative maximum debt, nonce, expiry, and optional executor;
- direct provider payment from contract custody;
- onchain debt, partial or full repayment, restored capacity, and default accounting;
- deterministic line refresh from contract-stored paid, blocked, denied, error, and repayment behavior;
- sponsor-only mandate updates and debt-free reserve reclaim;
- owner-withdrawal checks that preserve sponsored reserves;
- provider-signed delivery receipts for paid requests;
- a public activity API and a 26-check no-secret verifier.

V1 receipts and M1 mandate adapters remain historical and supporting evidence. They are not the primary mainnet product path.

## Current Boundaries

- Arc and all reserves are testnet-only.
- The contracts have extensive tests but no production security audit.
- External lifecycles were real and wallet-attributed, but onboarding was still assisted by Shadow.
- The web product explains and verifies the loop; it does not yet guide every sponsor and agent action end to end.
- Sponsor capital is dedicated per line; there is no pooled liquidity.
- The deployed V2 protocol fee is zero and there is no meaningful protocol revenue.
- Behavior scoring uses only contract-recorded Float activity; it does not import a portable external reputation history.
- Provider delivery receipts prove provider acknowledgement, not subjective service quality.
- Default is an explicit reserve write-off path, not a production collections or recovery system.

## Phase 1: Self-Serve Pilot

Goal: an external sponsor and agent complete the lifecycle without Shadow coordinating transactions or handling either key.

Required product path:

1. Sponsor connects a wallet, selects the agent and provider policy, approves USDC, and opens the line.
2. Agent obtains the exact EIP-712 payload and signs locally.
3. A permitted executor submits the intent through public tooling.
4. The contract pays the named provider and exposes the resulting debt.
5. Agent repays independently.
6. Sponsor can update policy or reclaim reserve after debt reaches zero.

Pilot completion requires the same external agent to complete at least three spend-and-repay cycles on separate occasions, one genuine policy block with no provider transfer, and final sponsor reserve reclaim. Time to first line, repayment rate, returning participants, and every transaction hash must be public.

No V2 redeploy is required for this phase.

## Phase 2: Integration Surface

Goal: make the dashboard one client of a stable agent-facing interface rather than the only usable path.

Minimum surface:

- typed sponsor-line transaction builders;
- typed intent generation and local signing helpers;
- signed-spend submission and status lookup;
- partial and full repayment helpers;
- sponsor policy update and debt-free close helpers;
- event and receipt subscriptions;
- a provider integration guide for payment and delivery acknowledgement;
- stable error codes for block and denial outcomes.

The public SDK must reproduce contract behavior; it must not introduce a trusted Shadow approval layer.

## Phase 3: Production Hardening

Goal: make the existing primitive safe to deploy with real value.

Required work:

- independent smart-contract security review;
- explicit pause, incident-response, and key-management runbooks;
- production monitoring for reserve solvency, active debt, expired mandates, failed repayments, defaults, and RPC/indexing divergence;
- property and invariant coverage for concurrent sponsored lines and production-sized values;
- deployment reproducibility and source verification;
- migration policy for contract upgrades or replacement deployments;
- data-retention and provider-delivery dispute boundaries;
- legal review of spending-line, debt, sponsor, and default terminology.

Testnet success is not a substitute for this gate.

## Phase 4: Capital And Risk Model

Goal: decide whether repeat demand justifies moving beyond one sponsor per line.

Questions that require evidence before implementation:

- Who supplies capital: agent operators, providers, protocols, or independent liquidity providers?
- Why does a sponsor fund the line, and how is that sponsor compensated?
- Which behavior is predictive enough to change limits or pricing?
- What evidence is portable across agent platforms without becoming operator-attested scoring?
- How are defaults aged, challenged, recovered, and disclosed?
- Should capital remain dedicated per line or become pooled?
- Which fee pays for monitoring, losses, and protocol operations?

Do not deploy pooled capital, sponsor yield, risk-priced rates, or transferable debt until repeat usage and loss assumptions can be measured.

## Phase 5: Arc Mainnet Launch

Mainnet launch requires:

- Arc mainnet and native USDC support suitable for the product;
- completed production-hardening gate;
- at least one repeat external pilot with no Shadow-operated transaction steps;
- a documented capital source and loss-bearing model;
- audited deployment and verified source;
- provider integrations that deliver a real service for the paid request;
- live reserve, debt, repayment, block, default, and fee monitoring;
- honest mainnet terms that avoid guaranteed, risk-free, or collateral-free claims.

The initial mainnet launch should retain dedicated sponsor reserves unless evidence supports a pooled model.

## What Does Not Change

- Sponsors control their line-specific provider policy.
- Agents keep their signing keys.
- Signed intents remain nonce-bound, expiry-bound, and contract-specific.
- Blocked actions move no provider funds.
- Debt and available capacity remain independently readable.
- Repayment, default, and reserve reclaim remain receipted outcomes.
- Historical V1 and M1 activity stays labeled separately from the current V2 product.

## Readiness Checklist

- [x] Permissionless sponsor-funded line creation on Arc testnet
- [x] Contract-verified signed provider spend
- [x] Debt, repayment, restored capacity, block, and default accounting
- [x] External sponsor and agent proof lifecycles
- [x] Public API and no-secret verifier
- [ ] Guided self-serve sponsor flow
- [ ] Public agent signing, submission, and repayment flow
- [ ] Three repeat unassisted cycles from one external agent
- [ ] One unassisted policy block and sponsor reserve reclaim
- [ ] Independent security review
- [ ] Production monitoring and incident runbook
- [ ] Evidence-backed capital and fee model
- [ ] Audited Arc mainnet deployment

## One-Line Direction

Shadow Float is moving from a proven sponsor-backed spending primitive to a self-serve capital layer where autonomous agents can pay approved providers before each wallet is funded, then earn reusable capacity through repayment.
