# Shadow Float Mainnet V1 Threat Model

Status: architecture approved by qdee on 2026-08-21; Packet C implementation starts only after the corrected Packet B PR merges.

## Assets and security objectives

Protected assets are each sponsor's unspent USDC reserve, provider principal paid under an authentic bounded intent, the sponsor's repayment/recovery claim, signature nonces, line epoch and terms integrity, and an independently reconcilable event/state history. Mainnet V1 has no protocol fee asset or fee surface.

The primary objective is reserve isolation. A sponsor can lose only principal that its agent validly authorized for that sponsor's current line and terms, within every cap. Secondary objectives are stale-signature rejection, objective default maturity, always-live exits, exact token accounting, least-privilege governance, and idempotent submission.

Availability of new credit is not a protected objective during an incident. Repayment and sponsor exits are.

## Trust assumptions

- The approved multisig may pause risk creation, reduce caps, remove operators/sponsors, and perform delayed bounded governance. It is not trusted with sponsor reserve custody.
- A sponsor chooses its agent and provider policy and accepts disclosed principal loss. It is not trusted to default early or affect another line.
- An agent signer may be compromised. Damage must remain inside its current line, epoch, terms, and caps; cancellation and spend pause limit future damage.
- A relayer, provider, frontend, RPC, indexer, or monitor may be malicious, stale, duplicated, or unavailable. Contract state and exact token deltas are authoritative.
- Official Arc mainnet USDC is assumed to preserve ordinary six-decimal ERC-20 balances but may restrict a sender or recipient and revert. The contract assumes no unrestricted transfer entitlement.
- Multisig key management, legal suitability, and official network parameters are external release gates, not properties proved by Solidity.

## Adversaries and failure sources

- malicious or compromised owner, operator, sponsor, agent, provider, ERC-1271 signer, relayer, or UI;
- cross-line and cross-sponsor accounting mistakes;
- old signatures after close/reopen or policy changes;
- premature default and ambiguous maturity boundaries;
- global pause or migration logic that traps exits;
- reentrancy, duplicate broadcast, callback, false-return, transfer restriction, and non-exact token behavior;
- chain/domain confusion, wrong USDC decimals, bad release configuration, stale RPC/index data, or partial deployment;
- contract-size pressure that encourages unsafe coupling.

## Threat register

