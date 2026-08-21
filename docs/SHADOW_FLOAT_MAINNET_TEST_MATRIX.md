# Shadow Float Mainnet V1 Test Matrix

Status: Packet B requirements. `RED-*` tests intentionally fail against testnet V2 (or the documented legacy pause model) under the opt-in `mainnet-red` Foundry profile. They are not production implementation tests and are excluded from default CI. Packet C must port the requirements to the new candidate and make the complete candidate suite green.

Run the red requirements harness:

```sh
cd contracts
FOUNDRY_PROFILE=mainnet-red forge test -vv
```

Expected Packet B result: exactly five failing `RED-*` tests. A pass means V2 behavior changed or the reproduction no longer establishes the requirement and must be investigated; it does not authorize promoting V2.

| Test ID | Planned executable test | Invariants | Packet B status |
| --- | --- | --- | --- |
| `RED-01` | `test_RED_01_legacyOwnerCreditCannotConsumeSponsoredReserve` | `CAP-01`, `CAP-02` | Red against V2: owner-funded credit can spend the shared token balance and break sponsor reclaim |
| `RED-02` | `test_RED_02_oldSignatureCannotExecuteAfterCloseAndReopen` | `SIG-01`, `SIG-02`, `SIG-03` | Red against V2: intent omits line epoch/terms hash |
| `RED-03` | `test_RED_03_defaultCannotExecuteBeforeMaturity` | `DEBT-01` | Red against V2: sponsor can default immediately |
| `RED-04` | `test_RED_04_feeOrTermsChangeInvalidatesPriorSignature` | `SIG-01`, `SIG-02`, `GOV-01` | Red against V2: exact fee and terms are not signed |
| `RED-05` | `test_RED_05_pauseCannotBlockRepaymentOrReclaim` | `EXIT-01`, `MIG-01` | Red against isolated legacy global-pause model; V2 has no pause mechanism |
| `CAP-01A` | owner/operator/other sponsor cannot spend or withdraw a line reserve | `CAP-01` | Packet C |
| `CAP-01B` | concurrent max-cap lines remain isolated through spend/repay/close/default | `CAP-01`, `CAP-02`, `STATE-01` | Packet C fuzz + invariant |
| `INV-01` | token balance covers aggregate sponsor obligations and earned fees after arbitrary transitions | `CAP-02`, `DEBT-02`, `STATE-01` | Packet C invariant |
| `CAP-03A` | reverted/false/non-exact inbound or outbound transfer leaves debt, nonce, and events unchanged | `CAP-03`, `TOK-01` | Packet C |
| `CAP-04A` | test one atomic unit below, exactly at, and one above protocol-reserve, per-line-reserve, per-spend, and daily caps with otherwise valid signatures | `CAP-04`, `STATE-01` | Packet C boundary/fuzz |
| `CAP-04B` | concurrent lines cannot cross the aggregate effective or immutable protocol reserve cap | `CAP-02`, `CAP-04`, `STATE-01` | Packet C invariant |
| `SIG-01A` | mutate agent, sponsor, line ID, line epoch, terms hash, provider, endpoint, provider principal, maximum total debt, exact fee bps, maximum fee amount, due time, nonce, signature expiry, and executor independently | `SIG-01` | Packet C table/fuzz |
| `SIG-01B` | close/reopen increments epoch and rejects all prior unused intents | `SIG-02` | Packet C |
| `SIG-01C` | other chain or verifying contract rejects signature | `SIG-01` | Packet C |
| `SIG-01D` | an intent for provider A carrying provider B's current policy hash fails even when both providers are approved | `SIG-01`, `SIG-02` | Packet C cross-provider table |
| `SIG-01E` | high-s, invalid-v, malformed-length, zero-recovery, and wrong-signer EOA signatures fail without consuming nonce | `SIG-01`, `CAP-03` | Packet C signature table/fuzz |
| `SIG-01F` | freshly signed cases enforce expiry before/at/after its boundary, nonzero executor equality, resulting debt at/above maximum total debt, exact fee bps, computed fee at/above maximum fee amount, and sponsor fee ceiling | `SIG-01`, `GOV-01` | Packet C boundary/table/fuzz |
| `SIG-02A` | any sponsor policy or fee change invalidates pending intent | `SIG-02`, `GOV-01` | Packet C |
| `SIG-03A` | ERC-1271 reentry cannot consume/pay twice | `SIG-03` | Packet C |
| `SIG-03B` | duplicate and ambiguous relayer submission causes one payment | `SIG-03`, `STATE-01` | Packet C contract + Node test |
| `SIG-03C` | provider, endpoint, cap, daily, allowlist, and pause blocks create terminal nonce/digest receipts with no transfer; later policy change or unpause cannot make the same intent payable | `SIG-03`, `EXIT-01`, `STATE-01` | Packet C table/fuzz |
| `DEBT-01A` | second draw reverts while any debt is active | `DEBT-01` | Packet C |
| `DEBT-01B` | default reverts before `dueAt`, succeeds exactly at documented boundary, and only once | `DEBT-01`, `STATE-01` | Packet C boundary/fuzz |
| `DEBT-01C` | signed `dueAt` outside immutable or line repayment windows, or after line expiry, reverts | `DEBT-01`, `SIG-01` | Packet C boundary/fuzz |
| `DEBT-02A` | repayment waterfall restores principal before earning fee | `DEBT-02`, `CAP-02` | Packet C |
| `DEBT-02B` | post-default repayment routes principal recovery to sponsor and never restores capacity | `DEBT-02`, `STATE-01` | Packet C |
| `EXIT-01A` | both pauses active with debt: repay and eligible default still succeed | `EXIT-01` | Packet C |
| `EXIT-01B` | both pauses active debt-free: close/reclaim/recovery/cancel/read still succeed | `EXIT-01`, `MIG-01` | Packet C |
| `GOV-01A` | reductions/removals immediate; increases queued and inactive before delay | `GOV-01` | Packet C |
| `GOV-01B` | activation cannot exceed immutable maxima or sponsor fee ceiling | `GOV-01` | Packet C fuzz |
| `GOV-01C` | every cap/fee proposal, cancel, and activation emits exact old/new/time values | `GOV-01`, `STATE-01` | Packet C |
| `ROLE-01A` | unauthorized actors fail every governance and capital path; operators can pause/cancel queued increases but cannot unpause or block exits | `ROLE-01`, `CAP-01`, `EXIT-01` | Packet C role matrix |
| `ROLE-01B` | two-step multisig handoff and deployer/operator removal | `ROLE-01` | Packet C + deployment rehearsal |
| `TOK-01A` | constructor/deployer reject wrong address, code, decimals, chain, and manifest config | `TOK-01`, `STATE-01` | Packet C |
| `TOK-01B` | restricted sender/recipient, false return, malformed return, callback/reentry, and fee-on-transfer are atomic | `TOK-01`, `CAP-03`, `SIG-03` | Packet C adversarial mocks |
| `TOK-01C` | native gas and six-decimal ERC-20 amounts never share conversion logic | `TOK-01` | Packet C contract + Node test |
| `INV-02` | state, line aggregates, events, receipt commitments, and token deltas agree after arbitrary sequences | `STATE-01` | Packet C invariant |
| `MIG-01A` | risk-off old version still permits repay/default/close/reclaim/recovery | `MIG-01`, `EXIT-01` | Packet C |
| `MIG-01B` | no governor path transfers an active line or changes recovery ownership | `MIG-01`, `CAP-01` | Packet C role/invariant |
| `OPS-01` | client reconciles digest/receipt before retry after ambiguous broadcast | `SIG-03`, `STATE-01` | Packet C Node test |
| `OPS-02` | two RPC snapshots reconcile balance, obligations, due/default state, roles, caps, and pauses | `STATE-01` | Packet C no-secret verifier |
| `REL-01` | deterministic manifest matches chain, token, config, compiler, bytecode, owner, and operators | `TOK-01`, `ROLE-01`, `STATE-01` | Packet C release test |
| `SIZE-01` | deployed core runtime is at most 18,432 bytes | `SCOPE-01` | Packet C CI gate |
| `SCOPE-01A` | ABI/source deny legacy owner credit, shared treasury, pooled capital, sponsor yield, transferable debt, leverage, token, PolicyPool, Morpho, Uniswap, style adapters, automatic scoring, and upgrade proxies | `SCOPE-01` | Packet C boundary test/review |

Every invariant in the specification appears above. Every threat in the threat model cites at least one row. Packet C may split a row into more tests but may not remove coverage without returning the specification to qdee for approval.
