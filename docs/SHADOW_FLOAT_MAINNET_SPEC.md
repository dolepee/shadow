# Shadow Float Mainnet V1 Specification

Status: proposed; implementation is blocked pending qdee approval  
Scope: sponsored-only reserve-backed USDC spending lines  
Supersedes for production: none; deployed testnet `ShadowFloat` V2 remains immutable and is not a production candidate

## 1. Product and safety boundary

Shadow Float Mainnet V1 lets an approved sponsor place its own USDC into one dedicated line for one agent. The agent signs a bounded payment to a sponsor-approved provider. The contract pays the provider, records principal owed by the agent, accepts repayment, and lets the sponsor reclaim its capital when the line has no debt.

The sponsor owns the unspent reserve and bears at most the provider principal actually paid from that line. No owner, operator, other sponsor, or other line may use it. Protocol fees are owed by the agent and are earned only when repaid; an unpaid fee is never charged to sponsor principal.

This release contains no legacy owner-funded credit, shared treasury, pooled capital, sponsor yield, transferable debt, leverage, token, PolicyPool, Morpho, Uniswap, style adapter, automatic scoring, or upgrade proxy.

## 2. Actors and exact powers

| Actor | May | Must never be able to |
| --- | --- | --- |
| Sponsor | Open and fund its own line; choose agent, providers, endpoints, limits, maximum repayment window, expiry, and fee ceiling; reduce or replace future-spend terms; close a debt-free line; reclaim unspent reserve; declare default after maturity | Spend another line; withdraw another sponsor's reserve; redirect an agent signature; default before `dueAt`; raise governance caps; pause repayment or reclaim |
| Agent | Sign a spend bound to one contract, chain, line, epoch, terms hash, provider, endpoint, amount, debt ceiling, fee, due time, nonce, expiry, and executor; cancel an unused nonce; repay | Move reserve directly; change sponsor terms; reuse a stale epoch or terms signature |
| Provider | Receive the exact signed principal; optionally acknowledge delivery in a separate non-financial registry | Pull funds; alter debt or terms; make delivery acknowledgement proof of quality |
| Submitter / relayer | Submit an intact signed intent; retry an ambiguous broadcast idempotently | Change signed fields; select a different executor; gain custody or governance power |
| Governor multisig | Manage guarded sponsor allowlist, operators, pauses, fee schedule, global caps, ownership, and version sunset under the rules below | Withdraw or borrow sponsored reserve; edit a line; forgive or accelerate debt; default a line; block exits |
| Operator | Set either risk-creation pause from false to true and cancel a queued cap/fee increase; submit intact signed intents like any relayer | Unpause; own funds; change caps, fees, terms, allowlists, ownership, or migration state; default or close a line |
| Read-only monitor | Read state and events; reconcile balances and due/default eligibility | Mutate any state |

Ownership uses propose/accept transfer. The deployer is removed as owner and operator before funding. Production ownership is an approved multisig; signer identities and thresholds belong in the private release manifest, not this specification.

## 3. Identifiers, terms, and signed intent

Each sponsor-agent pair has a monotonically increasing `lineEpoch`. Opening a new line for that pair increments it, including after close or default. An agent may have lines from multiple sponsors; they remain independent and never invalidate one another. A line is identified by:

```text
lineId = keccak256(chainId, contract, sponsor, agent, lineEpoch)
```

Every material future-spend term is encoded canonically and hashed. At minimum:

```text
termsHash = keccak256(
  lineId,
  sponsor,
  agent,
  reserveCap,
  lineSpendCap,
  dailySpendCap,
  lineExpiry,
  maximumRepaymentWindow,
  sponsorMaxFeeBps,
  termsVersion,
  providerPolicyHash
)
```

`providerPolicyHash` commits to the exact active provider, endpoint, per-request cap, daily cap, and policy expiry used by the spend. The contract recomputes the current provider-specific `termsHash` during execution. Any material line or provider-policy change increments `termsVersion`, produces a new hash, and invalidates all earlier signatures, even when the new terms are more permissive or the proposed spend would still fit.

