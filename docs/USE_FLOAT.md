# Use Shadow Float as an external agent

Shadow Float gives an autonomous agent a behavior-backed USDC spending line on Arc. Your agent spends credit it never pre-funded: the Float treasury fronts the USDC to the provider, debt opens on your line, and you repay whenever you like. Verified onchain behavior earns and keeps the line.

This guide is for builders whose agent already has a line. You will push the spend yourself, so onchain the transaction `from` is your wallet, not Shadow. Anyone can verify that.

## What you need

- The agent wallet you registered (the address whose line is live). The spend must be sent from this exact wallet.
- A little Arc testnet native gas to send one transaction. You do NOT need any USDC: the treasury fronts the spend. If your wallet has no gas, ping qdee for a dust top-up.
- Node and `viem` (already a dependency of this repo).

## Run it

```bash
BUILDER_PRIVATE_KEY=0xyourkey \
RATIONALE="one true sentence: what your agent actually uses the paid call for" \
node app/scripts/float-builder-spend.mjs
```

Your private key stays on your machine and is never shared. The script:

1. Builds a `requestHash` that commits to your `RATIONALE` (the preimage is printed so anyone can re-hash and confirm your real reason).
2. Previews the spend so a bad setup fails before any transaction.
3. Sends `requestSpend` from your wallet. The treasury pays the provider, debt opens on your line.
4. Prints your transaction hash, the arcscan link, the `requestHash`, and the preimage.

## What you get

- An onchain spend whose sender is your wallet, on your Float line. Real third-party usage, not a demo.
- A receipt and a re-hashable rationale you can point to.
- A row as an external agent on the public board at https://shadow-arc.vercel.app/float

## After

- Cite your transaction in your own Lepton update: your agent ran on a Shadow Float line, here is the receipt. That cross mention is the part that helps both of us.
- Optional: repay your line from your wallet whenever you want. `repay(agent, amountUSDC, requestHash)` is open to anyone, so it is one more transaction straight from you, with your signature on it.

## Why this shape

`requestSpend` is the path your own wallet is authorized to call, so you are the verifiable sender. It is a direct treasury-fronted Float spend, which is the credit mechanic, not the x402 HTTP binding (that path is operator-only by design). The x402 settlement mechanism is proven separately by Shadow's own lab agent. Here, you are proving the thing that matters most: a real external agent using a Float line, pushed by its own key.
