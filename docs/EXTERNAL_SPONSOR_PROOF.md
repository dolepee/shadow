# Shadow Float V2 External Sponsor Proof

Shadow Float V2 has now been exercised by non-operator sponsors. The sponsor wallet reserves its own Arc USDC for a specific agent line, the agent signs a bounded V2 spend, `ShadowFloat` pays the provider from that reserve, and repayment restores the line.

## Contract

| Item | Value |
| --- | --- |
| Chain | Arc Testnet, `5042002` |
| ShadowFloat V2 | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Arc USDC | `0x3600000000000000000000000000000000000000` |
| Shadow operator | `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8` |

## CitePay External Sponsor

CitePay is a live non-operator sponsor on Float V2. Its sponsor wallet is not the Shadow operator wallet, and the sponsored agent repaid the provider draw.

| Step | Tx |
| --- | --- |
| Approve reserve | [`0xa23a69aa34d4d3532ad1cc15718ca9a8537a9d085a9312937a2596ba319ad2af`](https://testnet.arcscan.app/tx/0xa23a69aa34d4d3532ad1cc15718ca9a8537a9d085a9312937a2596ba319ad2af) |
| `openSponsoredLine` | [`0xf2dabb1ce651330a389acd4d6cacee1a859dc4fc12f18459143dc0f60ee53540`](https://testnet.arcscan.app/tx/0xf2dabb1ce651330a389acd4d6cacee1a859dc4fc12f18459143dc0f60ee53540) |
| Bind spend intent | [`0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae`](https://testnet.arcscan.app/tx/0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae) |
| Repay | [`0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe`](https://testnet.arcscan.app/tx/0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe) |

| Field | Value |
| --- | --- |
| Sponsor | `0x5389688243328c26a92b301faEEAb5fbf9AFf105` |
| Agent | `0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f` |
| Reserve | `50000` atomic USDC |
| Spend amount | `10000` atomic USDC |
| End state | `REPAID`, live sponsor reserve |

## Forum Tollgate External Sponsor

Forum Tollgate completed the full sponsor lifecycle. The sponsor opened the reserve, the agent spent from that reserve, the agent repaid, then the sponsor closed the line and reclaimed the full reserve.

| Step | Tx |
| --- | --- |
| `openSponsoredLine` | [`0x8f9759660161819cf924314abcaf2feefb55d973a845c6ed0921d14e560c79df`](https://testnet.arcscan.app/tx/0x8f9759660161819cf924314abcaf2feefb55d973a845c6ed0921d14e560c79df) |
| Bind spend intent | [`0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f`](https://testnet.arcscan.app/tx/0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f) |
| Repay | [`0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172`](https://testnet.arcscan.app/tx/0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172) |
| `closeSponsoredLine` | [`0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463`](https://testnet.arcscan.app/tx/0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463) |

| Field | Value |
| --- | --- |
| Sponsor | `0x12F25B721Cc21c38495e33A4c8524dd0B647ba03` |
| Agent | `0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C` |
| Reserve | `50000` atomic USDC |
| Spend amount | `10000` atomic USDC |
| End state | repaid, closed, reserve reclaimed |

## Claim Boundary

This proves the permissionless sponsor path with non-operator wallets. It does not claim a production lending market, a liquidity pool, or mainnet credit risk. The testnet proof is narrower and stronger: outside wallets supplied sponsor reserve, agents used V2 signed intents, providers were paid from contract custody, debt was repaid, and one sponsor reclaimed the reserve.
