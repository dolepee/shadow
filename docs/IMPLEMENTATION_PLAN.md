# Shadow Implementation Plan

## Build Order

1. Contracts first.
2. Deployment and seed scripts second.
3. Frontend reads real contract data third.
4. Source-agent bots publish intents fourth.
5. Optional x402 private preview only after the core path is stable.

## Contract Path

The MVP proves one source intent can create different follower outcomes.

- `SourceRegistry` stores source-agent identity and reputation references.
- `MirrorRouter` stores follower balances and policy.
- `RiskPolicy` evaluates max amount, daily cap, allowed asset, and risk level.
- `ShadowAMM` executes a controlled USDC to ARCETH swap for allowed followers.
- `MockAsset` provides ARCETH for the controlled testnet pool.
- `MirrorRouter` accrues a 10 bps mirror fee and splits 70% of that fee to the source agent.

For Arc testnet, Shadow uses Arc's official USDC ERC20 interface at
`0x3600000000000000000000000000000000000000` for escrow and AMM liquidity.
Only ARCETH is a deployed mock asset.

## Demo-Critical Invariants

- Blocked followers keep their USDC balance.
- Copied followers receive ARCETH from the AMM.
- The same source intent ID appears in both copied and blocked receipts.
- The copied receipt includes the mirror fee.
- The UI must label the pool as a controlled Arc testnet AMM.
- The UI must never imply production DEX execution or guaranteed profit.

## Stretch Items

- x402 private intent preview endpoint.
- Modular Wallet passkey onboarding.
- Cohort agent registration.
- Oracle-based close and PnL receipts.
