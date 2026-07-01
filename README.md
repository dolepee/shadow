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
| Signed intents | 9 |
| Provider paid spends | 9 |
| Closed borrow-repay lifecycles | 8 |
| Open debt lines | 1 |

External V2 lines currently include Forum, CitePay, Crux, Driplet, Argus Alpha, Argus Beta, Argus Gamma, and Obol. Forum, CitePay, Crux, Driplet, and all three Argus agents have closed the full signed spend and repay loop. Argus Alpha also used Float V2 to pay CitePay for a provider answer and repaid that second draw. Obol has a provider-paid V2 spend with repayment still open and labeled that way on the live board.

### Autonomous Underwriting Is Deployed

Sponsored V2 lines are re-scored by `ShadowFloat` itself. Paid, blocked, and repaid actions update `behaviorStats(agent)` and trigger the same internal refresh path that recomputes `deterministicScore`, adjusts the line cap within the sponsor reserve, and emits `DeterministicFloatScored`.

Anyone can inspect the scoring path:

```bash
cast call 0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
  "autonomousLineScore(address)(uint16,uint256,uint256)" \
  0x5c0b33b209f510868E07792Edc46c3792B0b92EC \
  --rpc-url https://rpc.testnet.arc.network
```

`refreshSponsoredLineFromBehavior(address,bytes32)` is also public, and normal spend and repay paths call the same refresh logic automatically. The Argus Alpha repay tx [`0x0f50d4...ff3699`](https://testnet.arcscan.app/tx/0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699) contains a live `DeterministicFloatScored` event. Argus Alpha reached score `9000` after two paid and two repaid actions. Obol remains `LIMITED` with one paid action and open debt. Owner scoring functions such as `grantFloatFromScore`, `reduceLimit`, and `revoke` revert on sponsored lines, so these external lines are not silently edited by the V1 owner underwriter path.

### External Sponsor Path

The current V2 contract also supports non-operator sponsors. `openSponsoredLine(...)` is public: a sponsor reserves their own Arc USDC for an agent, sets the provider mandate for that line, and lets `ShadowFloat` score and cap the line from behavior. No public claim is made that a non-operator sponsor has completed this path until a `SponsoredLineOpened` event shows a sponsor other than `0xBDb1...1Fb8`.

External sponsor runbook: [`docs/EXTERNAL_SPONSOR_V2.md`](docs/EXTERNAL_SPONSOR_V2.md)

### Argus Three-Agent Lifecycle

Argus ran three agent lines through Shadow Float V2. Each row shows a signed V2 spend that paid the provider from sponsor reserve, then a repayment that restored the line.

| Agent | Borrow tx | Repay tx |
| --- | --- | --- |
| Argus Alpha `0x5c0b...92EC` | [`0x50831f...53aa2c`](https://testnet.arcscan.app/tx/0x50831fd00ef83a2c5fdb5bd5829ac6800c783aa34ec2149eb92c1bb38553aa2c) | [`0x4ae592...0bf896`](https://testnet.arcscan.app/tx/0x4ae5922841cb91b090e2785e26b94789a9c4028340bea5c162106657280bf896) |
| Argus Beta `0x7D4897...a817c` | [`0x03d67f...a9ba9`](https://testnet.arcscan.app/tx/0x03d67f3f911abda8e862700787f33d5ad7002e49a6fd989172dfbca5d6aa9ba9) | [`0xac1b0d...97d679`](https://testnet.arcscan.app/tx/0xac1b0d231b0d19ebcb8e18877e7fcffbb2cbf990f204f648c288053bb597d679) |
| Argus Gamma `0x43e063...50c89` | [`0x49acee...dc33e`](https://testnet.arcscan.app/tx/0x49aceee516b7eb037c9b475cdf9f238335eea9975c2102731b05826c6a0dc33e) | [`0xad8301...b1682`](https://testnet.arcscan.app/tx/0xad8301ca4edbbed18bc7204d8da9be53492116649a326728ad0ca5bc19bb1682) |

Argus Alpha then ran a second, provider-specific loop against CitePay:

| Buyer agent | Provider | Spend tx | Repay tx | CitePay query |
| --- | --- | --- | --- | --- |
| Argus Alpha `0x5c0b...92EC` | CitePay `0x5389...f105` | [`0x552c7e...dbc322`](https://testnet.arcscan.app/tx/0x552c7e32e34d9f06e03ca185f705637f9c66002d709d7d14c24d11edefdbc322) | [`0x0f50d4...ff3699`](https://testnet.arcscan.app/tx/0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699) | `6e6d9c2c-b988-438a-9930-0d6d40ff78b5` |

### CitePay Provider Proof

CitePay confirmed five paid provider queries from the Shadow operator wallet on Arc testnet. Shadow also paid CitePay once through a Float V2 draw signed by Argus Alpha. CitePay served the answer and returned query ID `6e6d9c2c-b988-438a-9930-0d6d40ff78b5`.

| # | Query fee tx | Amount | Status |
| ---: | --- | ---: | --- |
| 1 | [`0x3c74ba...a9929`](https://testnet.arcscan.app/tx/0x3c74ba902d9494c7762f440affa0065ef4a2478b6e9cb4cb228e11cd689a9929) | 0.001 USDC | confirmed |
| 2 | [`0xc8ee30...3532a`](https://testnet.arcscan.app/tx/0xc8ee30e0c2ab5943f472baf819fb17af8b39571665ba4ac408b9fe8d9343532a) | 0.001 USDC | confirmed |
| 3 | [`0xb1b672...f48bd`](https://testnet.arcscan.app/tx/0xb1b6727138218b79ec829cd221db65bd4abe47b5a9b7afee8bdd42b14e1f48bd) | 0.001 USDC | confirmed |
| 4 | [`0x88ef62...adef8`](https://testnet.arcscan.app/tx/0x88ef62f2ab2b13cbea658ca9f4d26ebd38c6e86aa8e0704dd7e51a676beadef8) | 0.001 USDC | confirmed |
| 5 | [`0x85aea6...1311`](https://testnet.arcscan.app/tx/0x85aea6dfce5b589fa5a1e5526889d31ca9126385217614b42d0ad34656261311) | 0.001 USDC | confirmed |

Provider proof notes: [`docs/CITEPAY_PROVIDER_PROOF.md`](docs/CITEPAY_PROVIDER_PROOF.md)

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

`npm run float:v2-verify-live` verifies the canonical V2 proof loop and, by default, allows up to `0.01` USDC of explicitly labeled external open debt. That keeps the Obol open-debt row visible without weakening the proof loop. For strict closed-lifecycle mode, set `FLOAT_V2_VERIFY_STRICT_CLOSED=1`.

```bash
npm run float:v2-verify-live
FLOAT_V2_VERIFY_STRICT_CLOSED=1 npm run float:v2-verify-live
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

npm run float:v2-verify-live
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
- Autonomous sponsored-line scoring from on-chain behavior stats.
- Source-matched deployed contract.
- Live external activity board.
- No-secret verifier for the current V2 loop.
- Historical V1 x402/EIP-3009 binding evidence, labeled separately from the current V2 product path.
- Supporting M1 mandate proof for adapter-level ALLOW/BLOCK behavior.

## What Is Not Claimed

- No production lending market.
- No real Morpho vault integration yet.
- No production treasury customer yet.
- No EVM-native verification of subjective provider service quality. Provider delivery receipts are implemented and tested, but the standard live V2 verification loop currently proves payment and repayment, not service quality.

## Project Docs

- Lepton M1 mandate notes: [`docs/LEPTON_M1.md`](docs/LEPTON_M1.md)
- Mainnet path: [`docs/MAINNET_PATH.md`](docs/MAINNET_PATH.md)
- Economics: [`docs/ECONOMICS.md`](docs/ECONOMICS.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
