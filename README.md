# Shadow

Shadow lets anyone follow AI trading agents on Arc with USDC mirroring under a policy each follower writes for themselves. Because the policy includes slippage that each follower owns, one source intent can produce two outcomes: copied for one wallet, blocked for another, both onchain.

Live app: https://shadow-two-opal.vercel.app

GitHub: https://github.com/dolepee/shadow

Chain: Arc Testnet (chain id `5042002`)

## Try it in 60 seconds

1. Open the live app, connect a wallet, switch to Arc Testnet.
2. Grab a small amount of test USDC at https://faucet.circle.com.
3. Pick a source agent (CatArb, LobsterRisk, or MomentumOtter), pick a risk preset (Conservative, Balanced, or Aggressive), set a deposit, follow.
4. Cron publishes new intents every 10 minutes. The live receipts feed updates without a page refresh.
5. Hit `run verify now` on the spotlight section to publish a fresh demo intent and watch the strict and lenient outcomes prove themselves against the live AMM quote in one click.

## The novel primitive: slippage each follower owns

Source agents publish intents with a `minAmountOut` hint. Each follower stores their own `minBpsOut` on chain. Before swapping, `MirrorRouter` quotes the AMM and:

1. emits `MirrorReceipt(BLOCKED, SLIPPAGE_TOO_TIGHT)` for any follower whose scaled minimum exceeds the live quote, with no fee, no debit;
2. executes the swap for every other follower without reverting the batch.

A source publishing a tight `minAmountOut` no longer cascade reverts. Each follower keeps independent control of how much price impact they tolerate.

## The product surface

**Public follow flow.** Pick a source, pick a preset, deposit USDC. A single CTA wires up `approve`, `depositUSDC`, and `followSource` with the preset policy (max per intent, daily cap, max risk, `minBpsOut`).

**Live receipts feed.** Auto polls every 15 seconds, animates new rows, shows the latest block, source name, follower address, USDC mirrored, and ARCETH received per receipt.

**Spotlight intent.** A hardcoded demo that ships strict and lenient outcomes for intent `#3` with a live `run verify now` button backed by a Vercel serverless function.

**Scheduled activity.** GitHub Actions publishes new intents every 10 minutes from three source agents: CatArb (tight slippage split outcome at risk level 2), LobsterRisk (safe copy at risk level 1), and MomentumOtter (aggressive copy at risk level 3). The feed always has fresh data and three distinct personalities.

## Architecture

* `SourceRegistry`. Curated source agent list with ERC-8004 identity references.
* `MirrorRouter`. Accepts source intents, evaluates each follower policy, debits USDC, executes the AMM swap, emits onchain receipts, and accrues source kickback USDC.
* `ShadowAMM`. Constant product AMM over a single USDC/ARCETH pool with a 30 bps fee. Intentionally small to keep outcomes legible.
* `RiskPolicy`. Per follower struct with `maxAmountPerIntent`, `dailyCap`, `allowedAsset`, `maxRiskLevel`, `minBpsOut`, plus an active flag and daily spent counters.

## Live Arc deployment (V3)

Contracts:

* ARCETH: `0x9beB19B1F360F110f731A09BA3fccB0E0cAE2402`
* ShadowAMM: `0xeDbDaC33160DE3e017dB988E02AD623344371633`
* SourceRegistry: `0xEec07657c5628AeCe50f20AA12C15A2a4B1557e1`
* MirrorRouter: `0x987d7886c9dA7Ffbb7CC66b7914518D8966975eb`
* Arc USDC: `0x3600000000000000000000000000000000000000`

V3 adds follower-side custody escapes: `withdrawUSDC(amount)` returns idle balance to the wallet, and `unfollowSource(source)` flips a policy to inactive so the router skips that follower on subsequent intents. `isFollowing` is still set on the first follow and remains the historical signal; `policy.active` is the source of truth for current state.

Source agents:

* CatArb: `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8`
* LobsterRisk: `0xFF3BDb60E16538333C9A290BB80bE52b3b82D2f3`
* MomentumOtter: `0xe2f079d0aBe68a9CA0A9875e254fD976EaC0696B`

Seeded followers used in the spotlight:

* Follower A (strict, `minBpsOut = 10000`): `0x495cb55E288E9105E3b3080F2A7323F870538695`
* Follower B (lenient, `minBpsOut = 9000`): `0x7A3FFC0294f21E040b2bEa3e5Aad33cA08B33AcD`

Both follow CatArb with `maxAmountPerIntent = 2 USDC`, `dailyCap = 10 USDC`, `allowedAsset = ARCETH`, `maxRiskLevel = 3`.

Full deployment doc: `docs/ARC_LIVE.md`.

## Commands

```bash
npm run contracts:test     # Forge unit tests
npm run contracts:build    # Compile contracts
npm run app:typecheck      # Vite app typecheck
npm run app:build          # Vite production build
npm run agent:typecheck    # tsx agent scripts typecheck
npm run agent:intent       # Publish a manual intent
npm run verify:slippage    # Reproducible split outcome run
```

`npm run verify:slippage` reads live state, picks an `intent.minAmountOut` strictly between the strict and lenient follower scaled minimums, publishes from CatArb, and prints both `MirrorReceipt` events. The strict follower must end up `BLOCKED, SLIPPAGE_TOO_TIGHT`. The lenient follower must end up `COPIED`. Exits with a nonzero code if the outcomes drift.

## Scope guard

Shadow V1 does not build a production DEX, oracle system, full PnL engine, CCTP routing, App Kit Swap integration, or a risk policy DSL. Source registration is managed by the contract owner so the demo agent list stays curated. Each source is capped at 50 followers per intent.

## Known limits

`MirrorRouter` approves the AMM once per copied follower and resets the allowance after the swap. Intentional belt and suspenders within the 50 follower cap.

`RiskPolicy.BlockReason.NOT_FOLLOWING` is retained in the enum for readability. It is unreachable through `publishIntent` since the router only iterates registered followers.

`ShadowAMM` is a single pool constant product AMM with a 30 bps fee. It is not a production DEX.

## Arc alignment

* Arc Testnet deployment.
* Arc USDC as both gas token and settlement asset.
* ERC-8004 source agent identity and reputation references.
* Onchain receipts for both copied and blocked outcomes.
* USDC fee accounting for source kickbacks.
