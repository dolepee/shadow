# Shadow Float V2 External Sponsor Proof

Shadow Float V2 has now been exercised by non-operator sponsors. The sponsor wallet reserves its own Arc USDC for a specific agent line, the agent signs a bounded V2 spend, `ShadowFloat` pays the provider from that reserve, and repayment restores the line.

## Contract

| Item | Value |
| --- | --- |
| Chain | Arc Testnet, `5042002` |
| ShadowFloat V2 | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Arc USDC | `0x3600000000000000000000000000000000000000` |
| Shadow operator | `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8` |

## CitePay Returning External Sponsor

CitePay is a live non-operator sponsor on Float V2. Its sponsor wallet is not the Shadow operator wallet. The original sponsored agent completed a spend-and-repay cycle. CitePay later retired that debt-free line, reclaimed the reserve, opened a replacement line for a newly controlled agent, and completed another spend-and-repay cycle with the same capital.

This proves repeat sponsor behavior across two line generations. It does not claim that either agent address is itself a returning agent.

### Retired line

| Step | Tx |
| --- | --- |
| Approve reserve | [`0xa23a69aa34d4d3532ad1cc15718ca9a8537a9d085a9312937a2596ba319ad2af`](https://testnet.arcscan.app/tx/0xa23a69aa34d4d3532ad1cc15718ca9a8537a9d085a9312937a2596ba319ad2af) |
| `openSponsoredLine` | [`0xf2dabb1ce651330a389acd4d6cacee1a859dc4fc12f18459143dc0f60ee53540`](https://testnet.arcscan.app/tx/0xf2dabb1ce651330a389acd4d6cacee1a859dc4fc12f18459143dc0f60ee53540) |
| Bind spend intent | [`0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae`](https://testnet.arcscan.app/tx/0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae) |
| Repay | [`0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe`](https://testnet.arcscan.app/tx/0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe) |
| `closeSponsoredLine` | [`0x2d91c37cc23ff8f342614bb9070e82efb37d0d588b15a43a3685c92786074e0d`](https://testnet.arcscan.app/tx/0x2d91c37cc23ff8f342614bb9070e82efb37d0d588b15a43a3685c92786074e0d) |

| Field | Value |
| --- | --- |
| Sponsor | `0x5389688243328c26a92b301faEEAb5fbf9AFf105` |
| Agent | `0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f` |
| Reserve | `50000` atomic USDC |
| Spend amount | `10000` atomic USDC |
| End state | `REVOKED`, zero debt, reserve reclaimed; retained as historical proof |

### Renewed line

| Step | Tx |
| --- | --- |
| Approve reserve | [`0xb6bb9f2aba106a3e4384107c32a34f45b97e33d23c22dab75d314553a35bafe2`](https://testnet.arcscan.app/tx/0xb6bb9f2aba106a3e4384107c32a34f45b97e33d23c22dab75d314553a35bafe2) |
| `openSponsoredLine` | [`0x4e3d8318cb8bed6b71afd716dc0f792a77cf04ceefa6986c436132a307470243`](https://testnet.arcscan.app/tx/0x4e3d8318cb8bed6b71afd716dc0f792a77cf04ceefa6986c436132a307470243) |
| Bind spend intent | [`0x9007d0e8f66c0bc641caaa305266d50aeb5e2e969ff3edbbd8122542ed08eae4`](https://testnet.arcscan.app/tx/0x9007d0e8f66c0bc641caaa305266d50aeb5e2e969ff3edbbd8122542ed08eae4) |
| Approve repayment | [`0x7ddf5e6379849d366d2c26d527df843185a5de346196e7a4c4c331fd3314be03`](https://testnet.arcscan.app/tx/0x7ddf5e6379849d366d2c26d527df843185a5de346196e7a4c4c331fd3314be03) |
| Repay | [`0x52ef42211858713601721a9ae6935604c43c04a832fd7d7c5aef6c7c8156a911`](https://testnet.arcscan.app/tx/0x52ef42211858713601721a9ae6935604c43c04a832fd7d7c5aef6c7c8156a911) |

| Field | Value |
| --- | --- |
| Sponsor | `0x5389688243328c26a92b301faEEAb5fbf9AFf105` |
| Agent | `0x236652EAd43fbb0948173fC4dDF23BC0971B274d` |
| Reserve | `50000` atomic USDC |
| Spend amount | `5000` atomic USDC |
| Line expiry | `2026-10-16T18:28:22Z` |
| End state | `REPAID`, zero debt, full 0.05 USDC capacity available |

## Forum Tollgate External Sponsor

Forum Tollgate completed the full sponsor lifecycle. The sponsor opened the reserve, the agent spent from that reserve, the agent repaid, then the sponsor closed the line and reclaimed the full reserve. Forum later reopened a fresh 0.05 USDC reserve and left it live through judging.

| Step | Tx |
| --- | --- |
| `openSponsoredLine` | [`0x8f9759660161819cf924314abcaf2feefb55d973a845c6ed0921d14e560c79df`](https://testnet.arcscan.app/tx/0x8f9759660161819cf924314abcaf2feefb55d973a845c6ed0921d14e560c79df) |
| Bind spend intent | [`0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f`](https://testnet.arcscan.app/tx/0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f) |
| Repay | [`0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172`](https://testnet.arcscan.app/tx/0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172) |
| `closeSponsoredLine` | [`0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463`](https://testnet.arcscan.app/tx/0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463) |
| Reopen reserve | [`0xc8694da66f078d81c4199df813e8ee7b69941a14b6aef4531f6c35ca771da2e6`](https://testnet.arcscan.app/tx/0xc8694da66f078d81c4199df813e8ee7b69941a14b6aef4531f6c35ca771da2e6) |

| Field | Value |
| --- | --- |
| Sponsor | `0x12F25B721Cc21c38495e33A4c8524dd0B647ba03` |
| Agent | `0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C` |
| Reserve | `50000` atomic USDC |
| Spend amount | `10000` atomic USDC |
| End state | repaid, reserve reclaimed once, then reopened; current expiry is chain-derived on the live board |

## Claim Boundary

This proves the permissionless sponsor path with non-operator wallets. It does not claim a production lending market, a liquidity pool, or mainnet credit risk. The testnet proof is narrower and stronger: outside wallets supplied sponsor reserve, agents used V2 signed intents, providers were paid from contract custody, debt was repaid, sponsors reclaimed reserves, and CitePay repeated the sponsor lifecycle with a fresh controlled agent.
