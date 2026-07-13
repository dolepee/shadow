# Shadow Float Economics

Shadow Float gives an autonomous agent bounded Arc USDC spending capacity backed by a sponsor-specific reserve. The current deployment proves the accounting and control loop on Arc testnet. It is not a pooled credit market, an interest-bearing product, or evidence of production revenue.

## Current Economic Loop

1. A sponsor approves and deposits Arc USDC through `openSponsoredLine(...)`.
2. `ShadowFloat` assigns the agent a behavior-derived credit limit capped by that deposited reserve.
3. The sponsor sets the provider, endpoint hash, per-request cap, daily cap, and mandate expiry for the line.
4. The agent signs a bounded `FloatSpendIntent` without transferring its key or pre-funding its wallet.
5. If the intent and line policy pass, `ShadowFloat` pays the named provider from contract custody and records debt against the agent.
6. Repayment reduces debt and restores available capacity, subject to the contract's behavior-based line refresh.
7. The sponsor can close the line and reclaim its full reserve only when debt is zero.
8. If the sponsor defaults an unpaid line, the contract writes off the debt and returns only the reserve remainder.

## Participants

| Participant | Supplies | Receives or protects |
| --- | --- | --- |
| Sponsor | A reserve dedicated to one agent line and its provider policy | Reserve reclaim after repayment; bounded loss exposure if the line defaults |
| Agent | A signed intent and repayment | Access to approved paid services without pre-funding each agent wallet |
| Provider | The approved service or API response | Arc USDC paid directly from `ShadowFloat` when the request passes policy |
| Shadow | Contract enforcement, accounting, receipts, and verification surfaces | No meaningful live revenue on the current V2 deployment |

## Reserve And Loss Accounting

Sponsored capital is isolated in the accounting even though USDC is held by the same contract:

- `totalSponsoredReserveUSDC` tracks sponsor reserve obligations.
- `totalSponsoredAvailableCreditUSDC` tracks currently available sponsored capacity.
- Owner withdrawals must leave enough USDC to cover owner-managed available credit plus all sponsored reserve.
- A sponsor cannot close while its agent has active debt.
- A normal close returns the full recorded reserve to the sponsor-selected recipient.
- A default returns `reserve - active debt`; the unpaid debt is recorded in `totalDefaultedUSDC` and `defaultedDebtUSDC(agent)`.

The sponsor therefore bears nonpayment risk up to the dedicated reserve. The provider does not wait for the agent to repay: it receives USDC when the approved spend executes.

## Capacity And Debt

For sponsored lines:

- initial and refreshed credit limits are the lower of the behavior-derived recommendation and the sponsor reserve;
- a successful spend reduces available capacity by provider amount plus any configured protocol fee;
- active debt increases by the same amount;
- a signed `maxDebtUSDC` caps cumulative debt after the proposed spend;
- partial repayment reduces debt and restores the corresponding capacity;
- blocked, denied, frozen, expired, or over-limit requests move no provider funds.

Repayment history can improve the behavior-derived recommendation, but the line can never exceed its sponsor reserve.

## Fees And Revenue

The contract supports an owner-configured fee of at most 10% through `feeBps`. When non-zero, the fee is added to agent debt and recorded in `totalFeesAccruedUSDC`; the provider still receives only the signed provider amount.

The current V2 deployment has `feeBps = 0`. Therefore:

- current V2 activity is product and accounting proof, not meaningful protocol revenue;
- testnet provider payments are transaction volume, not Shadow revenue;
- no sponsor yield or fee share exists today;
- no interest rate is charged today.

A production fee should not be enabled until repeat unassisted usage demonstrates that the product removes a real funding or operational problem. Any future fee must be visible before signing and included in the signed maximum-debt bound.

## What Does Not Exist Yet

- no pooled sponsor capital;
- no permissionless liquidity-provider vault;
- no risk-priced interest rate;
- no transferable debt;
- no insurance product or loss guarantee;
- no production default-recovery process;
- no Shadow token;
- no audited mainnet deployment.

## Metrics That Matter Next

The post-Lepton pilot should optimize for evidence of repeat utility rather than synthetic volume:

- time from sponsor arrival to an open line;
- distinct external sponsors and agents;
- returning sponsors and agents;
- provider-paid USDC from external lines;
- repayment rate and time to repayment;
- policy blocks with zero provider transfer;
- reserve reclaimed after debt reaches zero;
- defaulted USDC, if any;
- protocol revenue only after a real fee is enabled.

## Mainnet Decision Gate

Shadow should design pooled capital, sponsor compensation, and production fees only after one external agent completes repeat, unassisted spend-and-repay cycles. Until then, the honest economic claim is narrower: sponsor-specific reserves create bounded spending capacity, providers are paid before agent repayment, and the contract makes the resulting debt and loss exposure auditable.
