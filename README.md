# Shadow

**Shadow Float is sponsor-backed USDC capacity for autonomous agents on Arc.**

Agents need paid data, compute, and APIs before they have money of their own. On Shadow Float, a sponsor reserves Arc USDC for an agent, the agent signs a bounded EIP-712 spend intent, and `ShadowFloat` verifies the signer, nonce, expiry, provider, endpoint, amount, executor, and max cumulative debt onchain before any provider payment moves.

Three things are true on this testnet right now:

1. **An autonomous desk runs the book.** An LLM-driven desk decides what to buy, its one-sentence rationale rides inside the signed intent, and the intent digest becomes the onchain `requestHash`, so every decision is cryptographically bound to its receipt. After the desk's first clean lifecycle, the contract raised the desk's own credit limit from behavior alone.
2. **Outside projects use it with their own wallets.** Ten external lines from outside builder teams, a cross-project loop where one team's agent borrowed Shadow credit to pay another team's API, and two external sponsors who put their own USDC behind agent lines. Forum Tollgate proved reserve reclaim, then reopened a live reserve for judging.
3. **Anyone can verify all of it with one command and no keys.** `npm run float:v2-verify-live` re-derives the proof loop against the public Arc RPC, 26 checks.

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
| Builder signing kit | [`examples/float-v2-signed-spend`](examples/float-v2-signed-spend) |
| Intent verifier | `GET /api/float-tools?action=verify&hash=0x...` |

Live V2 activity currently shown on the site:

| Metric | Count |
| --- | ---: |
| External lines | 10 |
| Signed intents | 12 |
| Provider paid spends | 12 |
| Closed borrow-repay lifecycles | 11 |
| Open debt lines | 1 |

The live board shows 10 external lines. Forum, CitePay, Crux, Driplet, all three Argus agents, CitePay sponsor, and Forum Tollgate sponsor have closed signed spend and repay loops. Driplet ran a fresh second provider-specific loop against CitePay before submission and repaid it. Forum Tollgate also proved sponsor reserve reclaim, then reopened a fresh reserve that remains live through judging. Argus Alpha used Float V2 to pay CitePay for a provider answer and repaid that second draw. Obol has a provider-paid V2 spend with repayment intentionally left open and labeled on the live board, so the proof carries one live, contract-capped debt line alongside the closed loops.

### Autonomous Underwriting Is Deployed

Sponsored V2 lines are re-scored by `ShadowFloat` itself. Paid, blocked, and repaid actions update `behaviorStats(agent)` and trigger the same internal refresh path that recomputes `deterministicScore`, adjusts the line cap within the sponsor reserve, and emits `DeterministicFloatScored`.

Anyone can inspect the scoring path:

```bash
cast call 0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
  "autonomousLineScore(address)(uint16,uint256,uint256)" \
  0x5c0b33b209f510868E07792Edc46c3792B0b92EC \
  --rpc-url https://rpc.testnet.arc.network
```

