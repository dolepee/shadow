# Shadow Arc Testnet Deployment

Chain: Arc Testnet, chain id `5042002`

Live app: https://shadow-two-opal.vercel.app

GitHub: https://github.com/dolepee/shadow

## Contracts (V4)

- ARCETH mock asset: `0x9beB19B1F360F110f731A09BA3fccB0E0cAE2402`
- ShadowAMM (V4): `0x917700Df306bDd84418369e24E7dfe2E0fd8D697`
- SourceRegistry: `0xEec07657c5628AeCe50f20AA12C15A2a4B1557e1`
- MirrorRouter (V4): `0xcB300Ac9f5944Fd06F39329cf5d871C9B92C6655`
- Arc USDC: `0x3600000000000000000000000000000000000000`

V4 deploy block: `42556765`

V4 turns each copied intent into a tracked position: the router keeps the ARCETH it bought, records `Position{sourceAgent, assetAmount, usdcIn, closed}` per `(intentId, follower)`, and emits `PositionOpened`. Followers call `closePosition(intentId)` to reverse-swap the asset back to USDC; the router credits the follower's idle USDC balance and emits `PositionClosed(intentId, follower, sourceAgent, usdcIn, usdcOut, pnlBps)` so the UI can show realized PnL. ShadowAMM v2 ships `swapExactAssetForUSDC` to close the loop. Prior generations remain readable as historical state: V3 router `0x987d7886c9dA7Ffbb7CC66b7914518D8966975eb` (deploy block `42508627`), V2 router `0x4e194EFB8060C9e7919a06C7E0AE4cbf9e7D47fF` (deploy block `42361208`).

## Seeded Agents

- CatArb: `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8`
- LobsterRisk: `0xFF3BDb60E16538333C9A290BB80bE52b3b82D2f3`
- MomentumOtter: `0xe2f079d0aBe68a9CA0A9875e254fD976EaC0696B`

Seeded source agents store ERC-8004 style identity references to the Arc testnet identity registry:

```text
0x8004A818BFB912233c491871b3d84c89A494BD9e
```

## Followers

- Follower A: `0x495cb55E288E9105E3b3080F2A7323F870538695` — strict slippage, `minBpsOut = 10000`
- Follower B: `0x7A3FFC0294f21E040b2bEa3e5Aad33cA08B33AcD` — lenient slippage, `minBpsOut = 9000`

Both follow CatArb with `maxAmountPerIntent = 2 USDC`, `dailyCap = 10 USDC`, `allowedAsset = ARCETH`, `maxRiskLevel = 3`.

## V3 Slippage Demo

Live demo intent at `intent.minAmountOut = 0.034 ARCETH`, `intent.amountUSDC = 0.5 USDC` against a live quote of `0.031702 ARCETH`:

- Intent id: `3`
- Publish tx: `0x21de4f1a8adeb2e18dd922768e0ccaca39fa4079b0592b16ea3a8472ed9de239`
- Block: `42511253`

Receipts on intent 3:

- Follower A (strict, 10000 bps): `BLOCKED, SLIPPAGE_TOO_TIGHT`. Scaled minimum `0.034 ARCETH` exceeds the live quote `0.031702 ARCETH`. No swap, no fee, no debit.
- Follower B (lenient, 9000 bps): `COPIED, NONE`. Scaled minimum `0.0306 ARCETH` is below the live quote, so the swap executes and returns `0.031702 ARCETH`.

Interpretation: a single source intent produces two outcomes that depend only on each follower's published slippage tolerance. A source that publishes a tight `minAmountOut` no longer cascade-reverts the whole `publishIntent` batch.

## Earlier Receipts (V1)

Intent `1` at `intent.minAmountOut = 0.01 ARCETH` (loose source bound, both followers copied):

```text
0xd9d8eff1a7b06eae0645a1aa6da0a6e20237994b8ed71c2d1f647b6a4e26fd06
```
