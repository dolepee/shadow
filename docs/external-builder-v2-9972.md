# Shadow Float V2 Crux signer proof

This is the completed V2 proof for the Crux signer wallet below. The EIP-712 intent was signed, submitted, and consumed on-chain. The typed data is kept here as the historical artifact, not as a fresh signing request.

## Registered line

| Field | Value |
| --- | --- |
| Agent wallet | `0x9972fF27a2EADBDB8414072736395236E0BF0092` |
| Signer source | `https://github.com/dmetagame/crux` |
| Shadow Float V2 | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Sourcify source | https://sourcify.dev/server/v2/contract/5042002/0x20dcA96B0C487D94De885c726c956ffaF38b12C2 |
| Arc chain id | `5042002` |
| Arc USDC | `0x3600000000000000000000000000000000000000` |
| Sponsor / executor | `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8` |
| Provider | `0x8ddf06fE8985988d3e0883F945E891BD57084937` |
| Endpoint hash | `0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160` |
| Sponsor reserve | `0.05` USDC |
| Current credit limit | `0.025` USDC |
| Final available after repay | `0.05` USDC |
| Final active debt | `0` USDC |
| Final status | `REPAID` |
| Max per request | `0.01` USDC |
| Registration tx | `0xb56c16f713e9b4da6b84ab28df05c4fc4c72812ed0a3a0a8d6c616866f9c1322` |
| Spend tx | `0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d` |
| Repay tx | `0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368` |

Registration tx:

```text
https://testnet.arcscan.app/tx/0xb56c16f713e9b4da6b84ab28df05c4fc4c72812ed0a3a0a8d6c616866f9c1322
```

Spend tx:

```text
https://testnet.arcscan.app/tx/0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d
```

Repay tx:

```text
https://testnet.arcscan.app/tx/0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368
```

## Completed on-chain proof

- `FloatIntentConsumed` emitted `requestHash = 0xf6b911c2cf24eae727d49888862ee8278b71f79a0fad25b8424cfcff28d0c41a`.
- `agent` and recovered signer both equal `0x9972fF27a2EADBDB8414072736395236E0BF0092`.
- `nonce = 1782508136338` is consumed and cannot be replayed.
- Arc USDC transfer moved `10000` atomic units, `0.01` USDC, from `ShadowFloat` custody to provider `0x8ddf06fE8985988d3e0883F945E891BD57084937`.
- The agent wallet was not debited during the spend.
- The signer repaid from the same wallet in tx `0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368`.
- Final line state: `activeDebtUSDC = 0`, `status = REPAID`, `availableCreditUSDC = 50000`.

## What this signature authorizes

This does not approve USDC and does not debit the agent wallet. It signs one bounded spend intent for Shadow Float V2.

The V2 contract enforces on-chain:

- `agent` must be the recovered signer.
- `provider` must match the signed provider.
- `endpointHash` must match the signed endpoint.
- `amountUSDC` is capped at `0.01` USDC.
- cumulative debt after the spend must be at most `0.011` USDC.
- `nonce` can be consumed once only.
- `expiry` is enforced by the contract.
- `executor` is locked to `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8`.
- provider payment comes from `ShadowFloat` custody, not from the agent wallet.

Expiry: `2026-06-29T21:08:56.000Z`.

## Historical EIP-712 typed data

This was the exact typed data signed by the Crux signer wallet `0x9972fF27a2EADBDB8414072736395236E0BF0092`. Do not ask the signer to sign this same nonce again because it has already been consumed.

```json
{
  "domain": {
    "name": "ShadowFloat",
    "version": "1",
    "chainId": 5042002,
    "verifyingContract": "0x20dcA96B0C487D94De885c726c956ffaF38b12C2"
  },
  "types": {
    "FloatSpendIntent": [
      { "name": "agent", "type": "address" },
      { "name": "provider", "type": "address" },
      { "name": "endpointHash", "type": "bytes32" },
      { "name": "amountUSDC", "type": "uint256" },
      { "name": "maxDebtUSDC", "type": "uint256" },
      { "name": "nonce", "type": "uint256" },
      { "name": "expiry", "type": "uint256" },
      { "name": "executor", "type": "address" },
      { "name": "reason", "type": "string" }
    ]
  },
  "primaryType": "FloatSpendIntent",
  "message": {
    "agent": "0x9972fF27a2EADBDB8414072736395236E0BF0092",
    "provider": "0x8ddf06fE8985988d3e0883F945E891BD57084937",
    "endpointHash": "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160",
    "amountUSDC": "10000",
    "maxDebtUSDC": "11000",
    "nonce": "1782508136338",
    "expiry": "1782767336",
    "executor": "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8",
    "reason": "External builder V2 sponsored spend: agent uses Shadow Float for a paid provider-data purchase."
  }
}
```

Expected digest:

```text
0xf6b911c2cf24eae727d49888862ee8278b71f79a0fad25b8424cfcff28d0c41a
```

The tx must show:

- `FloatIntentConsumed` with `requestHash = 0xf6b911c2cf24eae727d49888862ee8278b71f79a0fad25b8424cfcff28d0c41a`.
- `intentNonceUsed(agent, 1782508136338) = true`.
- USDC transfer of `10000` atomic units (`0.01` USDC) from `ShadowFloat` to the provider.
- active debt of `0.01` USDC on the agent line.

## Final lifecycle state

- `activeDebtUSDC = 0`.
- `status = REPAID`.
- `availableCreditUSDC = 50000`.
- `allowance = 0`.
- a `REPAID` receipt emitted on Arc.
