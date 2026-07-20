# CitePay Provider Proof

This is the confirmed cross-project provider proof between Shadow and CitePay on Arc testnet.

Shadow paid CitePay through CitePay's DirectTransfer flow. CitePay confirmed that all five operator-paid queries were received, scored, answered, and tied to receipt trails with creator payouts.

Shadow also closed a stronger Float-funded provider loop: Argus Alpha signed a V2 `FloatSpendIntent`, `ShadowFloat` paid CitePay directly from sponsor reserve, CitePay accepted the tx hash as payment for `/api/ask`, and Argus Alpha repaid the line.

Shadow later closed a separate Clear-gated cycle on CitePay's own externally sponsored line. CitePay Clear verified the exact citation quote and persisted an un-settled clearance bound to the Float request hash before `ShadowFloat` paid the provider. CitePay's controlled agent then repaid the line itself. This cycle did not call `/api/ask` or `settle_clearance`; it proves the pre-payment gate and Float accounting path without adding a second payout leg.

Shadow then recorded the delivery side of a later Float-funded request: Driplet paid CitePay through Shadow Float V2, CitePay signed a `ProviderDeliveryReceipt` for that exact request hash, and `ShadowFloat` stored the delivery hash onchain.

This is framed as a verified provider flow that both projects can cite.

## Participants

| Role | Address |
| --- | --- |
| Shadow operator wallet | `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8` |
| ShadowFloat V2 | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Argus Alpha buyer agent | `0x5c0b33b209f510868E07792Edc46c3792B0b92EC` |
| Driplet buyer agent | `0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf` |
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

## Float-Funded CitePay Query

This row is the provider proof tied directly to Shadow Float V2. The buyer was Argus Alpha. The provider was CitePay. The spend was paid by `ShadowFloat` from sponsor reserve, not from the buyer wallet. The line was then repaid by Argus Alpha.

| Step | Tx / ID | Amount | Status |
| --- | --- | ---: | --- |
| Float spend to CitePay | [`0x552c7e32e34d9f06e03ca185f705637f9c66002d709d7d14c24d11edefdbc322`](https://testnet.arcscan.app/tx/0x552c7e32e34d9f06e03ca185f705637f9c66002d709d7d14c24d11edefdbc322) | 0.001 USDC | provider paid |
| CitePay query | `6e6d9c2c-b988-438a-9930-0d6d40ff78b5` | 0.001 USDC query fee | accepted |
| Argus repayment | [`0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699`](https://testnet.arcscan.app/tx/0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699) | 0.001 USDC | repaid |

## Provider-Signed Delivery Receipt

This row proves a provider signed for delivery after being paid through Shadow Float V2. The buyer was Driplet. The provider was CitePay. The recorded delivery hash equals the provider-signed EIP-712 digest.

| Field | Value |
| --- | --- |
| Buyer agent | `0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf` |
| Provider | `0x5389688243328c26a92b301faEEAb5fbf9AFf105` |
| Request hash | `0xd6cbfc4056f41fd4436f9c547a9d973d4dd6aa43923ba4d47da7f150e57208c8` |
| Delivery hash | `0x85f1bdda605cf08c5b4a4f9938aacf25f64782d64906971f16257fab8fda7329` |
| `recordProviderDelivery` tx | [`0x68e9bb81fbd84496656cc9fc41907d17e3fbbbed67cf75d681933a0ac43fd469`](https://testnet.arcscan.app/tx/0x68e9bb81fbd84496656cc9fc41907d17e3fbbbed67cf75d681933a0ac43fd469) |

## CitePay Confirmation

CitePay confirmed:

1. All five operator query fee transfers matched the Shadow sender, CitePay recipient, Arc USDC token, and `1000` micro-USDC amount.
2. All five operator queries were received, scored, and answered through CitePay's DirectTransfer flow.
3. Creator payouts were triggered per query.
4. Receipt trails are anchored through `CitePayMarket.sol` and publicly verifiable on ArcScan.
5. The Argus Alpha query fee tx `0x552c7e32e34d9f06e03ca185f705637f9c66002d709d7d14c24d11edefdbc322` was accepted by CitePay and returned query ID `6e6d9c2c-b988-438a-9930-0d6d40ff78b5`.
6. The Driplet request hash `0xd6cbfc4056f41fd4436f9c547a9d973d4dd6aa43923ba4d47da7f150e57208c8` has a provider-signed delivery receipt recorded on `ShadowFloat`.

## Why It Matters

Shadow already proves external buyer-agent usage through V2 signed spend and repay loops. This provider proof adds the other side of the market: Shadow can pay an independent provider service and receive a confirmed answer and receipt trail.

The combined story is:

1. External agents sign V2 spend intents.
2. ShadowFloat verifies the intents and pays providers from sponsor reserve.
3. External agents repay and restore capacity.
4. Shadow can also pay an independent provider through CitePay's DirectTransfer flow.
5. An external buyer agent can use Float V2 to pay that independent provider and then repay the line.
6. A provider can sign a delivery receipt for the exact paid request, and `ShadowFloat` stores that receipt onchain.
7. Every payment and receipt is independently checkable from Arc testnet transactions.

## Clear-Gated Externally Sponsored Cycle

| Step | Evidence | Result |
| --- | --- | --- |
| Exact-quote clearance | `clr_fc7aa568fde6640b99f4e8ad1425d54c` | `CLEARED`, persisted, `settlement: null` |
| Signed Float request | `0xc5ec357843228cf3cef338016f35938734c6ab6b0602035449f575bb6bee591a` | nonce consumed once |
| Provider payment | [`0x74c1fa...57927`](https://testnet.arcscan.app/tx/0x74c1fa0782dd8c70586bd8a87cb014a1bda6080df794250766720d527fe57927) | `0.001 USDC` from `ShadowFloat` to CitePay |
| Agent repayment | [`0x1e0279...527f`](https://testnet.arcscan.app/tx/0x1e0279903aba3e728385825e983bc840f9db804142e6314662df33afec54527f) | `0.001 USDC`, signed by the controlled agent |
| Final line state | Arc testnet contract read | debt `0`, available capacity `0.05 USDC`, score `9000` |