`refreshSponsoredLineFromBehavior(address,bytes32)` is also public, and normal spend and repay paths call the same refresh logic automatically. The Argus Alpha repay tx [`0x0f50d4...ff3699`](https://testnet.arcscan.app/tx/0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699) contains a live `DeterministicFloatScored` event. Argus Alpha reached score `9000` after two paid and two repaid actions. One external line still shows open debt until it repays. Owner scoring functions such as `grantFloatFromScore`, `reduceLimit`, and `revoke` revert on sponsored lines, so these external lines are not silently edited by the V1 owner underwriter path.

### The Desk

Float Desk is the autonomous system line that exercises the live V2 book. It reads current line state, asks an LLM to propose `PAY`, `SKIP`, `HOLD`, or `REPAY`, then clamps that proposal through hard policy before any transaction is signed. The desk can buy a tiny provider answer, repay open system debt, or skip when the spend is not useful. The chain still decides whether a signed spend is valid.

Desk activity is separate from external builder traction. It runs on its own system line `0x4355...522E`, publishes its journal at `/float#desk-journal`, and exposes the same data at `GET /api/desk`. For `PAY` actions, the EIP-712 rationale sentence is inside `FloatSpendIntent.reason`; the typed-data digest becomes the onchain `requestHash`, so the journaled rationale is bound to the receipt.

The desk line is underwritten by the contract like every sponsored line. After the desk's first paid and settled cycle, `ShadowFloat` raised the line's cap from `0.025` to `0.05` USDC on its own (score `7500` to `8250`, capped by the sponsor reserve). `GET /api/desk` returns the live line as `labLine`, or read it directly:

```bash
cast call 0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
  "autonomousLineScore(address)(uint16,uint256,uint256)" \
  0x43553CaeE153496200d37644cE28775B2b2b522E \
  --rpc-url https://rpc.testnet.arc.network
```

Useful commands:

```bash
npm run float:desk
FLOAT_DESK_LIVE=1 npm run float:desk
FLOAT_DESK_LIVE=1 npm run float:desk -- --setup-mandate
```

The setup command lets the sponsor refresh the CitePay provider mandate for the system line. Normal cycles never count toward external builder lines, external sponsor proofs, or the V2 verifier.

### External Sponsor Path

The current V2 contract also supports external sponsors. `openSponsoredLine(...)` is public: a sponsor reserves their own Arc USDC for an agent, sets the provider mandate for that line, and lets `ShadowFloat` score and cap the line from behavior.

CitePay became the first live external sponsor on Shadow Float V2. Forum Tollgate then completed the full external sponsor lifecycle: sponsor opens reserve, agent spends, agent repays, sponsor closes the line, and the full reserve returns to the sponsor. Forum later reopened a fresh 0.05 USDC reserve and left it live through judging.

| Sponsor proof | Sponsor wallet | Agent | Key tx | State |
| --- | --- | --- | --- | --- |
| CitePay live reserve | `0x5389...f105` | `0xdfDE...044f` | [`0xf2dabb...53540`](https://testnet.arcscan.app/tx/0xf2dabb1ce651330a389acd4d6cacee1a859dc4fc12f18459143dc0f60ee53540) | live reserve, repaid |
| Forum Tollgate reclaim | `0x12F2...ba03` | `0x645b...139C` | [`0xba995c...16463`](https://testnet.arcscan.app/tx/0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463) | reserve reclaimed |
| Forum Tollgate live reserve | `0x12F2...ba03` | `0x645b...139C` | [`0xc8694d...da2e6`](https://testnet.arcscan.app/tx/0xc8694da66f078d81c4199df813e8ee7b69941a14b6aef4531f6c35ca771da2e6) | reopened live reserve |

External sponsor runbook: [`docs/EXTERNAL_SPONSOR_V2.md`](docs/EXTERNAL_SPONSOR_V2.md)

External sponsor proof notes: [`docs/EXTERNAL_SPONSOR_PROOF.md`](docs/EXTERNAL_SPONSOR_PROOF.md)

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

CitePay confirmed five paid provider queries from the Shadow execution wallet on Arc testnet. Shadow also paid CitePay once through a Float V2 draw signed by Argus Alpha. CitePay served the answer and returned query ID `6e6d9c2c-b988-438a-9930-0d6d40ff78b5`. CitePay also signed a provider delivery receipt for a Driplet-paid request, and `ShadowFloat` recorded that receipt onchain.

| # | Query fee tx | Amount | Status |
| ---: | --- | ---: | --- |
| 1 | [`0x3c74ba...a9929`](https://testnet.arcscan.app/tx/0x3c74ba902d9494c7762f440affa0065ef4a2478b6e9cb4cb228e11cd689a9929) | 0.001 USDC | confirmed |
| 2 | [`0xc8ee30...3532a`](https://testnet.arcscan.app/tx/0xc8ee30e0c2ab5943f472baf819fb17af8b39571665ba4ac408b9fe8d9343532a) | 0.001 USDC | confirmed |
| 3 | [`0xb1b672...f48bd`](https://testnet.arcscan.app/tx/0xb1b6727138218b79ec829cd221db65bd4abe47b5a9b7afee8bdd42b14e1f48bd) | 0.001 USDC | confirmed |
| 4 | [`0x88ef62...adef8`](https://testnet.arcscan.app/tx/0x88ef62f2ab2b13cbea658ca9f4d26ebd38c6e86aa8e0704dd7e51a676beadef8) | 0.001 USDC | confirmed |
| 5 | [`0x85aea6...1311`](https://testnet.arcscan.app/tx/0x85aea6dfce5b589fa5a1e5526889d31ca9126385217614b42d0ad34656261311) | 0.001 USDC | confirmed |

| Provider-signed delivery | Request hash | Delivery hash | Tx |
| --- | --- | --- | --- |
| Driplet to CitePay | `0xd6cbfc...7208c8` | `0x85f1bd...a7329` | [`0x68e9bb...fd469`](https://testnet.arcscan.app/tx/0x68e9bb81fbd84496656cc9fc41907d17e3fbbbed67cf75d681933a0ac43fd469) |

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

Arc's agentic workflow lane combines identity, settlement, and programmable controls. Shadow adds the capital primitive.

| Primitive | Shadow's role |
| --- | --- |
| Identity | The line is bound to the wallet that signs the EIP-712 intent. |
| Settlement | Arc USDC is the unit of account. V2 pays providers directly from contract custody. |
| Controls | Provider, endpoint, amount, max debt, nonce, expiry, executor, reserve backing, and line policy are checked before payment. |
| Capital | Sponsors reserve capacity so agents can buy approved services before each wallet is manually topped up. |

## Arc And Circle

Shadow uses Arc USDC as the settlement asset. The historical V1 path binds x402/EIP-3009 settlement hashes into Float receipts. V2 removes the blind operator-bind gap by verifying the agent intent in the contract and paying the provider directly from reserved USDC.

Circle Gateway is documented as additive settlement plumbing over recorded Desk activity: two Desk PAY cycles totaling `0.002` USDC were settled through Gateway batching on Jul 2, 2026 and are served from `/api/settlements` under `deskRecords`. This is not the V2 provider payment path and is not counted as external traction; it shows how sub-cent Desk economics can batch through Circle tooling. Details: [`docs/GATEWAY.md`](docs/GATEWAY.md).

Circle CCTP is exercised as a live acknowledgement path: Shadow verified a Sepolia USDC burn attestation through `/api/cctp-funding` on Jul 2, 2026. This proves attestation verification, not Arc minting or Float credit. Details: [`docs/CCTP.md`](docs/CCTP.md).

Circle wallet tooling was explored for future onboarding, but it is not required for the current Float V2 spend path.

## Supporting Records And M1

The Records surface and M1 are supporting mandate paths, not the primary product surface.

The Records page shows an execution wallet using approved adapters to allocate Arc testnet USDC when a bonded enforcer returns `ALLOW`, and move zero funds when the same adapter path returns `BLOCK`. This validates the policy shape, but it is not claimed as a production treasury customer or a real Morpho deployment.

Records page: https://shadow-arc.vercel.app/records

Records API: `GET https://shadow-arc.vercel.app/api/treasury`

The Records surface is supporting context. The current judged proof path is the V2 verifier below.

Next M1 hardening:

- Move from adapter-enforced checks to custodial or escrow-release enforcement.
- Replace the test sink with a withdrawable vault integration.
- Integrate a real Morpho or vault market before using Morpho language as a production claim.
- Expand bonding from receipt liveness to correctness and settlement guarantees.

## Judge Run

No private keys are required to verify the current system.

The quickest public path is the live V2 verifier plus the two read-only APIs that back the site:

```bash
git clone https://github.com/dolepee/shadow
cd shadow
pnpm --dir app install --frozen-lockfile

npm run float:v2-verify-live
curl -s https://shadow-arc.vercel.app/api/float?mode=v2
curl -s https://shadow-arc.vercel.app/api/desk
```

`npm run float:v2-verify-live` re-derives the canonical V2 proof loop against the public Arc RPC in 26 checks with no keys: the sponsor line was opened, the agent's signed intent paid the provider from contract custody, an oversized overrun was blocked with no funds moved, debt was repaid, and the line was restored. One external line (Obol) is intentionally left open to show a live, contract-capped debt exposure; the verifier surfaces that open debt and confirms it stays within the documented `0.02` USDC bound, so the one command a judge runs stays green while the open-debt exhibit remains visible.

Full local checks before changing code:

```bash
pnpm --dir app install --frozen-lockfile
pnpm --dir agent install --frozen-lockfile

npm run contracts:test
npm run contracts:build
npm run app:typecheck
npm run app:build
npm run agent:typecheck

npm run float:v2-verify-live
curl -s https://shadow-arc.vercel.app/api/float?mode=v2
curl -s https://shadow-arc.vercel.app/api/desk
```

Additional historical checks:

```bash
npm run float:score-proof
```

Historical checks are kept for context, not as the Lepton judge path.

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
- Forkable builder signing kit for the V2 signed spend and repay flow.
- No-secret verifier for the current V2 loop.
- Historical V1 x402/EIP-3009 binding evidence, labeled separately from the current V2 product path.
- Supporting M1 mandate proof for adapter-level ALLOW/BLOCK behavior.

## What Is Not Claimed

- No production lending market.
- No real Morpho vault integration yet.
- No production treasury customer yet.
- No EVM-native judgment of subjective provider service quality. One provider-signed delivery receipt is recorded for the Driplet to CitePay request, but the standard V2 verifier still focuses on payment, debt, repayment, and block behavior.

## Project Docs

- Lepton M1 mandate notes: [`docs/LEPTON_M1.md`](docs/LEPTON_M1.md)
- Mainnet path: [`docs/MAINNET_PATH.md`](docs/MAINNET_PATH.md)
- Economics: [`docs/ECONOMICS.md`](docs/ECONOMICS.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