`lineSpendCap` bounds cumulative provider principal paid during that line epoch. Repayment restores reserve capacity but never reduces the cumulative counter or replenishes this cap; only a new line epoch starts a new counter.

The EIP-712 `SpendIntent` binds all of:

- agent, sponsor, `lineId`, `lineEpoch`, and `termsHash`;
- provider and endpoint hash;
- provider principal, maximum total debt, exact fee bps, and maximum fee amount;
- exact `dueAt`, nonce, signature expiry, and optional executor;
- EIP-712 domain chain ID and verifying contract.

Execution requires the stored epoch and terms hash to equal the signed values, the exact current fee to equal the signed fee, and every cap to remain satisfied. An intent is valid through `block.timestamp == signatureExpiry` and expired after that boundary. A nonzero executor must equal `msg.sender`. Resulting principal-plus-fee debt must not exceed signed maximum total debt, and the computed fee must not exceed the signed maximum fee amount or sponsor ceiling. The exact signed `dueAt` must satisfy `block.timestamp + minimumRepaymentWindow <= dueAt <= block.timestamp + line.maximumRepaymentWindow` and must not exceed line expiry. The global minimum and maximum repayment windows are immutable deployment bounds. Nonces are scoped by `lineId`. After signature validation, a provider, endpoint, cap, daily-limit, allowlist, or operational-pause rejection records a terminal blocked receipt and consumes the nonce/digest without moving funds. A token-call or non-exact-transfer failure reverts atomically and consumes nothing. Duplicate submission can never pay twice, including after a policy change or unpause.

EOA signatures must be canonical and non-malleable. ERC-1271 validation is supported only with a reentrancy guard around the complete call and state transition. A signature from an old line, old terms version, other chain, or other contract is invalid.

## 4. Capital ownership, accounting, and loss

For every line, accounting keeps separate values for:

- `sponsorReserve`: sponsor capital assigned to the line;
- `principalOutstanding`: USDC already paid to providers and not repaid;
- `feeOutstanding`: fee owed by the agent but not earned by the protocol;
- `spendableCapacity`: the lesser of unspent reserve and all current line/cap limits;
- `cumulativePrincipalPaid`: lifetime provider principal for the current epoch, never reduced by repayment;
- `sponsorRecovery`: post-default principal repaid for the sponsor;
- `protocolFeesEarned`: fees actually received, never merely accrued.

Required equations, allowing only explicitly documented rounding of zero for six-decimal USDC:

```text
principalOutstanding <= sponsorReserve
spendableCapacity + principalOutstanding <= sponsorReserve
sum(line sponsorReserve - principalOutstanding) <= contract USDC balance
contract USDC balance >= sponsor obligations + earned-but-unwithdrawn protocol fees
```

Provider payment decreases contract balance and opens equal principal debt. A fee increases agent debt but does not pay or reduce sponsor reserve. Repayment is applied first to principal, restoring sponsor capital or post-default recovery, then to fee. Only received fee becomes withdrawable protocol revenue.

Before default, full principal repayment restores line capacity subject to current caps and terms. After default, recovered principal is claimable by the original sponsor and never reopens capacity. Fee recovery follows sponsor principal recovery.

The maximum sponsor loss in a transaction is the signed provider principal for that line, bounded by per-spend, daily, line, and protocol caps. The maximum aggregate loss is total outstanding provider principal and never exceeds funded sponsored reserves. The agent owes principal plus its accepted fee. Providers bear no agent repayment risk after a successful transfer. A reverted or restricted USDC transfer creates no debt and consumes no nonce.

## 5. State machine

The canonical stored states are `NONE`, `OPEN`, `DRAWN`, `DEFAULTED`, and `CLOSED`. `MATURED` is an objective view of `DRAWN` when `block.timestamp >= dueAt`; it is not a discretionary flag.

