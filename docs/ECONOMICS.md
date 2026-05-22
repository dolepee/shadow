# Shadow Economics

Shadow's economic design is intentionally simple for v1: source agents earn when followers copy, followers keep control through policy, and the protocol can later take a small fee to fund reliability and insurance. No token is required for v1.

## Current Testnet Flow

When a follower copies an intent:

1. `MirrorRouter` checks the follower policy.
2. If the policy passes, the router executes the swap through the configured execution path.
3. The router charges a mirror fee from the copied amount.
4. The source agent receives its kickback at the receipt event.
5. The follower receives a `COPIED` receipt and a tracked position.

When a follower blocks an intent:

1. `MirrorRouter` emits a `BLOCKED` receipt with the exact policy reason.
2. No swap executes for that follower.
3. No mirror fee accrues for that follower.
4. The follower balance remains untouched.

This matters because refusal is not a failed transaction. It is a product outcome with a receipt.

## Participants

| Participant | What they do | What they earn or protect |
| --- | --- | --- |
| Source agent | Publishes intents and competes for followers | Mirror fee kickback, reputation, distribution |
| Follower | Deposits USDC and sets risk policy | Policy-controlled exposure, receipt trail, optional PnL |
| Shadow protocol | Routes intents, enforces policy, indexes receipts | Future protocol fee and reserve |
| Circle/Arc ecosystem | Provides USDC, gas, finality, and account onboarding rails | More USDC-denominated agent activity |

## Fee Model

### V4 Testnet

- Mirror fee is charged only on `COPIED` receipts.
- Source-agent kickback is paid from the mirror fee.
- `BLOCKED` receipts do not charge a mirror fee.
- Protocol fee is not the main testnet story.

### Mainnet Candidate

Recommended mainnet model:

- mirror fee: visible per copied intent
- source-agent share: majority of mirror fee
- protocol share: small basis-point fee
- reserve destination: insurance, monitoring, incident response, and development

The key constraint: followers must be able to understand fees before following. If a fee cannot be explained in one sentence, it does not belong in v1.

## Insurance Reserve

Shadow should not pretend an insurance reserve exists before it is funded. The mainnet path is:

1. route a small protocol fee from `COPIED` receipts into a reserve
2. publish reserve balance and inflows
3. define eligible incidents narrowly
4. keep source-agent strategy losses out of scope

Eligible reserve uses can include:

- UI or relayer incidents
- monitoring failures
- audited protocol bugs
- emergency response costs

Out of scope:

- reimbursing normal trading losses
- covering followers who chose aggressive policies
- covering source-agent alpha failure
- discretionary bailouts

## Source-Agent Incentives

Source agents need a reason to register with Shadow instead of only posting signals elsewhere.

Shadow gives them:

- a public profile
- follower distribution
- onchain receipt history
- Watch Signal reputation
- source fee earnings
- shareable proof that followers copied or refused their intents

The long-term incentive is not just fee income. It is portable reputation on Arc.

## Follower Incentives

Followers need control more than yield promises.

Shadow gives them:

- max amount per intent
- daily cap
- asset allowlist
- risk tier
- min-out rule
- blocked receipts when policy refuses
- close receipts with realized PnL
- agent Watch Signal before trust decays silently

The follower value proposition is: delegate only inside your own rules.

## No Token In V1

Shadow does not need a token to work.

Adding a token before there is repeat usage would distract from the real primitive: policy-controlled USDC delegation and receipt-based reputation. If a token is ever considered, it should come after:

- independent source-agent demand
- real Arc mainnet liquidity
- sustained mirror fee volume
- a clear reserve/governance need

Until then, fees and reputation are enough.

## Business Model Summary

Shadow can sustain itself through a small protocol share of copied-flow mirror fees while source agents keep the majority of the economics. The protocol's job is not to sell predictions. It is to make autonomous USDC delegation safer, measurable, and repeatable on Arc.
