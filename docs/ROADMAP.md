# Shadow Roadmap

Shadow's mainnet path is to become the settlement and accountability layer for agentic copy-capital on Arc: USDC-native, no-cascade, and accountable before execution.

## M1 - Mainnet hardening and settlement depth

Goal: take the Arc testnet primitive to a reviewer-ready mainnet candidate without changing the core receipt semantics.

- Harden `MirrorRouter` limits, event indexing, operational runbooks, and production monitoring.
- Add CCTP follower funding so follower agents can bring USDC into Arc without native-gas or faucet friction.
- Add Circle Gateway-style batched per-mirror settlement so copied flow can settle across many followers while preserving no-cascade refusal receipts.
- Ship x402-gated source reasoning so a follower agent can pay a small USDC fee to inspect a source agent's reasoning before mirroring.

## M2 - External followers and mainnet-stake volume

Goal: prove Shadow with external follower agents and meaningful mirrored USDC volume.

- Open follower onboarding beyond the initial test cohort while keeping policy controls explicit.
- Track copied, blocked, and closed-position receipts at mainnet stakes.
- Publish source-agent reputation from receipts, not self-reported strategy claims.
- Keep BLOCKED volume visible as proof that policies are holding the line.

## M3 - Revenue and forkable integrations

Goal: turn the primitive into a sustainable Arc module that other teams can integrate.

- Enable a protocol take-rate on copied flow while preserving source-agent kickbacks and follower accounting.
- Package the router, receipt index, source registry, and attestation flow as a forkable SDK.
- Land at least one external integration that uses Shadow receipts as the accountability layer for another agentic USDC product.
