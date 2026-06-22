# Shadow Float: external agent onboarding

This guide explains what Shadow Float is, what we are asking you to do, and exactly how to do it. It is written so your agent can read it and walk you through the steps. The whole thing takes one signed message from you. No gas, no USDC, no transaction on your side.

---

## 1. What Shadow Float is

Shadow Float gives an autonomous agent a behavior backed USDC spending line on Arc testnet. The idea: your agent can spend credit it never pre-funded. Shadow's treasury fronts the USDC to the provider, debt opens on your line, and you repay whenever you like. Verified onchain behavior earns and keeps the line.

You already have a line. It is a credit allowance recorded on the ShadowFloat contract, not money sitting in your wallet. Your wallet holds nothing and needs nothing.

## 2. What we are asking you to do

One step: your agent signs a spend intent locally, and you send us the signed JSON. That is the whole ask.

- You sign an EIP-712 `FloatSpendIntent` with your agent key. This is an offline signature, not a transaction.
- You send us the printed JSON.
- Shadow verifies the signature is yours, fronts the x402 payment, and records the spend with your signed intent bound onchain.
- Anyone, including the judges, can then verify the spend was authorized by your agent.

## 3. Why it is done this way

This is the honest version of "an external agent used Float." Your signature proves the action came from you, and it is cryptographically verifiable by anyone. Shadow fronts the money and submits the settlement, which is exactly what the product does, an agent spends before it is funded. You stay in control because nothing happens without your signature, and no one can fake your participation because the signature recovers to your address.

## 4. Prerequisites

- Node 20 or newer.
- The Shadow repo (qdee will share access or send you the one script) plus `viem` installed (`npm install viem`, or it is already a dependency if you cloned the repo).
- Your agent wallet's private key, the address qdee registered, which already has the line. It stays on your machine and is only used to sign locally.
- Nothing else. No Arc gas, no USDC.

## 5. Step by step

### Step 1: sign the intent

Run this on your machine, from the Shadow repo root:

```bash
BUILDER_PRIVATE_KEY=0xYOUR_AGENT_KEY \
RATIONALE="one true sentence: what your agent would actually use a paid data call for" \
node app/scripts/float-builder-sign.mjs
```

`RATIONALE` should be your real use case in one sentence, for example "my research agent buys a market snapshot before it decides to trade." It becomes the onchain reason for the spend, so keep it true.

No transaction is sent and no funds move. The script prints a JSON block that looks like this:

```json
{
  "intent": {
    "agent": "0xYourAgent",
    "provider": "0x8ddf06fE8985988d3e0883F945E891BD57084937",
    "endpointHash": "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160",
    "amountUSDC": "10000",
    "nonce": "1750000000000",
    "expiry": "1750600000",
    "reason": "your sentence",
    "float": "0x5d64750e199bb27Cb03C3C523A630a3dB215435b",
    "chainId": 5042002
  },
  "signature": "0x...",
  "digest": "0x..."
}
```

### Step 2: send us the JSON

Copy the entire JSON block above and send it to qdee. That is all you need to do.

### Step 3: Shadow executes (our side, for transparency)

We save your JSON and run our operator script. It:

1. Recovers the signer from your signature and confirms it equals your agent address. If it does not match, we refuse.
2. Checks the intent has not expired.
3. Fronts the x402 payment from Shadow's facilitator to the provider.
4. Calls `recordX402Spend` with `requestHash` set to the exact EIP-712 digest you signed, so the onchain receipt commits to your intent. The same digest can only be spent once, which prevents replay.

### Step 4: verify it yourself

Once it lands, take the `requestHash` (the digest from your JSON) and open:

```
https://shadow-arc.vercel.app/api/float-verify?hash=YOUR_REQUEST_HASH
```

It returns your intent, your signature, the recovered signer, and two booleans:

- `signerMatchesAgent`: the signature recovers to your agent address.
- `digestMatchesRequestHash`: the intent hashes to the requestHash bound onchain.

Both true means the spend was authorized by your agent and nothing was altered. You can also recompute this yourself with `recoverTypedDataAddress` and `hashTypedData` from viem using the types in section 7.

### Step 5: cite it

You will appear as a real external agent on the public board:

```
https://shadow-arc.vercel.app/float
```

In your own Lepton update, mention your agent ran on a Shadow Float line and link the verify URL or the receipt. That cross mention is the part that helps both of us.

## 6. Optional extras

### Push the spend yourself instead of signing

If you would rather be the literal onchain sender, you can call the contract directly. This needs a little Arc gas and is a direct treasury fronted spend, not x402 bound:

```bash
BUILDER_PRIVATE_KEY=0xYOUR_AGENT_KEY \
RATIONALE="one true sentence" \
node app/scripts/float-builder-spend.mjs
```

### Repay your line

Close the borrow, spend, repay loop from your own wallet:

```bash
BUILDER_PRIVATE_KEY=0xYOUR_AGENT_KEY node app/scripts/float-builder-repay.mjs
```

This one needs the small debt amount in testnet USDC plus a little gas. Ping qdee if you need either.

## 7. Reference (for your agent)

If your agent wants to build or verify the intent itself instead of running our script, here is everything it needs.

Network and addresses (Arc testnet):

- chainId: `5042002`
- RPC: `https://rpc.testnet.arc.network`
- ShadowFloat: `0x5d64750e199bb27Cb03C3C523A630a3dB215435b`
- USDC: `0x3600000000000000000000000000000000000000`
- Provider (payTo): `0x8ddf06fE8985988d3e0883F945E891BD57084937`
- endpointHash: `0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160`
- Default amount: `10000` (0.01 USDC, 6 decimals). Your line limit is 0.05 USDC, so keep amounts under that.

EIP-712 typed data:

```
domain = {
  name: "ShadowFloat",
  version: "1",
  chainId: 5042002,
  verifyingContract: 0x5d64750e199bb27Cb03C3C523A630a3dB215435b
}

FloatSpendIntent = {
  agent:        address   // your agent wallet
  provider:     address   // the provider above
  endpointHash: bytes32   // the endpointHash above
  amountUSDC:   uint256    // <= your available credit and the per-request cap
  nonce:        uint256    // any unique value, e.g. a timestamp
  expiry:       uint256    // unix seconds; reject if now > expiry
  reason:       string     // your true one-line use case
}
```

The `requestHash` bound onchain equals `hashTypedData(domain, FloatSpendIntent, message)`. Verification is `recoverTypedDataAddress(...) == agent` and `hashTypedData(...) == requestHash`.

## 8. FAQ

- Do I need gas or USDC? No, not for the signed path. Your agent only signs. Shadow fronts everything. Gas and a tiny USDC amount are only needed if you choose the optional self-push or repay steps.
- Is my key safe? Yes. It stays on your machine and is only used to produce a local signature. No script here sends your key anywhere.
- What is a line? A credit allowance recorded on the contract for your agent. It is not funds in your wallet.
- What if the spend is blocked? Your line must be ELIGIBLE and the amount within your 0.05 USDC limit. If it blocks, lower the amount or ping qdee to check your line.
- Can my agent automate this fully? Yes. Use the types in section 7 to sign intents programmatically and the verify endpoint to confirm them.

That is the whole flow. One signed message from you, and the rest is on us.
