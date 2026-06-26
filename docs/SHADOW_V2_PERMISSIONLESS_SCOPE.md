# Shadow V2 Permissionless Scope

Shadow V2 exists to remove the trust objections surfaced during external builder review. V1 remains useful proof that the
economic loop works, but V2 is the product we should defend as first-place-ready: authorizations are contract-enforced,
revocable, nonce-bound, and independently verifiable.

## Thesis

Shadow lets agents pay and allocate USDC on Arc under bounded, provable authority. The user or agent signs explicit
authorization; the contract enforces the signer, amount, provider, endpoint, nonce, expiry, optional executor, and
cancellation before funds move.

The V2 Float product is sponsor-funded by default: a sponsor deposits the reserve for a specific agent line and sets the
allowed provider policy for that line. The sponsor can cleanly close after full repayment, or default an unrepaid line and
recover only the reserve remainder after bad debt is written off. This is not permissionless unsecured underwriting; it is
permissionless creation of reserve-backed, contract-enforced spending lines whose capacity is refreshed from
contract-stored behavior.

## Non-Negotiable Guarantees

- No blind trust in Shadow's backend for signed intents.
- No reusable bearer signatures.
- No expired signature can be consumed.
- No cancelled signature can be consumed.
- No signature can be rebound to a different provider, endpoint, amount, nonce, expiry, executor, agent, or contract.
- No request hash can open debt twice.
- No blocked action moves funds.
- No admin withdrawal can break Float reserve solvency.
- No admin withdrawal can drain sponsor reserve that has not been returned through `closeSponsoredLine`.
- No owner action can silently reduce, revoke, or deny a sponsor-funded line.
- Owner-triggered sponsored default is limited to lines with active bad debt, emits `SponsoredLineDefaulted`, writes off
  only that debt, and can return any residual reserve only to the sponsor.
- No sponsored line can use the owner's global provider policy; the sponsor's line-specific provider mandate is enforced.
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

Implemented contract-native `FloatSpendIntent` path:

- EIP-712 domain: `ShadowFloat`, version `1`, chain id, verifying contract.
- Fields: `agent`, `provider`, `endpointHash`, `amountUSDC`, `maxDebtUSDC`, `nonce`, `expiry`, `executor`, `reason`.
- If `executor == address(0)`, any caller can submit the signed intent once.
- If `executor != address(0)`, only that executor can submit it.
- Contract computes the digest.
- Contract recovers the signer or validates ERC-1271 signatures.
- Signer must equal the line wallet, or the agent address when no wallet is set.
- Contract rejects expired intents.
- Contract rejects used nonces.
- Contract rejects cancelled nonces.
- Contract rejects restricted intents submitted by the wrong executor.
- Contract rejects any spend where existing active debt plus provider amount plus current fee exceeds the signed `maxDebtUSDC`.
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

This is the V2 hero path because settlement truth is enforced by the contract itself: Arc USDC moves directly from
`ShadowFloat` to the provider named in the signed intent. x402 service delivery can still be handled offchain by the
provider, but the money movement no longer depends on a backend-attested prior settlement.

### Provider-Signed Delivery Receipts

Implemented for V2 direct spends:

- `ProviderDeliveryReceipt` is an EIP-712 typed receipt signed by the provider.
- Fields: `requestHash`, `agent`, `provider`, `endpointHash`, `amountUSDC`, `responseHash`, `deliveredAt`.
- `recordProviderDelivery(...)` verifies the provider signature onchain.
- A delivery receipt can only be recorded for a request that already produced a paid spend commitment.
- Blocked or unknown requests cannot receive delivery receipts.
- Mismatched agent, provider, endpoint, or amount is rejected.
- A request can receive only one provider delivery receipt.
- The receipt binds the provider to a response hash for that exact paid request.

This does not make the EVM judge service quality. It gives the proof path a provider-signed acknowledgement that the
specific paid request was serviced, without letting anyone attach a delivery claim to an unpaid or blocked request.

### Sponsor-Funded Lines

Implemented V2 sponsor path:

- `openSponsoredLine(...)` is public and requires the sponsor to deposit the line reserve into `ShadowFloat`.
- The sponsored agent must be its own signing wallet.
- The sponsor sets the first line-specific provider mandate in the same call.
- The sponsor does not supply a score or label; V2 sponsored lines start from the fixed external-agent baseline.
- The contract computes the starting score and credit limit from stored behavior stats.
- `setSponsoredProviderMandate(...)` lets only the sponsor update provider policy for that line.
- Sponsored lines ignore owner-global provider mandates.
- `closeSponsoredLine(...)` lets only the sponsor withdraw the full reserve, and only when active debt is zero.
- `defaultSponsoredLine(...)` lets the sponsor write off unrepaid sponsored debt and recover only reserve minus active debt.
- Owner grant, deny, reduce, revoke, and legacy `markDefault` actions reject sponsored lines. Owner-triggered
  `defaultSponsoredLine(...)` is a bad-debt cleanup path only; it can return the reserve remainder only to the sponsor.
- Existing owner-funded V1 lines remain supported as historical/current operator-managed proof.

### Autonomous Sponsored-Line Refresh

Implemented for V2 sponsored lines:

- Contract stores `BehaviorStats` per agent: paid, signed paid, repaid, blocked, denied, and error counts.
- `openSponsoredLine(...)` computes the starting line from `deterministicScore(SPONSORED_BASE_LABEL, stats...)`.
- Allowed signed spends increment signed-paid behavior.
- Blocked spends increment blocked behavior and can cut the earned limit.
- Repayment increments repaid behavior and can grow the earned limit.
- `refreshSponsoredLineFromBehavior(agent, requestHash)` is public, so no owner is required to apply a behavior-derived
  line refresh.
