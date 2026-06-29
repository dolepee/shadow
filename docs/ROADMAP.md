# Shadow Roadmap

Shadow's mainnet path is behavior-backed USDC spending lines for autonomous agents on Arc. Float is the primary product: agents can buy approved x402 resources before their own wallet is funded, debt opens onchain, repayment restores capacity, and unsafe spends are blocked before treasury funds move.

Treasury/M1 remains the supporting mandate extension. The live proof shows approved adapters allocating vault-style USDC on ALLOW and moving no funds on BLOCK. The next work is to turn that proof into production-grade treasury custody without weakening the current Float proof path.

## M1 - Float Mainnet Readiness

Goal: harden the current Float loop without redeploying unless a contract issue requires it.

- Keep `ShadowFloat` as the primary judged product path: V2 signed spend, direct provider payment, debt, repay, overspend block, external signed usage, and labeled open debt.
- Keep receipt-derived score verification live and use the autonomous underwriting runner to propose owner-controlled line adjustments from public behavior.
- Keep no-secret verification as a first-class surface: `/api/float?mode=v2`, `/api/float-tools`, and `npm run float:v2-verify-live`.
- Increase real external usage and repayment examples without calling invited builders partners.
- Keep fee mechanics visible as testnet mechanics, not meaningful revenue until mainnet volume exists.

## M2 - Treasury / M1 Hardening

Goal: move the mandate extension from approved-adapter proof to production-grade fund control.

- Move from adapter-enforced checks to a custodial or escrow-release enforcer so ALLOW directly controls fund release.
- Replace the proof sink with a withdrawable/redeemable vault integration before calling it production treasury management.
- Integrate a real Morpho or vault market instead of the current Morpho-style proof adapter.
- Expand bonding from receipt-liveness guarantees to correctness, settlement, and adapter-behavior guarantees.
- Add replay-safe signed action authorization for multi-user adapters, so the account owner explicitly authorizes each action.
- Keep the current public wording scoped to approved adapters until those upgrades are live.

## M3 - Circle Interop Depth

Goal: make Float interoperable with the emerging Arc x402 ecosystem without corrupting the current proof discipline.

- Keep today's judged proof on Arc USDC, x402, and EIP-3009 because those are load-bearing in every current Float draw.
- Build a Gateway-batched x402 settlement resolver that maps a specific Circle Gateway transfer to a bindable onchain settlement artifact.
- Only bind Gateway proofs when the receipt can point to a real Arc settlement tx plus a per-transfer identifier, not an offchain UUID.
- Use independent Gateway-batched sellers as interop tests once the resolver is clean.

## M4 - Capital and Revenue Model

Goal: turn the testnet mechanics into a sustainable mainnet credit product.

- Define who funds Float treasury capacity at scale: operators, protocols, or liquidity providers.
- Add reserve accounting, default policy, and fee distribution that can survive real USDC volume.
- Keep available-capacity reserve checks visible and auditable.
- Grow transaction volume through real x402 provider purchases and repayment cycles, not synthetic volume.

## M5 - Prior Shadow Rails

Goal: keep the older copy-capital receipt system useful without letting it dilute the Float story.

- Preserve the 2,893-receipt copy-capital archive as proof that Shadow's receipt-and-policy primitive predates Float.
- Reuse the receipt/indexing discipline where it helps Float or Treasury/M1.
- Avoid making copy trading the lead product in Float submissions or demos.