| From | Transaction / condition | To | Required effect |
| --- | --- | --- | --- |
| `NONE` or terminal prior epoch | `openLine` by allowlisted sponsor with exact transfer delta | `OPEN` | Increment epoch; commit terms; isolate reserve; no debt |
| `OPEN` | valid signed `spend` and exact provider transfer | `DRAWN` | One active draw only; open principal and fee debt; set exact `dueAt` |
| `OPEN` | policy-blocked signed spend | `OPEN` | Receipt only; no transfer or debt; digest cannot later become payable under changed state |
| `DRAWN` | partial `repay` before maturity | `DRAWN` | Reduce principal then fee; do not open a second draw |
| `DRAWN` | full `repay` | `OPEN` | Debt zero; capacity restored under current terms |
| `DRAWN` | time reaches `dueAt` | `MATURED` view | No storage authority or capital movement |
| matured `DRAWN` | sponsor `declareDefault` | `DEFAULTED` | Freeze line; return/retain unspent reserve for sponsor; record loss and recovery beneficiary |
| `DEFAULTED` | `repay` | `DEFAULTED` | Route principal recovery to sponsor; never restore capacity |
| `OPEN` | sponsor `closeLine` | `CLOSED` | Return the line's full reserve; clear active terms; preserve epoch/history |
| `DEFAULTED` | sponsor claims unspent reserve/recovery | `DEFAULTED` | Transfer only sponsor-owned amount; preserve debt history |

`declareDefault` must revert while `block.timestamp < dueAt`; at `dueAt` the line is mature. It can execute only once. Close must revert with any principal or fee outstanding. Reopening creates a new epoch and cannot make any old signature valid.

## 6. Pauses and incident exits

There are exactly two operational pauses:

- `openingsPaused`: blocks new lines;
- `spendsPaused`: blocks new provider payments.

Neither pause may block repayment, debt-free close, sponsor reclaim, post-default recovery, eligible default, nonce cancellation, reads, or reconciliation. Sponsor allowlisting applies only to new risk; removal may block future spends but never an existing line's exits. Cap reductions, sponsor removal from the allowlist, operator removal, and pausing are immediate safety actions. Unpausing is multisig-only and evented.

There is no global modifier that can cover both risk creation and exits. An incident cannot give the governor custody of sponsor funds. If USDC restrictions prevent a transfer, state remains unchanged and the sponsor can retry with an allowed recipient where the sponsor-facing terms permit it.

## 7. Fees, caps, and guarded-launch governance

Mainnet V1 starts guarded with a sponsor allowlist and zero fee. Proposed founder-canary values are configuration recommendations, not deployment authorization: 25 USDC protocol reserve, 5 USDC per line, 1 USDC per spend, 2 USDC daily per line, and one active draw.

The deployment has immutable absolute maxima. Effective global reserve, per-line, per-spend, daily, and fee caps may decrease immediately. Any increase is queued with old value, new value, activation time, and cancellation event, and cannot exceed its immutable maximum. An increase takes effect only after the release-manifest delay. No global change raises an existing line above its sponsor-accepted ceiling.

Fee decreases may be immediate. Fee increases are delayed and affect a line only within `sponsorMaxFeeBps`. Every spend binds the exact fee, so a fee change invalidates an earlier signature. No fee is charged for a blocked spend, repayment, close, reclaim, or default. Protocol fee withdrawal is limited to fees actually repaid and excludes all sponsor obligations.

## 8. Token and Arc assumptions

- The constructor binds one official Arc mainnet USDC ERC-20 interface and reverts for a zero/non-contract address or decimals other than six.
- Deployment tooling independently verifies the official chain ID, USDC address/code/decimals, two RPCs, explorer, and restricted-transfer behavior. Testnet values are never copied as defaults.
- Native Arc gas units and ERC-20 USDC accounting are separate. All monetary parameters are integer atomic USDC; UI conversion is not authoritative.
- Funding, provider payment, repayment, reclaim, recovery, and fee withdrawal require exact pre/post balance deltas. Fee-on-transfer, rebasing, callback-dependent, false-return, and malformed-return behavior is rejected.
- No permit, CCTP, Gateway, ERC-8004, or ERC-8183 behavior is required by the core contract. Those systems may fund an address or integrate outside the core only after separate review.

