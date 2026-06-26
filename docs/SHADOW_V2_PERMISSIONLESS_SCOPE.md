# Shadow V2 Permissionless Scope

Shadow V2 exists to remove the trust objections surfaced during external builder review. V1 remains useful proof that the
economic loop works, but V2 is the product we should defend as first-place-ready: authorizations are contract-enforced,
revocable, nonce-bound, and independently verifiable.

## Thesis

Shadow lets agents pay and allocate USDC on Arc under bounded, provable authority. The user or agent signs explicit
authorization; the contract enforces the signer, amount, provider, endpoint, nonce, expiry, and cancellation before funds
move.

## Non-Negotiable Guarantees

- No blind trust in Shadow's backend for signed intents.
- No reusable bearer signatures.
- No expired signature can be consumed.
- No cancelled signature can be consumed.
- No signature can be rebound to a different provider, endpoint, amount, nonce, expiry, agent, or contract.
- No request hash can open debt twice.
- No blocked action moves funds.
- No admin withdrawal can break Float reserve solvency.
- No external agent wallet can be drained by signing a Float intent.
- No M1 adapter can force a deposit from a wallet just because it has allowance.
- No "vault" wording without an exit path or a clear test-sink label.
- No "permissionless underwriting" claim unless the evidence is derived and enforceable without operator judgment.

## V1 Proof That Stays Valid

V1 receipts remain historical evidence:

- Treasury-funded x402 payments.
- Onchain debt.
- Repayment restoring capacity.
- Overspend blocks.
- Denials.
- External signed proof artifacts.
- Treasury and Float verifier output.
- Treasury/M1 pay-allocate-block spike proof.

Do not claim those V1 transactions happened on V2. Use them as migration context: "V1 proved the loop; V2 removes the trust
assumptions."

## Float V2 Requirements

### Onchain Signed Spend

Add a contract-native `FloatSpendIntent` path:

- EIP-712 domain: `ShadowFloat`, version `1`, chain id, verifying contract.
- Fields: `agent`, `provider`, `endpointHash`, `amountUSDC`, `nonce`, `expiry`, `reason`.
- Contract computes the digest.
- Contract recovers the signer or validates ERC-1271 signatures.
- Signer must equal the line wallet, or the agent address when no wallet is set.
- Contract rejects expired intents.
- Contract rejects used nonces.
- Contract rejects cancelled nonces.
- Contract marks nonce used before external token movement.
- Contract emits `FloatIntentConsumed`.

### Cancellation

- Agent signer can call `cancelIntent(agent, nonce)`.
- Cancellation emits `FloatIntentCancelled`.
- A cancelled nonce can never be consumed.
- A consumed nonce cannot be cancelled.

### Direct Spend

- `requestSignedSpend(intent, signature)` should be publicly callable.
- If allowed, it pays the provider directly from the treasury and opens debt.
- If blocked, it writes a structured block receipt and moves no funds.

### x402 Bind

- `recordSignedX402Spend(intent, x402Hash, facilitator, signature)` should verify the same signed intent onchain before
  any reimbursement.
- This path can remain operator-gated until x402 settlement can be verified onchain, because otherwise anyone could submit
  a fake settlement hash and drain treasury reimbursements.
- The operator still has to prove the x402 transfer off-chain in the script/verifier.
- The receipt must bind the EIP-712 digest as `requestHash` and the settlement tx hash as `x402Hash`.

### Tests

Required Float V2 tests:

- valid signed direct spend pays provider and opens debt;
- valid signed x402 spend reimburses facilitator and opens debt;
- wrong signer reverts;
- wrong provider/endpoint/amount signature does not verify;
- expired intent reverts;
- cancelled intent reverts;
- consumed nonce cannot replay;
- duplicate request hash cannot replay;
- signer can cancel but outsider cannot;
- ERC-1271 signer path where feasible;
- blocked signed intent moves no provider/facilitator funds;
- solvency invariant still holds;
- old V1 paths either remain explicitly legacy or are disabled for external proof claims.

## Float V2 Underwriting Requirements

Target claim: "receipt-derived, deterministic V2 line refresh," not fully permissionless credit unless every input is
chain-derived.

Required:

- Score evidence derived from `FloatReceipt` logs where possible.
- External signed count only counted when a matching signature proof and onchain bind are present.
- Repaid count derived from `REPAID` receipts.
- Blocked/denied/error counts derived from receipts.
- Onchain `deterministicScore` and off-chain verifier must match exactly.
- Autounderwrite must be reproducible from public data or clearly label any operator-submitted input.

Stretch:

- Permissionless line refresh where anyone can submit a receipt-derived evidence bundle and the contract verifies enough of
  it to grant or reduce a line. If not fully verifiable in ten days, label it "verified operator submission."

## M1 V2 Requirements

Forum found that M1 language can outrun the current enforcement model. V2 must tighten the actual mandate rail before it
becomes a lead proof.

### Authentication

- Adapter calls must bind `msg.sender` to the account/actor authorized by the mandate.
- No caller can submit an action that pulls funds from another account merely because allowance exists.
- If agent/account separation is needed, add an explicit EIP-712 mandate action signature rather than trusting caller
  fields.

### Check And Act

- Current enforcer returns allow/block and the adapter honors it. This is acceptable only for first-party audited adapters.
- Do not claim arbitrary integrators are prevented unless funds are escrowed/custodied by the enforcer or released only by
  an allow receipt.
- Product wording: "Shadow-verified adapters enforce before transfer" unless/until custody/release is built.

