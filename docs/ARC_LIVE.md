# Shadow Arc Testnet Deployment

Chain: Arc Testnet, chain id `5042002`

Live app: https://shadow-two-opal.vercel.app

GitHub: https://github.com/dolepee/shadow

## Contracts (V2)

- ARCETH mock asset: `0x9beB19B1F360F110f731A09BA3fccB0E0cAE2402`
- ShadowAMM: `0xeDbDaC33160DE3e017dB988E02AD623344371633`
- SourceRegistry: `0xEec07657c5628AeCe50f20AA12C15A2a4B1557e1`
- MirrorRouter: `0x4e194EFB8060C9e7919a06C7E0AE4cbf9e7D47fF`
- Arc USDC: `0x3600000000000000000000000000000000000000`

Deploy block: `42361208`

## Seeded Agents

- CatArb: `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8`
- LobsterRisk: `0xFF3BDb60E16538333C9A290BB80bE52b3b82D2f3`

Both agents store ERC-8004 style identity references to the Arc testnet identity registry:

```text
0x8004A818BFB912233c491871b3d84c89A494BD9e
```

## Followers

- Follower A: `0x495cb55E288E9105E3b3080F2A7323F870538695` — strict slippage, `minBpsOut = 10000`
- Follower B: `0x7A3FFC0294f21E040b2bEa3e5Aad33cA08B33AcD` — lenient slippage, `minBpsOut = 9000`

Both follow CatArb with `maxAmountPerIntent = 2 USDC`, `dailyCap = 10 USDC`, `allowedAsset = ARCETH`, `maxRiskLevel = 3`.

## V2 Slippage Demo

Live demo intent at `intent.minAmountOut = 0.05 ARCETH`, `intent.amountUSDC = 0.5 USDC` against a live quote of `0.04753 ARCETH`:

- Intent id: `3`
- Publish tx: `0xf8f4cf5fccb3c46999b74dd5facc935490d5581864b65cb9daa63846351b141e`

Receipts on intent 3:

- Follower A (strict, 10000 bps): `BLOCKED, SLIPPAGE_TOO_TIGHT`. Scaled minimum `0.05 ARCETH` exceeds the live quote `0.04753 ARCETH`. No swap, no fee, no debit.
- Follower B (lenient, 9000 bps): `COPIED, NONE`. Scaled minimum `0.045 ARCETH` is below the live quote, so the swap executes and returns `0.04753 ARCETH`.

Interpretation: a single source intent now produces two outcomes that depend only on each follower's published slippage tolerance. A source that publishes a tight `minAmountOut` no longer cascade-reverts the whole `publishIntent` batch.

## Earlier Receipts (V1)

Intent `1` at `intent.minAmountOut = 0.01 ARCETH` (loose source bound, both followers copied):

```text
0xd9d8eff1a7b06eae0645a1aa6da0a6e20237994b8ed71c2d1f647b6a4e26fd06
```
