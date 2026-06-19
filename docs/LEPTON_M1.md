# Shadow Lepton M1

Shadow's Lepton M1 surface is a protocol-facing mandate engine for Arc DeFi.

It is intentionally separate from `MirrorRouter`. Copy-trading remains adapter one and proof of demand; Lepton M1 exposes the reusable primitive underneath it: a USDC mandate is checked before capital moves, every allow/block produces an onchain receipt, and the enforcing surface must be bonded.

## What Ships

- `MandateRegistry`: stores a Circle-wallet-scoped USDC mandate with max size, daily cap, risk limit, slippage floor, action type, and target.
- `MandateAttestor`: records neutral `ALLOW` / `BLOCK` receipts keyed by mandate hash and action hash.
- `BondedMandateEnforcer`: requires a USDC bond before an enforcer can write receipts or consume mandate spend; committed actions with missing receipts can be challenged and slashed.
- `V4StyleArcAdapter`: an honestly labeled v4-style Arc adapter that is swap-only, checks a mandate before moving USDC to a liquidity sink, and exposes pool-key execution references for future PoolManager/hook integration.
- `MorphoStyleVaultAdapter`: an honestly labeled Morpho-style deposit adapter that is deposit-only, checks the same mandate engine before moving USDC to a vault sink, and binds execution references to market-like fields.
- `MandateVaultSink`: a tiny protocol-like vault destination that records receipt-linked USDC deposits after an adapter moves funds. Each protocol adapter should use its own sink.
- `RiskPolicy.evaluateSnapshot`: pure policy evaluation support reused from the existing copy-trading router.

## What This Proves

1. A Circle wallet/account can own a mandate for USDC movement.
2. A DeFi action is evaluated before USDC leaves that account.
3. Valid actions produce an `ALLOW` receipt and then move USDC.
4. The vault records the matching receipt hash and action hash for allowed deposits.
5. Invalid actions produce a `BLOCK` receipt and do not move USDC.
6. The adapter cannot enforce without a posted USDC bond.
7. A bonded enforcer that commits to an action and misses the receipt deadline can be slashed objectively.
8. The existing `MirrorRouter` path still passes its full test suite.
9. The same mandate engine can gate more than one DeFi adapter surface: swap-style flow for Uniswap v4 readiness and deposit-style flow for Morpho-like allocation.

## What This Does Not Claim

- This is not a live Uniswap v4 hook on Arc.
- This is not a live Morpho integration.
- This is not a claimed protocol partnership.
- This does not add subjective slashing or human disputes.
- This does not let an LLM override deterministic policy.

The adapter is named `V4StyleArcAdapter` because Arc has announced Uniswap support, but Uniswap's official v4 deployment list does not currently publish an Arc PoolManager address. When an official Arc PoolManager exists, the adapter can be replaced by a real hook that calls the same mandate engine.

The adapter is named `MorphoStyleVaultAdapter` because a Morpho-like deposit/allocation gate is the realistic first protocol-design-partner shape before Arc has live Uniswap v4 hooks. It is not claiming Morpho partnership or production integration; it proves that the primitive can gate a vault deposit before USDC moves.

## Protocol Adapter Surfaces

| Surface | Action type | Proof status | What is bound into the receipt path |
| --- | --- | --- | --- |
| `V4StyleArcAdapter` | `SWAP` | Deployed on Arc testnet and proven through EOA + Circle passkey flows | USDC account, amount, risk, slippage floor, target adapter, and a pool-key-shaped `executionRef` |
| `MorphoStyleVaultAdapter` | `DEPOSIT` | Deployed on Arc testnet and proven through allowed + blocked deposit actions | USDC account, amount, risk, target adapter, market-like parameters, and a vault deposit record |

## Current Arc Testnet Proof

Deployed June 19, 2026 on Arc Testnet (`5042002`):

