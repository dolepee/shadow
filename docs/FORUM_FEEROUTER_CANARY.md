# Forum FeeRouter Canary

This is an isolated Arc testnet integration pilot between Shadow and Forum. It does not replace Shadow's production router, reuse its registry or AMM, or claim organic revenue.

## Fixed scope

- Forum source and payout: `0x13585c6004fbA9D7D49219a6435B68348fD30770`
- FeeRouterV1: `0xeff9bc359e8f2a5eabce55af3f1bb24f98eabf59`
- Arc USDC: `0x3600000000000000000000000000000000000000`
- One follower
- One `0.01 USDC` intent
- `0.00001 USDC` mirror fee: `0.000007` Forum / `0.000003` protocol
- Routing disabled by default and disabled again immediately after the mirror

The deploy script creates a separate mock asset, AMM, source registry, splitter, and canary router. It preconfigures the Forum split, registers Forum, seeds isolated liquidity, and configures one follower. It does not enable external routing.

## Deployment preparation

Use testnet-only keys supplied outside Git. Never print or commit them.

```bash
export ARC_RPC_URL=https://rpc.testnet.arc.network
export ARC_USDC=0x3600000000000000000000000000000000000000
export FORUM_FEE_ROUTER=0xeff9bc359e8f2a5eabce55af3f1bb24f98eabf59
export FORUM_SOURCE=0x13585c6004fbA9D7D49219a6435B68348fD30770
export FORUM_PAYOUT=0x13585c6004fbA9D7D49219a6435B68348fD30770
export PRIVATE_KEY=<shadow-testnet-deployer>
export FORUM_CANARY_FOLLOWER_PRIVATE_KEY=<distinct-testnet-follower>

# Mandatory read-only simulation first.
(cd contracts && forge script script/DeployForumCanary.s.sol:DeployForumCanary \
  --rpc-url "$ARC_RPC_URL")

# Run only after the simulation succeeds and an on-chain canary is authorized.
(cd contracts && forge script script/DeployForumCanary.s.sol:DeployForumCanary \
  --rpc-url "$ARC_RPC_URL" --broadcast)
```

Extract the five canary addresses from the resulting `run-latest.json`:

```bash
node scripts/extract-forum-canary-addresses.mjs \
  contracts/broadcast/DeployForumCanary.s.sol/5042002/run-latest.json
```

## Evidence sequence

1. Confirm routing is disabled, Forum is registered, and the follower policy is active.
2. Record a baseline with `MODE=snapshot`.
3. Enable routing from the Shadow protocol-recipient wallet.
4. Forum publishes exactly one intent from its confirmed source wallet:
   - `asset`: deployed `FORUM_CANARY_ASSET`
   - `amountUSDC`: `10000`
   - `minAmountOut`: `1`
   - `riskLevel`: `1`
   - `expiry`: current Arc block time plus 15 minutes
   - `intentHash`: unique for this canary
5. Disable routing immediately after the publish transaction confirms.
6. Verify the exact routed deltas with `MODE=route` and `MIRROR_TX`.
7. Forum and the protocol recipient each call FeeRouterV1 `claim()` from their own wallet.
8. Verify both exact claim transfers with `MODE=claims`.

The verifier writes a mode-`600` local state file. It compares pre/post deltas for this canary instead of trusting cumulative FeeRouter balances.

```bash
export RPC="$ARC_RPC_URL"
export SPLITTER=<FORUM_CANARY_SPLITTER>
export ROUTER=<FORUM_CANARY_ROUTER>
export PROTOCOL=<shadow-protocol-recipient>

MODE=snapshot node app/scripts/forum-canary-verify.mjs
MODE=route MIRROR_TX=0x... node app/scripts/forum-canary-verify.mjs
MODE=claims FORUM_CLAIM_TX=0x... PROTOCOL_CLAIM_TX=0x... \
  node app/scripts/forum-canary-verify.mjs
```

Do not label this as production routing, organic revenue, or independent security validation. The truthful claim is: one bounded external-builder integration pilot executed on Arc testnet with exact on-chain split and claim evidence.
