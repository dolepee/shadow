# Circle Gateway Nanosettlement

Shadow has a credential-aware Circle Gateway settlement path for copied mirror receipts and a small Gateway settlement-layer proof over recorded Float Desk activity.

## What Ships

- `/api/settlements` lists recorded Gateway nanosettlements from KV.
- `POST /api/settlements` verifies the supplied `mirrorTx` contains a copied `MirrorReceipt` for the same `follower`, `sourceAgent`, and `intentId`.
- Blocked receipts are rejected before payment handling. Refusals stay free.
- If no `payment-signature` header is supplied, the route returns an x402 `402` with a `PAYMENT-REQUIRED` header for Circle Gateway batching.
- If a valid Gateway payment is supplied, the route calls `BatchFacilitatorClient.verify()` and `BatchFacilitatorClient.settle()`, then stores a settlement record in KV.
- `/api/state` annotates copied receipt rows with `gatewaySettlement` only when a real settled record exists.
- The receipts UI renders a quiet line only for settled records: `fee 0.0001 USDC settled · Gateway`.

## Rail

Reference pattern: Circle's `arc-nanopayments` sample uses `@circle-fin/x402-batching/server`, `payment-signature`, `x402Version: 2`, Arc network `eip155:5042002`, and `GatewayWalletBatched` requirements.

Shadow follows that charge-verify-settle pattern instead of inventing a custom payment rail.

## Env

Required for live settlement:

- `ARC_RPC_URL`
- `SHADOW_ROUTER`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `GATEWAY_SETTLEMENT_PAY_TO`, or `X402_PAY_TO`

Optional:

- `GATEWAY_NANOSETTLEMENT_FEE_ATOMIC`, default `100` = `0.0001` USDC.
- `GATEWAY_WALLET_ADDRESS`, default `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`.
- `GATEWAY_FACILITATOR_URL`, default SDK endpoint.
- `GATEWAY_PAYER_PRIVATE_KEY`, local operator script only.
- `SHADOW_APP_URL`, local operator script target.

## Operator Flow

```bash
cd app
pnpm gateway:settle
```

Without `GATEWAY_PAYER_PRIVATE_KEY`, the script only selects the newest unsettled copied receipt and prints the exact body it would settle. With a funded Arc testnet Gateway payer key, it calls `/api/settlements` through `GatewayClient.pay()`.

For the Float Desk settlement-layer proof:

```bash
node app/scripts/float-desk-gateway-batch.mjs
GATEWAY_DESK_LIVE=1 node app/scripts/float-desk-gateway-batch.mjs
```

The Desk script reads `GET /api/float?mode=desk`, selects unsettled `PAY` cycles, checks the payer's Gateway wallet balance, and pays `/api/settlements` only when the posted cycle, spend tx, request hash, and amount match the public Desk journal.

## Verification

Expected checks:

```bash
pnpm --dir app typecheck
pnpm --dir app build
curl https://shadow-arc.vercel.app/api/settlements
```

For a live settlement, run:

```bash
cd app
GATEWAY_PAYER_PRIVATE_KEY=0x... SHADOW_APP_URL=https://shadow-arc.vercel.app pnpm gateway:settle
```

The resulting settlement should appear in `/api/settlements`, then in `/api/state` under the matching copied receipt.

For the Desk settlement-layer proof, check `deskRecords`:

```bash
curl https://shadow-arc.vercel.app/api/settlements
```

## Live settlement proof (Jun 12, 2026)

First real batch settled: 5 copied mirror receipts charged 0.0001 USDC each via Circle Gateway (GatewayWalletBatched), payer CatArb `0xBDb1...1Fb8`, batch `25f6e033-e6bd-4229-b6f0-80d108928771`, records served at `/api/settlements` and merged into `/api/state` receipt rows.

Operational notes discovered en route: the payer must `deposit()` USDC into the Gateway wallet first (spending uses Gateway balance, not the raw token balance); advertised `maxTimeoutSeconds` must be long (30d) or the facilitator rejects `authorization_validity_too_short`; never send a duplicate content-type header (platform rejects the body).

## Live Desk settlement proof (Jul 2, 2026)

Two recorded Float Desk `PAY` cycles were settled through Circle Gateway batching as a settlement-layer demonstration over real Desk activity. Total: `0.002` USDC. This is not the V2 provider payment path, does not pay the provider, and is not counted as external traction.

| Desk row | Provider | Desk spend tx | Desk repay tx | Gateway transaction | Amount |
| --- | --- | --- | --- | --- | ---: |
| `1783003020813-e81c6f7d39776` | CitePay | [`0x6fdca5...0529e`](https://testnet.arcscan.app/tx/0x6fdca5ffd1c6594d2da90044e58faeccafa6f0d20c7bac6b9b1ab81a2f40529e) | [`0xf65029...9fab8`](https://testnet.arcscan.app/tx/0xf65029594628b7bf45ce22cfce37ebbaa63c0570eda9994ea7b124b9eda9fab8) | `cad5a209-df11-4eb3-95e6-29b442c6293c` | 0.001 USDC |
| `1782999548774-e277987cbb8bd` | Shadow | [`0x3384de...98d5`](https://testnet.arcscan.app/tx/0x3384de954d7504757d024a038af6234135fcb6caafbb5b0f20416ec17c0e98d5) | [`0x688fc4...bd52`](https://testnet.arcscan.app/tx/0x688fc4d3166ac48b064a03881a9a3dd3aa9c4d4c0ec3dd741a14844ad43cbd52) | `910c14fc-3af9-4716-81f3-9144e31d2650` | 0.001 USDC |

The payer was `0xBDb1...1Fb8`. Before settlement the payer had `0.99887` USDC available in its Gateway wallet, and the script settled both rows without depositing more funds. The public record is served from `/api/settlements` under `deskRecords`.
