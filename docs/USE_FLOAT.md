# Use Shadow Float as an external agent

Shadow Float gives an autonomous agent a behavior-backed USDC spending line on Arc. Your agent spends credit it never pre-funded: Shadow fronts the USDC to the x402 provider, debt opens on your line, and you repay whenever you like. Verified onchain behavior earns and keeps the line.

This guide is for builders whose agent already has a line. You authorize the spend with your own key, so the action is provably yours, even though Shadow fronts the money and submits the settlement.

## Primary path: signed x402 spend

This is the real product. Your agent signs a spend intent, Shadow fronts the x402 payment, and your signed intent is bound to the onchain receipt so anyone can verify the spend came from you.

You need: your registered agent wallet's key, and nothing else. No gas, no USDC, no transaction from you.

1. Sign the intent locally:

```bash
BUILDER_PRIVATE_KEY=0xyourkey \
RATIONALE="one true sentence: what your agent actually uses the paid call for" \
node app/scripts/float-builder-sign.mjs
```

It prints a JSON `{ intent, signature, digest }`. No transaction is sent and no funds move. Your key never leaves your machine.

2. Send that JSON to qdee. Shadow then:
   - verifies the signature recovers to your agent wallet,
   - fronts the x402 payment to the provider,
   - records the spend with `requestHash` set to the exact EIP-712 digest you signed.

3. Verify it yourself or hand the link to anyone:

```
https://shadow-arc.vercel.app/api/float-verify?hash=<requestHash>
```

It returns your intent and signature, recovers the signer, and confirms `signerMatchesAgent` and `digestMatchesRequestHash`. Both true means you authorized that exact spend.

4. Cite the receipt in your own Lepton update. Your agent ran on a Shadow Float line, here is the verifiable spend.

## Fallback: push the spend yourself

If you would rather be the literal onchain sender instead of signing, call the contract directly. This needs a little Arc gas and is a direct treasury-fronted spend, not x402-bound.

```bash
BUILDER_PRIVATE_KEY=0xyourkey \
RATIONALE="one true sentence" \
node app/scripts/float-builder-spend.mjs
```

Your wallet calls `requestSpend`, the treasury fronts the USDC, debt opens, and the tx `from` is you.

## Repay (optional, either path)

Close the borrow-spend-repay loop from your own wallet:

```bash
BUILDER_PRIVATE_KEY=0xyourkey node app/scripts/float-builder-repay.mjs
```

You need the small debt amount in testnet USDC plus a little gas (ping qdee if you need either).

## Why this shape

The signed x402 path is the actual Float product: an agent spends before it is funded, Shadow fronts via x402, and the agent's signed intent proves authorship. Shadow submits the transaction (that is what a facilitator does), and the binding is honest because `requestHash` is the digest you signed, so anyone recovers your signature and confirms it. The fallback `requestSpend` path trades x402 for being the literal sender, which is simpler but routes around the product.
