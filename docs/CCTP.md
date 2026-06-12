# CCTP Follower Funding Groundwork

This pass adds the acknowledgement layer for "fund your mirror from any chain" without pretending that acknowledgement is the same as a Shadow Router deposit.

## What Ships

- `/api/cctp-funding` verifies a Circle CCTP attestation for a supplied source-chain burn transaction.
- The route stores an acknowledgement in KV when configured.
- `app/scripts/cctp-verify.mjs` gives reviewers a one-command check against a burn transaction.
- The response explicitly returns `credited: false` because the actual Arc mint plus `MirrorRouter.depositUSDC()` execution is a later integration step.

## Flow

1. A follower burns USDC on a supported source testnet.
2. The reviewer calls `/api/cctp-funding` with `burnTx`, `sourceDomain`, and optionally `follower` plus `expectedAmountAtomic`.
3. Shadow queries Circle Iris sandbox for the burn attestation.
4. If the attestation is complete, Shadow records an acknowledgement that the follower funding path is verified.
5. A later worker can execute the Arc mint and router deposit using the attestation payload.

## Env

Required for live acknowledgement:

- `CCTP_ATTESTATION_API_URL`, default `https://iris-api-sandbox.circle.com`

Optional persistence:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

Script inputs:

- `CCTP_BURN_TX`
- `CCTP_SOURCE_DOMAIN`
- `CCTP_FOLLOWER`
- `CCTP_EXPECTED_AMOUNT_ATOMIC`
- `SHADOW_APP_URL`

## Run

```bash
cd app
CCTP_BURN_TX=0x... CCTP_SOURCE_DOMAIN=6 pnpm cctp:verify
```

Equivalent direct API call:

```bash
curl -sS https://shadow-arc.vercel.app/api/cctp-funding \
  -H 'content-type: application/json' \
  -d '{"burnTx":"0x...","sourceDomain":6,"follower":"0x...","expectedAmountAtomic":"1000000"}'
```

## Current Blocker

No source-chain testnet burn transaction was provided in this branch, and the repo does not contain faucet-funded CCTP test wallets. Because of that, there is no executed example hash to cite yet.

The route is honest by construction:

- `acknowledged: true` only when Circle returns a complete attestation.
- `credited: false` until a future Arc mint/deposit worker actually credits the follower in Shadow.
- Public errors are sanitized and do not echo raw upstream responses or tokens.

## References

- Circle CCTP Iris attestation API: `GET /v2/messages/{sourceDomain}?transactionHash={burnTx}`
- Circle Gateway multichain sample: `circlefin/arc-multichain-wallet`
- Gateway domain used for Arc testnet in the Circle sample: `26`
