# Shadow Float V2 Signed Spend Example

This folder is a minimal builder kit for the current Shadow Float V2 path on Arc testnet.

It shows how an external agent can:

1. sign an EIP-712 `FloatSpendIntent` locally;
2. give the signed JSON to a sponsor or relayer;
3. let `ShadowFloat` verify the intent onchain and pay the provider from sponsor reserve;
4. repay the resulting line debt from the same agent wallet.

The private key stays on the builder's machine. The signing step sends no transaction and moves no funds.

## Current V2 Contract

| Item | Value |
| --- | --- |
| Chain | Arc Testnet, chain id `5042002` |
| `ShadowFloat` V2 | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Arc USDC | `0x3600000000000000000000000000000000000000` |
| Public RPC | `https://rpc.testnet.arc.network` |

## Install

```bash
cd examples/float-v2-signed-spend
npm install
```

## Sign A Spend Intent

Ask the sponsor to register your agent wallet and open a small sponsored line first. Then sign locally:

```bash
BUILDER_PRIVATE_KEY=0xYOUR_AGENT_PRIVATE_KEY \
EXPECTED_AGENT=0xYOUR_AGENT_WALLET \
FLOAT_AMOUNT_ATOMIC=10000 \
FLOAT_REASON="My agent uses Shadow Float V2 for an approved paid provider request." \
npm run sign
```

Optional bounds:

```bash
SHADOW_FLOAT=0x20dcA96B0C487D94De885c726c956ffaF38b12C2
FLOAT_PROVIDER=0x8ddf06fE8985988d3e0883F945E891BD57084937
FLOAT_ENDPOINT_HASH=0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160
FLOAT_EXECUTOR=0x...
FLOAT_INTENT_TTL_SECONDS=3600
ARC_RPC_URL=https://rpc.testnet.arc.network
```

Output shape:

```json
{
  "intent": {
    "agent": "0x...",
    "provider": "0x...",
    "endpointHash": "0x...",
    "amountUSDC": "10000",
    "maxDebtUSDC": "11000",
    "nonce": "178...",
    "expiry": "178...",
    "executor": "0x...",
    "reason": "My agent uses Shadow Float V2 for an approved paid provider request.",
    "float": "0x20dcA96B0C487D94De885c726c956ffaF38b12C2",
    "chainId": 5042002
  },
  "signature": "0x...",
  "digest": "0x..."
}
```

Send only that JSON to the sponsor or relayer. The `digest` is the request hash that appears in the onchain receipt after `requestSignedSpend`.

## Repay The Line

After the sponsor or relayer submits the signed intent and the provider is paid, repay from the same agent wallet:

```bash
BUILDER_PRIVATE_KEY=0xYOUR_AGENT_PRIVATE_KEY \
EXPECTED_AGENT=0xYOUR_AGENT_WALLET \
npm run repay
```

The script:

- reads active debt from `ShadowFloat.lines(agent)`;
- approves only the current debt amount if needed;
- calls `repay(agent, amount, requestHash)`;
- prints ArcScan links for the approval and repayment transactions.

## What This Proves

Safe wording:

> The agent signed a bounded V2 spend intent locally. `ShadowFloat` verified it onchain, paid the named provider from sponsor reserve, opened debt against the agent line, and repayment restored available capacity.

Do not claim:

- the agent shared its private key;
- the agent paid the provider directly;
- this is an open-ended public lending market;
- provider service quality was judged by the contract.

## Verify The Public Deployment

From the repo root:

```bash
npm run float:v2-verify-live
curl -s https://shadow-arc.vercel.app/api/float?mode=v2
```