### Vault/Sink Safety

- Test sinks must be labeled as test sinks.
- If using "vault" language, add a withdrawal/redeem/sweep path.
- At minimum: owner/account withdrawal for recorded deposits or explicit docs that funds are intentionally parked in a test
  sink.

### Bond Scope

- Bond currently covers receipt liveness, not fund correctness.
- Wording must say "bonded receipt liveness" unless the bond can be slashed for unauthorized transfer, missing receipt, or
  policy violation.
- Stretch: extend challenge/slashing to cover adapter receipt mismatch where onchain transfer evidence contradicts the
  receipt.

### Tests

Required M1 V2 tests:

- unauthorized caller cannot force deposit;
- actor/account mismatch blocks;
- allowed deposit moves funds and writes receipt;
- blocked deposit moves zero funds;
- sink withdrawal path works or test-sink labeling is explicit;
- bond liveness slash still works;
- if EIP-712 action signatures are added, wrong signer/expiry/replay/cancel tests mirror Float V2.

## Gateway And Independent Provider

Do not bind Circle Gateway UUIDs as settlement hashes. A valid Gateway V2 milestone requires:

- an onchain settlement tx;
- a per-transfer identifier such as a TransferSpec hash when available;
- provider, amount, and recipient match;
- the resolver can prove the mapping without trusting our backend.

Until then:

- lead with Arc USDC, x402, and EIP-3009 as the live load-bearing path;
- state Gateway-batched x402 as an interoperability roadmap backed by Obol/Archer testing;
- do not claim Gateway is in the Float loop.

## External Builder Policy

- Do not ask builders to run Shadow scripts with private keys.
- Provide exact EIP-712 typed data, ABI, and verification commands.
- Let builders sign with their own tooling.
- If a builder refuses to bind a main production agent, do not pressure them.
- Burner agents are acceptable only if framed as builder-controlled test agents.
- Public acknowledgements must be quoted accurately; no "partner" language unless they explicitly say partner.

## Deployment And Migration

V2 likely requires redeploying `ShadowFloat` because signature state and nonce mappings are contract storage.

Migration stance:

- Keep V1 contract address and receipts live as historical proof.
- Deploy V2 as the current permissionless contract.
- Fund V2 treasury.
- Re-grant key lines on V2.
- Run fresh V2 proof loop: grant, signed direct spend, signed x402 bind, block, repay, cancel, replay fail.
- Site must show both:
  - V1: historical loop and external proof;
  - V2: current permissionless authorization path.

## Demo Standard

The demo must show the product moment before proof details:

1. Builder signs an intent locally.
2. Contract verifies signer/nonce/expiry onchain.
3. Shadow fronts provider payment or reimburses a verified x402 facilitator.
4. Debt opens.
5. Overspend or cancelled intent is blocked before funds move.
6. Repayment restores capacity.
7. Score/line can refresh from receipts.
8. Verifier confirms the whole path.

## Claim Boundaries

Allowed:

- "V2 verifies signed Float intents onchain."
- "Agents can cancel unused nonces."
- "Replays and expired intents fail in the contract."
- "V1 proved the economic loop; V2 removes the off-chain trust gap."
- "M1 adapters enforce policy before transfer for audited adapter paths."

Not allowed until built:

- "Fully permissionless credit underwriting."
- "Any integrator cannot bypass the enforcer."
- "Gateway settlement is bound into Float."
- "The agent runs your treasury without keys."
- "Vault yield" or "Morpho integration" unless a real market/share path exists.

## Final Acceptance

Shadow V2 is ready only when:

- contracts build;
- Float V2 tests pass;
- M1 V2 safety tests pass;
- live V2 deployment is funded;
- fresh V2 receipts exist;
- V2 verifier passes without private keys;
- website leads with V2 current proof;
- README states V1 historical proof and V2 current proof separately;
- external builders can inspect and sign without running our private-key scripts.

## Carryover From External Reviews

The useful parts of the June 26 reviews are constraints, not the final direction. They repeatedly identify the same
failure modes:

- Proof quality is Shadow's strongest asset. Do not break the no-secret verifier or hash-chained receipt story while adding
  V2.
- A judge must understand the product in one sentence and one screen. V2 should reduce the Float/Treasury/M1 naming split,
  not add another surface.
- Project-controlled economics are the biggest optics problem. V2 must make the authorization path trust-minimized even if
  early liquidity/provider activity remains testnet-small.
- External builder proof must be named and inspectable. Placeholder labels like `REPLACE_builder` are not acceptable for
  final proof surfaces.
- Current x402 provider proof is project-controlled unless an independent provider is actually paid and verified. Do not
  imply otherwise.
- Circle depth should be claimed only where load-bearing: Arc USDC, x402, EIP-3009 now; Gateway only after a real
  settlement resolver exists.
- "Agent runs your treasury without the keys" remains forbidden until the actor/account split and authorization model
  prove it. Use "signed, bounded authorization" and "verified adapters" instead.
- "Autonomous underwriting" is forbidden until evidence is derived from public receipts and line movement is reproducible
  without operator judgment.
- Amounts can stay testnet-small, but the mechanism must be real and the fee/revenue language must say "fee mechanics,"
  not traction.
- Mimir's advantage is legibility and distribution. Shadow's route to beating it is not more proof tables; it is a
  trust-minimized product moment that an outside builder can safely use and a judge can retell.

The review advice to stop coding was correct for V1 polish, but no longer matches the selected path. V2 is justified
because the trust objections are real protocol gaps, not cosmetic wording issues.