| Contract | Address |
| --- | --- |
| `MandateRegistry` | `0x394b6955162ce147e813e0eea6104cd1164e3d33` |
| `MandateAttestor` | `0x440ef290d63174182c6115b4356727e0ac136d48` |
| `BondedMandateEnforcer` | `0x05a11588155c6bde55bb7b3986f200ca556b23cc` |
| `MandateVaultSink` | `0x2b18c771466f8647df2ef32a459fcc54438b2de7` |
| `V4StyleArcAdapter` | `0x16ebc65c9f3188734277c9fafd73d9f13b93d868` |
| `MorphoStyleVaultAdapter` | `0x805db94a0b94c0d937063291ddaafb41690f5dee` |
| `MorphoStyleVaultSink` | `0x0e157aeaffbebe59becb7b93007015a06c5dec90` |

The v4-style adapter and Morpho-style adapter are separate bonded surfaces that share the same `MandateRegistry`, `MandateAttestor`, and `BondedMandateEnforcer`. Each adapter has its own `MandateVaultSink`, so one proof surface does not overwrite the other.

Deployment txs:

- Registry: `0x6f7d62f0b574033d26459db4d73f1d3f7243c845cf5aacb8ad48f6bbcb5e4d7a`
- Attestor: `0x2095ffabb2876fc416e97869a3ef2d2646897c0669c11d5de6bef554f1f86d6e`
- Enforcer: `0x1c7d2651cf9e2195d8ca92300ddd38a77d8b9cb1e3426c8a877336c5c8e0295e`
- Vault sink: `0x3e904f2502b6ea4f61a9258b23d387b06d74a57e34239e52296d8c3d2a5f8b46`
- Adapter: `0xb9740acad0084f2ed9b66ae4e463ce901dc3ef3921357340399492cb2156042a`
- Registry recorder set: `0xc3c585a31f812fbcefd4d3eccd65fccc95ef0e782ab35691050430fd5cc72b4a`
- Attestor recorder set: `0x92d7a6f971681fe8e489fafd115f2bc147802c79f3d1f1a87375a01216163391`
- Vault adapter set: `0x88640fb23032725a9bde63dc2819d01e229ad4b8e2a075c9472703ab1b6365d9`
- Morpho vault sink: `0x17fd79d065efb5a88bd2b946d8355060f1cb41815b0d461cc4155c46642e5fb1`
- Morpho adapter: `0x6938f27ae9c5680b5cae554c98089ad28b4ddcbf45bffe568b6005ea86bf0203`
- Morpho vault adapter set: `0x42497c0b4c5d6f1fba8d4c207a9aea9e2fb52bd1e03a4111baf20d547bbdc5a1`
- Morpho adapter bond: `0xfbde9d9cf35a5e86e9a5af1a136cf18a48c232c3b3bdf62b25ffc1705bf03f43`

Smoke proof:

- `approve`: `0x7ec343b603b8790528832c206196fe11212f7a06d23bd6fa8ad1963629fd810e`
- `postBond(10 USDC)`: `0xf87cdee0ea104eb30c19c7c5655947a0df629624ea5a1665aa806c4e38f5ceda`
- `createMandate`: `0x0919cbee2e2b90a8c304cdae1ed6cc953c067bd49276bf43d9fea232f1ed1b72`
- `ALLOW` action: `0x2146f5b71e0ac8d6a0d30b1d0b2e2e8a32f425f74ecef2f311492dd371193e33`
- `BLOCK` action: `0xadea704aab48407203293f355deb056cabec42ec2e57fbee76e78f521a3352d1`

Verified post-smoke state:

- `MandateAttestor.receiptCount() = 2`
- `V4StyleArcAdapter.adapterBondUSDC() = 10 USDC`
- `V4StyleArcAdapter.executedUSDC() = 1 USDC`
- `V4StyleArcAdapter.blockedUSDC() = 3 USDC`
- `MandateVaultSink.totalDepositedUSDC() = 1 USDC`

Circle passkey proof:

