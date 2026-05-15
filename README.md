# Shadow

Shadow is the consumer surface for Arc trading agents.

Users follow registered source agents, escrow USDC, and mirror standardized intents only when their policy allows. One source intent can produce two onchain outcomes: copied for one follower, blocked for another.

Live app: https://shadow-two-opal.vercel.app

GitHub: https://github.com/dolepee/shadow

## Locked MVP

The first build uses a controlled Arc testnet AMM. It does not claim production market execution.

- Source agents publish intents.
- Followers set USDC limits and allowed assets.
- `MirrorRouter` evaluates every follower policy.
- Allowed followers execute a real swap through `ShadowAMM`.
- Blocked followers receive an onchain receipt with the reason.
- Copied intents accrue a 10 bps mirror fee. The source agent receives 70% of that fee as USDC kickback.

## Core Flow

1. Register `CatArb` and `LobsterRisk`.
2. Seed a USDC and ARCETH pool in `ShadowAMM`.
3. Follower A follows `CatArb` with a permissive policy.
4. Follower B follows `CatArb` with a stricter policy.
5. `CatArb` publishes one executable intent for ARCETH.
6. Follower A copies and swaps USDC into ARCETH.
7. Follower B is blocked by policy.
8. The dashboard shows both receipts with transaction links.

## Scope Guard

Shadow V1 does not build a production DEX, oracle system, full PnL engine, CCTP routing, App Kit Swap integration, or a full risk policy DSL. Those are outside the two-week MVP.

V1 source registration is owner managed so the demo agent list stays curated. Each source is capped at 50 followers per intent to keep intent fanout bounded and reviewable.

## Known Limits

Documented limits a reviewer should know before reading the contracts.

- Follower slippage is independent of the source intent. Each follower stores their own `minBpsOut` (basis points scaling `intent.minAmountOut`) in `RiskPolicy.Policy`. Before swapping, `MirrorRouter` quotes the live AMM and emits `MirrorReceipt(BLOCKED, SLIPPAGE_TOO_TIGHT)` cleanly when the quote can't satisfy the scaled follower minimum. A source publishing `minAmountOut = 1` only debits followers whose own `minBpsOut` accepts that floor.
- The router approves the AMM once per copied follower and resets the allowance after the swap. This is bounded by the 50 follower cap but is intentional belt and suspenders, not a gas optimum.
- `RiskPolicy.BlockReason.NOT_FOLLOWING` is retained in the enum for readability. It is not reachable through `publishIntent` because the router only iterates registered followers. Direct unit tests on the library would surface it.
- `ShadowAMM` is a single pool constant product pool with a 30 bps fee. It is intentionally small to keep the copied versus blocked outcome legible. It is not a production DEX.

## Arc Alignment

- Arc testnet deployment.
- Official Arc testnet USDC as gas and settlement asset.
- ERC-8004 style source-agent identity and reputation references.
- Onchain receipts for copied and blocked intents.
- USDC fee accounting for source-agent kickbacks.
- Optional x402 private preview endpoint after the core path is stable.

## Commands

```bash
npm run contracts:test
npm run contracts:build
npm run app:typecheck
npm run app:build
npm run agent:typecheck
npm run agent:intent
npm run verify:slippage
```

`npm run verify:slippage` reads the live Arc testnet state, picks an `intent.minAmountOut` that lands strictly between the strict and lenient follower scaled minimums, publishes the intent from `CatArb`, and prints both `MirrorReceipt` events. Strict follower must end up `BLOCKED` with reason `slippage too tight` and the lenient follower must end up `COPIED`. Exits non-zero if the outcome drifts.

## Live Arc Deployment

Live Arc testnet addresses and the first copied plus blocked receipt are documented in `docs/ARC_LIVE.md`.
