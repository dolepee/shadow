# Shadow Float V2 External Sponsor Runbook

Shadow Float V2 lets any sponsor open a reserve-backed line for an agent without owner approval. The sponsor supplies the USDC reserve, sets the provider policy, and controls the line-specific provider mandate. The agent still signs each spend intent locally.

This runbook is for non-operator sponsor tests. It does not require a contract redeploy.

## Live Contract

| Item | Value |
| --- | --- |
| Chain | Arc Testnet, `5042002` |
| ShadowFloat V2 | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| Arc USDC | `0x3600000000000000000000000000000000000000` |
| Default provider | `0x8ddf06fE8985988d3e0883F945E891BD57084937` |
| Default endpoint hash | `0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160` |

## What This Proves

1. An external sponsor can reserve their own Arc USDC for an agent line.
2. `ShadowFloat` computes the line from contract behavior scoring and caps it by the sponsor reserve.
3. The sponsor can set a provider mandate for the line.
4. The agent signs one bounded EIP-712 `FloatSpendIntent`.
5. The contract pays the provider from the sponsored reserve only after verifying the agent signature and policy.
6. Repayment restores capacity and updates the behavior score.

## Sponsor Requirements

The sponsor wallet needs:

1. At least `0.05` Arc USDC for the default reserve.
2. Enough Arc gas to submit `approve` and `openSponsoredLine`.
3. A fresh agent address that is not already registered in `ShadowFloat`.

The sponsor does not need to share a private key. They run the command locally.

One-time setup from a fresh clone, at the repo root:

```bash
npm install --prefix app
```

The sponsor scripts import `viem` from `app/node_modules`.

## Sponsor Opens The Line

From the Shadow repo, dry run first:

```bash
SHADOW_FLOAT=0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
FLOAT_SPONSOR_PRIVATE_KEY=0xSPONSOR_KEY \
FLOAT_AGENT=0xAGENT_WALLET \
SPONSOR_LINE_DRY_RUN=1 \
npm run float:v2-sponsor-line
```

Then open the line:

```bash
SHADOW_FLOAT=0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
FLOAT_SPONSOR_PRIVATE_KEY=0xSPONSOR_KEY \
FLOAT_AGENT=0xAGENT_WALLET \
FLOAT_V2_LINE_ATOMIC=50000 \
FLOAT_V2_MAX_PER_REQUEST_ATOMIC=10000 \
FLOAT_V2_DAILY_LIMIT_ATOMIC=50000 \
npm run float:v2-sponsor-line
```

The script prints the sponsor, agent, reserve, provider mandate, transaction hashes, and the resulting line state. If the same sponsor already owns the line, it refreshes the provider mandate instead of opening a second line.

## Agent Signs The Spend Intent

After the line is open, the agent signs locally:

```bash
SHADOW_FLOAT=0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
EXPECTED_AGENT=0xAGENT_WALLET \
BUILDER_PRIVATE_KEY=0xAGENT_KEY \
FLOAT_PROVIDER=0x8ddf06fE8985988d3e0883F945E891BD57084937 \
FLOAT_ENDPOINT_HASH=0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160 \
FLOAT_SPEND_ATOMIC=10000 \
FLOAT_INTENT_EXECUTOR=0xSPONSOR_OR_RELAYER \
RATIONALE="External sponsor V2 line: agent uses Shadow Float to buy an approved paid provider resource." \
node app/scripts/float-builder-sign.mjs
```

Set `FLOAT_INTENT_EXECUTOR` to the sponsor's own address to keep the whole lifecycle external. The executor only submits the transaction; the provider payment comes from the sponsored reserve held by the contract.

The agent sends back only:

```json
{
  "intent": {},
  "signature": "0x...",
  "digest": "0x..."
}
```

## Bind The Spend

The sponsor or the executor named in the intent submits the signed spend:

```bash
FLOAT_EXECUTOR_PRIVATE_KEY=0xEXECUTOR_KEY \
npm run float:v2-bind-intent -- signed-intent.json
```

The output must show:

1. `ok: true`
2. `intentConsumed: true`
3. `nonceMarkedUsed: true`
4. `providerPaidExactAmount: true`

## Repay

The agent repays with the existing builder repayment flow after approving USDC:

```bash
SHADOW_FLOAT=0x20dcA96B0C487D94De885c726c956ffaF38b12C2 \
BUILDER_PRIVATE_KEY=0xAGENT_KEY \
EXPECTED_AGENT=0xAGENT_WALLET \
node app/scripts/float-builder-repay.mjs
```

The script reads the current V2 line debt, approves exactly that amount if needed, and calls `repay`. After repayment, `lines(agent).activeDebtUSDC` should be `0`, and the line should show restored capacity.

## Reclaim The Reserve

The reserve stays the sponsor's. Once the line has zero active debt, the sponsor can close the line at any time with `closeSponsoredLine(agent, recipient, requestHash)`. Closing writes a receipt and returns the entire reserve to the recipient the sponsor names. While debt is open, `closeSponsoredLine` reverts with `ActiveDebt`.

## Public Claim Boundary

CitePay and Forum Tollgate have now completed non-operator sponsor runs. The proof notes live in [`EXTERNAL_SPONSOR_PROOF.md`](EXTERNAL_SPONSOR_PROOF.md).

Allowed claim:

> Non-operator sponsors put their own Arc USDC behind Shadow Float V2 agent lines. Agents completed signed spend and repay loops through those externally sponsored reserves, and Forum Tollgate also proved reserve reclaim before reopening a fresh live reserve.

Do not stretch this into a production lending market, a liquidity pool, or mainnet credit claim. It is a testnet proof that the external sponsor primitive works end to end.