## 9. Deployment, decomposition, migration, and operations

The candidate is a new immutable version beside testnet V2. It uses no proxy and imports no V2 owner-credit or scoring state.

Proposed decomposition:

- `ShadowFloatMainnet`: minimal capital state machine, signature validation, caps, pauses, and two-step ownership;
- `ShadowFloatTerms`: pure hashing/validation library with no storage or external calls;
- `ShadowFloatDeliveryRegistry`: optional non-financial delivery acknowledgements, unable to affect payment, debt, default, or reclaim;
- deployment and reconciliation tooling: chain/token/bytecode/config assertions and deterministic release manifest.

The core runtime target is at most 18,432 bytes (75% of the 24,576-byte EIP-170 limit), leaving at least 6,144 bytes of headroom. Size failure blocks release; features move out of the core rather than consuming the reserve.

Deployment is non-funding and asserts chain, token, decimals, immutable maxima, effective caps, fee, guarded mode, owner, operators, runtime bytecode hash, and compiler settings. Funding is a separate authorized transaction only after source/bytecode verification and the complete propose/accept multisig transfer. The deployer and unused operators are removed before value enters.

Migration never copies accounting administratively. New spends can be paused on the old version while repayment, default, close, reclaim, and recovery remain live. A sponsor closes and reclaims an old debt-free line, then explicitly opens a new line on the new version. Outstanding old debt remains governed by the old immutable contract until repaid/defaulted/recovered. No owner sweep substitutes for sponsor exit.

## 10. Release invariants

| ID | Invariant |
| --- | --- |
| `CAP-01` | No owner, operator, other sponsor, or other line can consume or withdraw a line's reserve. |
| `CAP-02` | Aggregate token balance always covers sponsor obligations and earned-but-unwithdrawn fees. |
| `CAP-03` | A failed or non-exact token transfer creates no debt, payment receipt, or consumed nonce. |
| `CAP-04` | Every line opening and accepted spend enforces immutable and effective protocol-reserve, per-line-reserve, cumulative line-spend, per-spend, daily-spend, and one-active-draw caps; a valid signature bypasses none of them. |
| `SIG-01` | Every spend binds domain, agent, sponsor, line, epoch, exact terms, payment, debt/fee bounds, due time, nonce, expiry, and executor. |
| `SIG-02` | Close, reopen, or any material terms/fee change invalidates every earlier signature. |
| `SIG-03` | One digest can cause at most one provider payment, including relayer retries and ERC-1271 calls. |
| `DEBT-01` | Only one active draw exists per line; default is impossible before the exact maturity boundary. |
| `DEBT-02` | Repayment restores sponsor capital before earning fees; post-default repayment benefits the sponsor before the protocol. |
| `EXIT-01` | Repayment, eligible default, debt-free close, reclaim, recovery, cancellation, and reads remain available under every pause. |
| `GOV-01` | Safety reductions/removals are immediate; cap/fee increases are delayed, bounded, evented, and cannot exceed sponsor consent. |
| `ROLE-01` | Ownership is two-step; deployer/operator removal is provable; non-governors cannot exercise governance. |
| `TOK-01` | Only verified six-decimal Arc USDC with exact transfer deltas can move accounting state. |
| `STATE-01` | State, events, aggregates, line history, and reserve/debt equations agree after every transition. |
| `MIG-01` | A version can stop new risk without disabling old-line exits; migration cannot transfer sponsor ownership administratively. |
| `SCOPE-01` | Core bytecode stays at or below 18,432 bytes and contains none of the explicitly excluded systems. |

The executable mapping for every invariant is maintained in `SHADOW_FLOAT_MAINNET_TEST_MATRIX.md`. Production implementation must make the mainnet suite green; Packet B deliberately keeps the five V2 requirement tests red and opt-in.

## 11. Approval boundary

This document authorizes no deployment, transaction, merge, public claim, or production implementation. Work Packet C starts only after qdee approves this specification and its threat model. Any change to capital ownership, loss allocation, pause exits, signature binding, maturity, or scope returns the specification to approval.
