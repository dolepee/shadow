# Circle Gateway Nanosettlement

Shadow now has a credential-aware Circle Gateway settlement path for copied mirror receipts.

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

## Current Blocker

This branch does not include a live Gateway batch transaction because no funded Gateway payer key or follower payment signature is present in the repo. The code is ready to settle once the reviewer configures the env above and funds the payer Gateway balance on Arc testnet.

Until that happens, the UI will not display settled Gateway lines. That is intentional: Shadow must not invent settlement amounts or label simulations as real money movement.

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
