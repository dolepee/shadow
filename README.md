# Shadow

**Shadow Float is sponsor-backed USDC capacity for autonomous agents on Arc.**

Agents need paid data, compute, APIs, and services, but pre-funding every agent wallet is hard to manage. Shadow lets a sponsor reserve Arc USDC for a specific agent. The agent signs a bounded EIP-712 spend intent. `ShadowFloat` verifies the signer, nonce, expiry, provider, endpoint, amount, executor, and max cumulative debt onchain before any provider payment moves.

Live app: https://shadow-arc.vercel.app

Current Float page: https://shadow-arc.vercel.app/float

Repository: https://github.com/dolepee/shadow

Chain: Arc Testnet, chain id `5042002`

## Current Float V2

| Item | Value |
| --- | --- |
| Contract | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Source match | https://sourcify.dev/server/v2/contract/5042002/0x20dcA96B0C487D94De885c726c956ffaF38b12C2 |
| Live activity API | `GET https://shadow-arc.vercel.app/api/float?mode=v2` |
| Local verifier | `npm run float:v2-verify-live` |
| Builder intent endpoint | `GET /api/float-tools?action=intent&agent=0x...&reason=...` |
| Intent verifier | `GET /api/float-tools?action=verify&hash=0x...` |

Live V2 activity currently shown on the site:

| Metric | Count |
| --- | ---: |
| External lines | 8 |
| Signed intents | 7 |
| Provider paid spends | 7 |
| Closed borrow-repay lifecycles | 6 |
| Open debt lines | 1 |

External V2 lines currently include Forum, CitePay, Crux, Argus Alpha, Argus Beta, Argus Gamma, Obol, and Driplet. Forum, CitePay, Crux, and all three Argus agents have closed the full signed spend and repay loop. Obol has a provider-paid V2 spend with repayment still open and labeled that way on the live board. Driplet is registered and ready.

## How Float Works

1. A sponsor opens a small reserve-backed line for an agent.
2. The agent signs a `FloatSpendIntent` locally. No private key is shared with Shadow, and the spend intent does not require gas or token approval from the signer.
3. `requestSignedSpend` verifies the intent onchain.
4. If the request is inside policy, `ShadowFloat` pays the named provider directly from sponsor reserve.
5. Debt opens against the agent line.
6. Repayment clears debt and restores available capacity.
7. Oversized requests are recorded and blocked before provider funds move.

The V2 contract enforces the signed intent path directly. Older V1 receipts remain historical evidence for x402/EIP-3009 binding and the first external signed usage, but the current product path is Float V2 direct provider payment from sponsor-backed custody.

## Why It Matters

Arc's agentic workflow lane combines identity, settlement, and programmable controls. Shadow adds the capital layer.

| Layer | Shadow's role |
| --- | --- |
| Identity | The line is bound to the wallet that signs the EIP-712 intent. |
| Settlement | Arc USDC is the unit of account. V2 pays providers directly from contract custody. |
| Controls | Provider, endpoint, amount, max debt, nonce, expiry, executor, reserve backing, and line policy are checked before payment. |
| Capital | Sponsors reserve capacity so agents can buy approved services before each wallet is manually topped up. |

## Arc And Circle

Shadow uses Arc USDC as the settlement asset. The historical V1 path binds x402/EIP-3009 settlement hashes into Float receipts. V2 removes the blind operator-bind gap by verifying the agent intent in the contract and paying the provider directly from reserved USDC.

Circle Gateway remains roadmap. Shadow has paid an independent Gateway-batched Arc x402 seller in lab, but per-transfer onchain settlement binding into Float receipts needs a resolver that maps a specific Gateway transfer to its onchain settlement and bindable `bytes32`.

Circle Modular Wallets and Gas Station were demonstrated for passkey-based onboarding. They are useful for future agent onboarding, but they are not required for the current Float V2 spend path.

## Treasury And M1

Shadow Treasury and M1 are supporting mandate rails, not the primary product surface.

The Treasury page shows an operator using approved adapters to allocate Arc testnet USDC when a bonded enforcer returns `ALLOW`, and move zero funds when the same adapter path returns `BLOCK`. This validates the policy shape, but it is not claimed as a production treasury customer or a real Morpho deployment.

Treasury page: https://shadow-arc.vercel.app/treasury

Treasury API: `GET https://shadow-arc.vercel.app/api/treasury`

Treasury verifier: `npm run treasury:verify-live`

Post-hackathon M1 hardening:

- Move from adapter-enforced checks to custodial or escrow-release enforcement.
- Replace the test sink with a withdrawable vault integration.
- Integrate a real Morpho or vault market before using Morpho language as a production claim.
- Expand bonding from receipt liveness to correctness and settlement guarantees.

## Verification

No private keys are required to verify the current system.

`npm run float:v2-verify-live` is strict by default: it exits nonzero if any external V2 debt remains open. If a reviewer wants to inspect the canonical V2 proof loop while an explicitly labeled external lifecycle is still open, set a matching threshold:

```bash
FLOAT_V2_VERIFY_MAX_OPEN_DEBT_ATOMIC=10000 npm run float:v2-verify-live
```

Full local checks:

```bash
git clone https://github.com/dolepee/shadow
cd shadow
pnpm --dir app install --frozen-lockfile
pnpm --dir agent install --frozen-lockfile

npm run contracts:test
npm run contracts:build
npm run app:typecheck
npm run app:build
npm run agent:typecheck

FLOAT_V2_VERIFY_MAX_OPEN_DEBT_ATOMIC=10000 npm run float:v2-verify-live
curl -s https://shadow-arc.vercel.app/api/float?mode=v2
curl -s https://shadow-arc.vercel.app/api/treasury
npm run treasury:verify-live
```

Additional historical checks:

```bash
npm run float:verify-live
npm run float:score-proof
```

## Contract Surface

| Component | Address |
| --- | --- |
| ShadowFloat V2 | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Historical ShadowFloat V1 | `0xf305647ba0ff7f1e2d4be5f37f2ef9f930531057` |
| Arc USDC | `0x3600000000000000000000000000000000000000` |

Supporting M1 contracts are documented in [`docs/LEPTON_M1.md`](docs/LEPTON_M1.md).

## What Is Shipped

- Sponsor-funded Float V2 lines.
- Contract-enforced EIP-712 signed spends.
- Direct provider payment from sponsor reserve.
- Debt opening, repayment, and restored capacity.
- Blocked overrun path with no provider transfer.
- Source-matched deployed contract.
- Live external activity board.
- No-secret verifier for the current V2 loop.
- Historical V1 x402/EIP-3009 binding evidence.
- Supporting M1 mandate proof for adapter-level ALLOW/BLOCK behavior.

## What Is Not Claimed

- No production lending market.
- No real Morpho vault integration yet.
- No production treasury customer yet.
- No autonomous ownerless underwriting yet. Receipt-derived scoring exists, but applying line updates remains owner/operator-controlled.
- No EVM-native verification of subjective provider service quality. Provider delivery receipts are implemented and tested, but the standard live V2 verification loop currently proves payment and repayment, not service quality.

## Project Docs

- Lepton M1 mandate notes: [`docs/LEPTON_M1.md`](docs/LEPTON_M1.md)
- Mainnet path: [`docs/MAINNET_PATH.md`](docs/MAINNET_PATH.md)
- Economics: [`docs/ECONOMICS.md`](docs/ECONOMICS.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
