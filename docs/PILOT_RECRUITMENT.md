# Shadow Float Self-Serve Pilot

Shadow is recruiting one external integration pair to prove repeat, unassisted use of the deployed Shadow Float V2 contract on Arc testnet.

## What the pilot proves

A sponsor reserves a small amount of Arc testnet USDC for an agent. The agent signs a bounded EIP-712 spend intent with its own wallet. ShadowFloat verifies the signature and policy, pays the named provider directly from the sponsor reserve, records debt against the agent line, and restores capacity when the debt is repaid.

The pilot succeeds when the same external agent completes three spend-and-repay cycles on different occasions, including one genuine policy block where no provider funds move.

## Participants

- **Sponsor:** controls an Arc testnet wallet with test USDC and gas, chooses the agent, provider, reserve, per-request cap, daily cap, and expiry, and opens the line.
- **Agent:** controls the exact wallet registered on the line, signs its own typed data, submits or shares the signed packet, and repays from its own wallet.
- **Provider:** controls the address named in the mandate and receives USDC only when a signed request passes contract policy.
- **Shadow:** supplies the public interface and reference scripts. Shadow does not receive participant keys, sign for the agent, or use operator-only coordination to complete a pilot cycle.

No Shadow-controlled wallet is counted as external pilot traction. Participants are described publicly as integration testers, not customers or partners, unless they independently choose a stronger label.

## Recommended test bounds

| Field | Pilot default |
| --- | ---: |
| Sponsor reserve | 0.05 USDC |
| Maximum per request | 0.01 USDC |
| Daily limit | 0.05 USDC |
| Line expiry | 7 days |
| Provider mandate expiry | 7 days |
| Intent lifetime | 24 hours |

These values are testnet defaults, not production credit terms. The contract may grant less usable capacity than the reserve because the deterministic behavior score caps the initial line.

## Unassisted flow

1. Open `https://shadow-arc.vercel.app/builders` and connect the sponsor wallet.
2. Enter the agent and provider addresses, run preflight, approve the exact reserve, and call `openSponsoredLine` on V2 at `0x20dcA96B0C487D94De885c726c956ffaF38b12C2`.
3. Switch the connected wallet to the registered agent.
4. Create and sign the bounded EIP-712 intent. The private key remains inside the agent wallet.
5. Copy the signed packet for an independent relayer or submit it through the public builder surface. `requestSignedSpend` verifies it and records either an allowed or blocked receipt.
6. After an allowed provider payment, load the agent debt and repay from the agent wallet.
7. Repeat on two later occasions. On one attempt, intentionally exceed an agreed policy bound so the contract records a block with no provider transfer.
8. After debt is zero, the sponsor may close the line and reclaim the remaining reserve through `closeSponsoredLine`.

Reference paths remain available for non-browser agents:

- Sponsor line: `npm run float:v2-sponsor-line`
- Typed-data builder: `/api/float-tools?action=intent&agent=0x...&reason=...`
- Local agent signer: `node app/scripts/float-builder-sign.mjs`
- Independent repayment: `node app/scripts/float-builder-repay.mjs`
- Public line state: `/api/float-tools?action=agent&address=0x...`
- Signed-intent proof: `/api/float-tools?action=verify&hash=0x...`

## Public evidence

Each cycle records the participant roles, transaction hashes, signed request hash, provider amount, debt before and after, repayment, and contract score refresh. The public activity board keeps agent ownership separate from sponsor provenance. Returning pilot counters include only verified externally sponsored lines and therefore remain `0` until an unassisted participant repeats.

The pilot target is:

- first sponsored line opened in under 10 minutes;
- three repeat signed spend-and-repay cycles;
- one real policy block with no provider transfer;
- 100% repayment across completed pilot spends;
- reserve reclaim after all debt is cleared;
- no private keys, staged volume, or Shadow-controlled wallet counted as external use.

## Safety boundary

This is an Arc testnet integration pilot. Use only testnet funds. Verify the contract address, provider address, endpoint hash, amounts, expiry, and connected wallet before every signature or transaction. An EIP-712 signature authorizes only the provider, endpoint, amount, cumulative debt ceiling, nonce, expiry, and optional executor shown in the wallet prompt.
