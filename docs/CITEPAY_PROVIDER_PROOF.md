# CitePay Provider Proof

This is the confirmed cross-project provider proof between Shadow and CitePay on Arc testnet.

Shadow paid CitePay through CitePay's DirectTransfer flow. CitePay confirmed that all five payments were received, scored, answered, and tied to receipt trails with creator payouts.

This is not framed as a partnership. It is a verified provider flow that both projects can cite.

## Participants

| Role | Address |
| --- | --- |
| Shadow operator wallet | `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8` |
| CitePay recipient wallet | `0x5389688243328c26a92b301faEEAb5fbf9AFf105` |
| Arc USDC token | `0x3600000000000000000000000000000000000000` |

## Query Fee Transactions

Each row is a `0.001` USDC DirectTransfer payment from Shadow to CitePay before calling `POST https://citepay-markets.vercel.app/api/ask` with the confirmed tx hash in `X-Arc-Tx-Hash`.

| # | Tx | Block | Amount | Status |
| ---: | --- | ---: | ---: | --- |
| 1 | [`0x3c74ba902d9494c7762f440affa0065ef4a2478b6e9cb4cb228e11cd689a9929`](https://testnet.arcscan.app/tx/0x3c74ba902d9494c7762f440affa0065ef4a2478b6e9cb4cb228e11cd689a9929) | 49317407 | 0.001 USDC | confirmed |
| 2 | [`0xc8ee30e0c2ab5943f472baf819fb17af8b39571665ba4ac408b9fe8d9343532a`](https://testnet.arcscan.app/tx/0xc8ee30e0c2ab5943f472baf819fb17af8b39571665ba4ac408b9fe8d9343532a) | 49317640 | 0.001 USDC | confirmed |
| 3 | [`0xb1b6727138218b79ec829cd221db65bd4abe47b5a9b7afee8bdd42b14e1f48bd`](https://testnet.arcscan.app/tx/0xb1b6727138218b79ec829cd221db65bd4abe47b5a9b7afee8bdd42b14e1f48bd) | 49317729 | 0.001 USDC | confirmed |
| 4 | [`0x88ef62f2ab2b13cbea658ca9f4d26ebd38c6e86aa8e0704dd7e51a676beadef8`](https://testnet.arcscan.app/tx/0x88ef62f2ab2b13cbea658ca9f4d26ebd38c6e86aa8e0704dd7e51a676beadef8) | 49317818 | 0.001 USDC | confirmed |
| 5 | [`0x85aea6dfce5b589fa5a1e5526889d31ca9126385217614b42d0ad34656261311`](https://testnet.arcscan.app/tx/0x85aea6dfce5b589fa5a1e5526889d31ca9126385217614b42d0ad34656261311) | 49317933 | 0.001 USDC | confirmed |

## CitePay Confirmation

CitePay confirmed:

1. All five query fee transfers matched the Shadow sender, CitePay recipient, Arc USDC token, and `1000` micro-USDC amount.
2. All five queries were received, scored, and answered through CitePay's DirectTransfer flow.
3. Creator payouts were triggered per query.
4. Receipt trails are anchored through `CitePayMarket.sol` and publicly verifiable on ArcScan.

## Why It Matters

Shadow already proves external buyer-agent usage through V2 signed spend and repay loops. This provider proof adds the other side of the market: Shadow can pay an independent provider service and receive a confirmed answer and receipt trail.

The combined story is:

1. External agents sign V2 spend intents.
2. ShadowFloat verifies the intents and pays providers from sponsor reserve.
3. External agents repay and restore capacity.
4. Shadow can also pay an independent provider through CitePay's DirectTransfer flow.
5. Every payment and receipt is independently checkable from Arc testnet transactions.