| ID | Threat and transaction-level loss | Required control | Invariants / tests |
| --- | --- | --- | --- |
| `T-01` | Owner grants legacy credit against a balance containing sponsor reserve; the legacy agent pays a provider, leaving the sponsor unable to reclaim. Loss can reach the sponsor's unspent reserve. | Sponsored-only contract, per-line accounting, no owner credit/withdrawal path, aggregate solvency invariant. | `CAP-01`, `CAP-02`; `RED-01`, `CAP-01A/B`, `INV-01` |
| `T-02` | An unconsumed signature from epoch N pays a provider after close/reopen in epoch N+1. Loss is that stale principal. | Bind line ID, monotonic epoch, and terms hash; epoch-scoped nonce. | `SIG-01`, `SIG-02`; `RED-02`, `SIG-01A/B` |
| `T-03` | Sponsor or owner declares default immediately after payment, terminating the agent before the agreed due time, or maturity accidentally disables voluntary repayment before default. | Exact signed `dueAt`; objective inclusive boundary; no discretionary maturity flag; repayment explicitly remains available before, at, and after maturity until default executes. | `DEBT-01`, `EXIT-01`; `RED-03`, `DEBT-01A/B/D` |
| `T-04` | Governance or sponsor changes provider terms after signing; a materially different payment executes, or a fee surface is introduced into zero-fee V1. | Terms hash in intent; every material change increments terms version; ABI/source deny all fee configuration, accrual, debt, events, and withdrawal. | `SIG-01`, `SIG-02`, `GOV-01`, `SCOPE-01`; `RED-04`, `SIG-02A`, `GOV-01A/D`, `SCOPE-01A` |
| `T-05` | Emergency pause blocks repayment or reclaim and traps sponsor capital. | Separate openings/spends pauses; exits have no pause modifier. | `EXIT-01`; `RED-05`, `EXIT-01A/B` |
| `T-06` | Another sponsor, line, operator, or freshly signed over-cap payment consumes excess reserve. | Dedicated reserve ledger, explicit boundary checks for every loss cap, immutable zero-fee accounting, and role separation. | `CAP-01`, `CAP-02`, `CAP-04`, `ROLE-01`; `CAP-01A/B`, `CAP-04A/B`, `ROLE-01A` |
| `T-07` | Reentrant ERC-1271 signer or token path pays twice or observes half-written state. | Full-function guard, checks/effects/interactions, nonce/payment commitment, exact deltas. | `SIG-03`, `CAP-03`; `SIG-03A/B`, `TOK-01B` |
| `T-08` | Relayer times out after broadcast and resubmits, causing duplicate payment. | Digest idempotency and one-payment commitment; client reconciliation before retry. | `SIG-03`, `STATE-01`; `SIG-03B`, `OPS-01` |
| `T-09` | Restricted or nonstandard USDC reports success incorrectly, moves a different amount, or reverts after accounting. | Immutable verified token, safe-call handling, exact pre/post deltas, atomic state. | `TOK-01`, `CAP-03`; `TOK-01A/B/C` |
| `T-10` | A hidden fee, fee debt, or fee withdrawal is introduced into the founder canary and consumes sponsor or agent capital. | V1 contains no fee parameter, accounting, governance, event, or withdrawal path; any future fee requires a separate reviewed immutable version. | `CAP-02`, `GOV-01`, `SCOPE-01`; `INV-01`, `GOV-01D`, `SCOPE-01A` |
| `T-11` | A cap increase takes effect instantly or exceeds sponsor consent. | Immutable maxima, delay, events, and sponsor-accepted ceilings. | `GOV-01`; `GOV-01A/B/C` |
| `T-12` | Compromised deployer/operator retains authority after handoff. An active operator can stop new risk but cannot unpause or block exits. | Two-step ownership, pause-only operator powers, explicit removal, manifest assertions. | `ROLE-01`, `EXIT-01`; `ROLE-01A/B`, `EXIT-01A/B` |
| `T-13` | Migration pause or owner sweep strands old-line capital. | Immutable versions; risk-off only; sponsor-driven close/reclaim; old exits remain live. | `MIG-01`, `EXIT-01`; `MIG-01A/B` |
| `T-14` | Wrong chain, contract, token, decimals, or config makes signatures portable or accounting wrong by orders of magnitude. | EIP-712 domain, deploy assertions, code/decimals checks, deterministic manifest. | `SIG-01`, `TOK-01`, `STATE-01`; `SIG-01C`, `TOK-01A`, `REL-01` |
| `T-15` | State and events diverge, hiding insolvency or wrong recovery ownership. | Transition assertions, aggregate invariants, two-RPC reconciliation. | `STATE-01`; `INV-01/02`, `OPS-02` |
| `T-16` | Feature coupling approaches the bytecode limit and removes safety headroom. | Minimal core, optional non-financial registry, hard 18,432-byte release gate. | `SCOPE-01`; `SIZE-01`, `SCOPE-01A` |

## Transaction ordering and external calls

Funding and repayment validate exact incoming balance deltas before committing accounting. Provider payment, reclaim, and recovery are atomic: any failed or non-exact outgoing delta reverts the complete transition. Nonces and payment commitments are set before an untrusted ERC-1271 or token interaction only when the reentrancy design preserves atomic rollback. No external callback can enter a second state-changing path; a caught nested-call failure does not invalidate an otherwise valid outer ERC-1271 authorization, which may complete exactly once.

Blocked policy evaluations create no provider transfer or debt. The digest is terminally recorded so a relayer cannot replay the same authorization after state or policy changes. A failed transaction records nothing and may be retried after the restriction is corrected.

## Incident boundaries

On suspected signer or relayer compromise, pause new spends, cancel known nonces, remove operators, and reconcile; repayment and exits remain live. On accounting divergence, pause openings and spends, compare contract balance with line aggregates through two RPCs, and do not withdraw or migrate. On restricted transfers, retain atomic state and use only a recipient change explicitly permitted by the sponsor-facing terms. On governor compromise, unaffected sponsors retain contract-enforced close, reclaim, repayment, default, and recovery paths.

No incident action authorizes an owner sweep, debt forgiveness, early default, forced migration, proxy upgrade, or use of another sponsor's capital.

## Residual risks and external gates

- Sponsor bears validly authorized provider principal if the agent never repays.
- A valid agent signature cannot prove provider quality; delivery acknowledgement proves only the provider's statement.
- Arc or USDC censorship can delay transfers despite correct contract state.
- Multisig compromise can disrupt new risk controls within immutable limits, though it cannot withdraw reserves by design.
- Smart-contract defects remain possible until independent review, high-run invariants, clean exact-head review, and release rehearsal pass.
- Legal classification, sponsor disclosure, and operational response require qualified external review.

These are accepted only for a founder-funded guarded canary within approved loss caps. Third-party capital remains disabled until the independent security, operations, pilot, legal, and official-network gates pass.