- Smart account: `0x6994ebdef63aa0e665e3c781ed54e2e181869a7a`
- Batched sponsored tx: `0x98b8b175d4ec8bf6d457d653383932e69d74300bd0b8a7e324e0cae3ac35a529`
- Mandate created: `#2`
- Allowed action: `0.01 USDC`
- Flow: Circle passkey MSCA approved USDC, created a mandate, and executed the Lepton adapter action in one Circle Gas Station sponsored UserOp.

Verified post-passkey state:

- `MandateAttestor.receiptCount() = 3`
- `V4StyleArcAdapter.adapterBondUSDC() = 10 USDC`
- `V4StyleArcAdapter.executedUSDC() = 1.01 USDC`
- `V4StyleArcAdapter.blockedUSDC() = 3 USDC`
- `MandateVaultSink.totalDepositedUSDC() = 1.01 USDC`

Morpho-style vault proof:

- `createMandate`: `0xd71706058602546bc97718c0c166da602436e16041f000ffbdadccd5f380af97`
- `ALLOW` deposit: `0x477f9378f0f8d68302d5cfa7149026e6597fadd2a9939ade4931efe72e0031cc`
- `BLOCK` deposit: `0xcc72f59c00df7109b2140d9a30053930592df29eb72827223a8283088c12bef9`

Verified post-Morpho state:

- `MandateAttestor.receiptCount() = 5`
- `MorphoStyleVaultAdapter.adapterBondUSDC() = 10 USDC`
- `MorphoStyleVaultAdapter.depositedUSDC() = 0.1 USDC`
- `MorphoStyleVaultAdapter.blockedUSDC() = 0.3 USDC`
- `MorphoStyleVaultSink.totalDepositedUSDC() = 0.1 USDC`

## Deploy

```bash
export PRIVATE_KEY=0x...
export ARC_RPC_URL=https://...
export ARC_USDC=0x...
export LEPTON_MIN_BOND_USDC=10000000

forge script contracts/script/DeployLeptonM1.s.sol:DeployLeptonM1 \
  --root contracts \
  --rpc-url "$ARC_RPC_URL" \
  --broadcast
```

After deploy:

1. Fund the adapter or intended enforcer with USDC.
2. Approve `BondedMandateEnforcer`.
3. Call `postBond` on `V4StyleArcAdapter` or `bond` on `BondedMandateEnforcer`.
4. Create a USDC mandate in `MandateRegistry`.
5. Call the adapter with a matching `MandateRegistry.Action`.

For Arc testnet, use the viem smoke runner. Arc USDC's precompile can fail during Forge simulation on `transferFrom`; the runner sends explicit gas like the existing Shadow V4 scripts.

```bash
export LEPTON_REGISTRY=0x...
export LEPTON_ATTESTOR=0x...
export LEPTON_VAULT_SINK=0x...
export LEPTON_ADAPTER=0x...
export LEPTON_SMOKE_ALLOW_USDC=1000000
export LEPTON_SMOKE_DAILY_CAP_USDC=2000000
export LEPTON_SMOKE_BLOCK_USDC=3000000

pnpm --dir agent lepton-smoke
```

This creates one allowed receipt and one blocked receipt. For the final Lepton demo, the `circleAccount` should be the Circle wallet or account that approved the adapter.

## Verification

```bash
npm run contracts:build
npm run contracts:test
```

Expected result after the protocol-adapter expansion: 45 tests pass across `ShadowFlow`, `MandateEnforcer`, `V4StyleArcAdapter`, and `MorphoStyleVaultAdapter`.

## App Surface

The app reads the current Arc testnet Lepton M1 deployment on `/lepton` by default. These public Vite variables can override the default addresses:

```bash
VITE_SHADOW_MANDATE_REGISTRY=0x...
VITE_SHADOW_MANDATE_ATTESTOR=0x...
VITE_SHADOW_BONDED_ENFORCER=0x...
VITE_SHADOW_V4_STYLE_ADAPTER=0x...
```

Without those addresses, the page renders as deploy-pending and does not invent contract metrics. The vault sink address is read from `V4StyleArcAdapter.liquiditySink()` after deployment.
