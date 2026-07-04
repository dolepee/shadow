# Shadow Mainnet Path

Shadow's hackathon build proves the primitive on Arc Testnet: one source intent can produce different outcomes per follower, with copied and blocked receipts emitted onchain in the same transaction. The mainnet path turns that primitive into the policy and reputation layer for autonomous trading agents on Arc.

## Mainnet Thesis

If USDC becomes the rail for autonomous agents, then agents need more than wallets. They need:

- policy-controlled delegation before capital moves
- refusal receipts when policy blocks spend
- earned reputation from copy, block, close, and PnL events
- onboarding that does not require a native gas-token detour

Shadow is designed to be that layer on Arc. Source agents publish standardized intents. Followers set risk policies. The router executes only what passes policy and emits a receipt for every outcome.

## What Is Live On Arc Testnet

- `MirrorRouter` enforces per-follower policy and emits `MirrorReceipt(COPIED | BLOCKED, reason, ...)`.
- `ShadowAMM` executes controlled USDC to ARCETH swaps for the demo execution path.
- `closePosition` reverse-swaps copied positions and emits `PositionClosed` with realized PnL in basis points.
- Circle Modular Wallets plus Gas Station sponsor passkey follower onboarding.
- Three cron source agents publish intents every 10 minutes.
- `agent/src/headless-follower.ts` proves a pure agent can follow, watch receipts, and close positions without using the browser.
- `POST /api/agent/follow-plan` exposes a lightweight agent-facing onboarding helper.
- Watch Signal computes Healthy / Watch / Stop from receipts and realized PnL.
- 30 distinct follower wallets are registered on the router, with highlighted external passkey receipts in the README.

## What Is Controlled Or Testnet-Scoped

- Source registration is owner-managed in V4.
- `ShadowAMM` is a controlled testnet AMM, not a production DEX.
- ARCETH is a mock/test asset for the demo pair.
- Source agents are currently run by the Shadow team through cron.
- Pilot veto is a derived UI label joined to an onchain receipt and reasoning packet. The raw onchain receipt remains the source of truth.
- ERC-8004 is referenced as source identity metadata. Shadow does not claim a full ERC-8004 registry write in V4.

These constraints are deliberate. They keep the hackathon proof deterministic while isolating the mainnet work that must be hardened.

## Mainnet Milestones

### 1. Permissionless Source Registration

Goal: any Arc team can register a source agent without Shadow manually adding it.

Planned shape:

- source agent stakes USDC to register
- strategy URI and metadata hash are stored with the source
- optional ERC-8004 identity reference is attached
- registration creates a Shadow profile immediately
- abuse controls start simple: minimum bond, source cap, and owner emergency pause

Why it matters: Shadow becomes a marketplace of independent agents, not one team's three personas.

### 2. Earned Reputation As The Primary Ranking

Goal: rank source agents by receipts, not marketing copy.

Inputs:

- copied receipt count
- blocked receipt count
- close count
- realized PnL average
- source fee earned
- follower retention
- policy violation rate
- Watch Signal state over time

Why it matters: a source agent earns distribution only when followers can verify its history from Arc logs.

### 3. Real Liquidity Integration

Goal: replace the controlled AMM path with production-grade Arc liquidity when mainnet venues are ready.

Candidate paths:

- native Arc AMM or DEX once available
- Uniswap V4-style pool/hook if supported
- Circle-aligned USDC routes when available
- controlled AMM retained only as a test and simulation environment

Why it matters: the hackathon AMM proves execution. Mainnet needs real liquidity, real assets, and realistic slippage.

### 4. Source-Agent Integrator Onboarding

Goal: launch with external source agents, not only Shadow-run agents.

Target:

- 3 to 5 independent source teams before mainnet launch
- each team registers one source
- each source gets a public profile
- each source publishes at least one testnet intent
- each source shares its Shadow profile publicly

Why it matters: Arc needs a visible agent economy. Shadow should become the consumer-safe surface for that economy.

### 5. Insurance Reserve And Fee Policy

Goal: make Shadow sustainable without introducing a token in v1.

Planned shape:

- mirror fee remains visible per copied receipt
- source agent keeps the majority of the fee as a routing incentive
- protocol fee starts small and funds an insurance/reserve account
- reserve can later cover UI relays, monitoring, incident response, and policy research

Why it matters: a mainnet protocol needs an economic loop, not just a demo fee.

### 6. Agent API And SDK

Goal: make Shadow usable by other agents without dashboard scraping.

Minimum SDK surface:

- `getSources()`
- `getSourceReputation(source)`
- `buildFollowPlan(source, follower, preset)`
- `publishIntent(intent)`
- `getReceipts(follower | source | intentId)`
- `watchReceipts(callback)`
- `closePosition(intentId)`

Why it matters: the dashboard is one client. The protocol surface should be the product.

## What Does Not Change

- Shadow does not guarantee profit.
- Shadow does not custody assets outside the router accounting path.
- Shadow does not hide blocked outcomes.
- Shadow does not convert Pilot labels into fake onchain enums.
- Shadow keeps refusal receipts as first-class outcomes, not errors.

## Mainnet Readiness Checklist

- [ ] permissionless bonded source registration
- [ ] at least 3 external source agents
- [ ] real Arc liquidity integration
- [ ] public SDK or typed API helper
- [ ] reserve/fee policy documented and tested
- [ ] admin controls documented
- [ ] emergency pause and source disable policy documented
- [ ] deployment runbook
- [ ] monitoring for failed publishes, failed closes, and abnormal block ratios
- [ ] mainnet demo with one copied, one blocked, one closed position, and one reputation update

## One-Line Mainnet Pitch

Shadow is the policy and reputation layer for autonomous trading agents on Arc: source agents publish intents, followers delegate USDC with risk limits, and every copy or refusal becomes an onchain receipt.
