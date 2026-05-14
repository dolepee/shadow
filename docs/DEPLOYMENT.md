# Shadow Deployment

Shadow has two deployment paths.

## Local Path

Use this path to prove the flow without Arc testnet dependencies. It deploys mock USDC and ARCETH.

```bash
anvil
PRIVATE_KEY=<anvil-key-0> forge script contracts/script/DeployShadow.s.sol:DeployShadow \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast
```

Then extract addresses:

```bash
npm run extract:addresses -- contracts/broadcast/DeployShadow.s.sol/31337/run-latest.json
```

Run `SeedShadow.s.sol` with the emitted addresses plus local source and follower keys.

## Arc Testnet Path

Use this path for the submitted demo. It uses official Arc testnet USDC at:

```text
0x3600000000000000000000000000000000000000
```

Only ARCETH is a controlled test asset.

Required:

- Arc testnet RPC URL.
- Deployer private key funded with enough Arc testnet USDC for AMM liquidity, seed transfers, and gas. The default seed needs 5 ERC20 USDC for liquidity, 4 ERC20 USDC for follower balances, and native USDC for transaction fees and gas stipends.
- Cat agent private key.
- Lobster agent private key.
- Follower A private key.
- Follower B private key.

Get Arc testnet USDC from Circle's faucet:

```text
https://faucet.circle.com
```

Arc uses native USDC for gas with 18 decimals, while the ERC20 USDC contract uses 6 decimals. The seed script sends both a small native gas stipend and ERC20 USDC balances to the source and follower wallets.

Deploy:

```bash
set -a
source .env
set +a
npm run contracts:deploy:arc
```

Extract addresses:

```bash
npm run extract:addresses -- contracts/broadcast/DeployShadowArc.s.sol/5042002/run-latest.json
```

Add `SHADOW_ARCETH`, `SHADOW_AMM`, `SHADOW_REGISTRY`, and `SHADOW_ROUTER` to `.env`, then seed:

```bash
npm run contracts:seed:arc
```

## Frontend Config

Add public Vite variables before deploying the web app:

```bash
VITE_ARC_RPC_URL=<arc-rpc-url>
VITE_ARC_USDC=0x3600000000000000000000000000000000000000
VITE_SHADOW_ARCETH=<deployed-arceth>
VITE_SHADOW_AMM=<deployed-amm>
VITE_SHADOW_REGISTRY=<deployed-registry>
VITE_SHADOW_ROUTER=<deployed-router>
VITE_SHADOW_START_BLOCK=<deploy-block>
```

Then verify:

```bash
pnpm --dir app typecheck
pnpm --dir app build
```

## Product Boundaries

The Arc testnet demo should say:

- controlled Arc testnet AMM
- policy-controlled intent mirroring
- real USDC escrow
- onchain copied receipt
- onchain blocked receipt
- USDC mirror fee accounting

Do not say production DEX execution or guaranteed profit.