- Automatic refresh runs after direct signed spend, blocked spend, and repayment.
- The refreshed credit limit is capped by the sponsor's deposited reserve.

This is not unsecured credit. The sponsor still supplies the capital at risk. The autonomous part is that the contract
derives and applies the score/limit from recorded behavior instead of owner-submitted evidence.

### x402 Bind

- `recordSignedX402Spend(intent, x402Hash, facilitator, signature)` should verify the same signed intent onchain before
  any reimbursement.
- Sponsored V2 lines reject this path. They use `requestSignedSpend` so the contract pays the signed provider directly.
- This path can remain operator-gated until x402 settlement can be verified onchain, because otherwise anyone could submit
  a fake settlement hash and drain treasury reimbursements.
- The operator still has to prove the x402 transfer off-chain in the script/verifier.
- The receipt must bind the EIP-712 digest as `requestHash` and the settlement tx hash as `x402Hash`.

### Tests

Required Float V2 tests:

- sponsor can open a line without owner approval;
- sponsored line starts from deterministic behavior-derived score and reserve-capped limit;
- signed spend plus repayment grows the sponsored line from behavior;
- blocked spend can cut the sponsored line from behavior;
- sponsor-funded direct signed spend pays the provider and opens debt;
- sponsor-funded debt includes fee and close requires repayment;
- only sponsor can close or change line provider policy;
- sponsor line uses sponsor provider policy, not owner global policy;
- owner admin cannot mutate sponsor-funded line reserve;
- owner withdrawal cannot drain sponsored available reserve;
- valid signed direct spend pays provider and opens debt;
- valid signed x402 spend reimburses facilitator and opens debt only for non-sponsored legacy lines;
- wrong signer reverts;
- wrong provider/endpoint/amount signature does not verify;
- current fee cannot exceed signed `maxDebtUSDC`;
- expired intent reverts;
- cancelled intent reverts;
- consumed nonce cannot replay;
- duplicate request hash cannot replay;
- signer can cancel but outsider cannot;
- ERC-1271 signer path where feasible;
- blocked signed intent moves no provider/facilitator funds;
- solvency invariant still holds;
- old V1 paths either remain explicitly legacy or are disabled for external proof claims.

## Float V2 Underwriting Boundaries

Allowed claim: "sponsor-funded lines refresh from contract-stored behavior."

Not allowed claim: "permissionless unsecured credit underwriting." V2 does not let an unfunded agent borrow from a public
treasury only because it has a good score. A sponsor or future pool must still reserve capital first.

The off-chain verifier should still recompute the same score from receipts and compare it to `autonomousLineScore(...)`,
but the V2 deploy proof should lead with the contract-stored behavior refresh because that path no longer depends on owner
evidence submission.

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

- lead with Arc USDC as the load-bearing settlement asset;
- keep x402/EIP-3009 framed as the V1 historical/legacy binding path, not the sponsored V2 hero settlement primitive;
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

V2 requires redeploying `ShadowFloat` because sponsor state, line-specific provider policy, signature state, and nonce
mappings are contract storage.

Migration status:

- Keep V1 contract address and receipts live as historical proof.
- V2 is deployed as the current permissionless Float contract:
  `0x20dcA96B0C487D94De885c726c956ffaF38b12C2`.
- V2 treasury is funded through a sponsor reserve.
- Fresh V2 proof-loop verification is live and reproducible with `npm run float:v2-verify-live`: sponsor opened a `0.05` USDC line, the
  agent signed, the contract paid `0.01` USDC directly to the provider, a `0.1` USDC overrun blocked with no provider
  transfer, repayment cleared debt, and the line restored to full capacity. This live verifier proves the canonical V2
  spend/block/repay loop; delivery receipts, close/default recovery, replay rejection, and cancellation remain covered by
  tests unless they are added to a future live proof loop.
- Re-run signed x402 bind only as secondary proof, not the hero path.
- Site must show both:
  - V1: historical loop and external proof;
  - V2: current sponsor-funded, contract-enforced authorization path.

## Demo Standard

The demo must show the product moment before proof details:

1. Builder signs an intent locally.
2. Contract verifies signer/nonce/expiry onchain.
3. Shadow fronts provider payment directly for sponsored V2 lines; non-sponsored legacy lines can use operator-assisted x402 reimbursement.
4. Debt opens.
5. Overspend or cancelled intent is blocked before funds move.
6. Repayment restores capacity.
7. Score/line refreshes from contract-stored behavior.
8. Verifier confirms the whole path.

## Claim Boundaries

Allowed:

- "V2 verifies signed Float intents onchain."
- "Agents can cancel unused nonces."
- "Replays and expired intents fail in the contract."
- "Sponsor-funded lines can grow or cut from contract-stored behavior."
- "V1 proved the economic loop; V2 removes the off-chain trust gap."
- "M1 adapters enforce policy before transfer for audited adapter paths."

Not allowed until built:

- "Fully permissionless credit underwriting."
- "Any integrator cannot bypass the enforcer."
- "Gateway settlement is bound into Float."
- "The agent runs your treasury without keys."
- "Vault yield" or "Morpho integration" unless a real market/share path exists.

## Final Acceptance

Float V2 readiness status:

- contracts build: done;
- Float V2 tests pass: done;
- live V2 deployment is funded: done;
- fresh V2 receipts exist: done;
- V2 verifier passes without private keys: done;
- README states V1 historical proof and V2 current proof separately: done.

Still outside the Float V2 deploy gate:

- the public website should lead with the V2 current proof once the app/indexer surface is updated;
- external builders should sign against the V2 contract with their own tooling;
- M1 V2 safety hardening remains a separate mandate-rail roadmap item, not a prerequisite for the sponsored Float V2 proof.

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
