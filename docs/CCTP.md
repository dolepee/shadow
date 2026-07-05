# CCTP: Cross-Chain USDC That Funds a Live Float Line

Circle CCTP V2 is load-bearing in Shadow, not a footnote. A dollar burned on Ethereum
Sepolia was minted natively on Arc and now backs a live Float sponsored credit line that an
agent drew against and repaid in full. Remove the CCTP hop and that reserve does not exist on
Arc. This page documents the end-to-end chain plus the self-serve acknowledgement route
followers can use to fund their own mirrors from any supported chain.

## Load-bearing proof (Jul 5, 2026)

USDC provably traveled Ethereum Sepolia -> Arc via Circle CCTP V2, became a Float sponsored
reserve, was drawn by an autonomous agent to pay a provider, and was repaid. Every hop is a
real transaction.

| Step | Chain | Tx | Effect |
| --- | --- | --- | --- |
| 1. Burn | Ethereum Sepolia | [`0x05c3731e…f74c69`](https://sepolia.etherscan.io/tx/0x05c3731ef37af9748a9e1a700902cddda717c4e85016c2fbabdc3e07f3f74c69) | Burns 1 USDC via TokenMessengerV2, destination domain `26` (Arc), recipient `0xBDb1…1Fb8` |
| 2. Attest | Circle Iris | `GET /v2/messages/0?transactionHash=0x05c3731e…` | Returns `status: complete` with the signed message |
| 3. Mint | Arc testnet | [`0xca5825f8…a18a82`](https://explorer.testnet.arc.network/tx/0xca5825f86fc178cb2cd21d41bc4ace4e958eaad0f0a363c7715007b577a18a82) | `receiveMessage` on MessageTransmitterV2 mints 999900 atomic USDC to `0xBDb1…1Fb8` (100 atomic fast-transfer fee) |
| 4. Open line | Arc testnet | [`0x8c3a5781…3631fe`](https://explorer.testnet.arc.network/tx/0x8c3a5781517c8c0f8c8d0c2e88791e17fca509fecaf78fb8cbcfb6cf013631fe) | `openSponsoredLine` locks 0.9 USDC of the minted dollar as reserve for agent `0xec28…76A8`, provider CitePay |
| 5. Draw | Arc testnet | [`0xa5dee9bb…2fba24`](https://explorer.testnet.arc.network/tx/0xa5dee9bb7424e0f2f4eccf13a0a2a2f32a617a227b18c1a242307bbdd92fba24) | Agent signs an EIP-712 spend intent; `requestSignedSpend` pays CitePay 0.001 USDC from the bridged reserve |
| 6. Repay | Arc testnet | [`0x41e203d3…a79f99c`](https://explorer.testnet.arc.network/tx/0x41e203d38209441761647f9c81ed1660eff7d4a6467089a7aaac58259a79f99c) | `repay` clears the 0.001 debt (approval [`0x282430bc…`](https://explorer.testnet.arc.network/tx/0x282430bc633626ffced8a05f721f669b92586d4bdc7e71b98ee99e9944307d32)); line status -> `REPAID` |

After the clean loop the line reads: behavior score `7500 -> 8250`, credit limit `0.025 ->
0.05 USDC` (score crossed the 8000 tier), active debt `0`, status `REPAID`. The autonomous
underwriting rewarded the on-time repayment by growing the limit toward the reserve cap. This
is the whole thesis in six transactions: cross-chain capital arrives, gets underwritten, does
work, and settles.

### Addresses

| Role | Address |
| --- | --- |
| Source burn signer (Sepolia) | `0x8942F989343e4Ce8e4c8c0D7C648a6953ff3A5A2` |
| Mint recipient / sponsor / executor (Arc) | `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8` |
| CCTP-funded agent line | `0xec28bfA6f4BcFf23933E21B7AbfB6D53287976A8` |
| MessageTransmitterV2 (both chains) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| TokenMessengerV2 (both chains) | `0x8FE6B999DC680CcFDD5Bf7EB0974218be2542DAA` |
| ShadowFloat V2 (Arc) | `0x20dcA96B0C487D94De885c726c956ffaF38b12C2` |
| USDC (Arc) | `0x3600000000000000000000000000000000000000` |
| CitePay provider | `0x5389688243328c26a92b301faEEAb5fbf9AFf105` |

Anyone can re-verify the attestation for the burn without any Shadow secret:

```bash
curl -sS "https://iris-api-sandbox.circle.com/v2/messages/0?transactionHash=0x05c3731ef37af9748a9e1a700902cddda717c4e85016c2fbabdc3e07f3f74c69" | python3 -m json.tool
```

## Self-serve acknowledgement route

Beyond the executed chain above, `/api/cctp-funding` lets a follower prove a burn from any
supported source chain so Shadow can acknowledge their funding intent before the mint lands.
It verifies the Circle attestation and records an acknowledgement; it deliberately returns
`credited: false` because acknowledgement is not the same as an executed Arc mint plus router
deposit. `app/scripts/cctp-verify.mjs` gives reviewers a one-command check.

### Flow

1. A follower burns USDC on a supported source testnet.
2. The reviewer calls `/api/cctp-funding` with `burnTx`, `sourceDomain`, and optionally
   `follower` plus `expectedAmountAtomic`.
3. Shadow queries Circle Iris for the burn attestation.
4. If the attestation is complete, Shadow records that the follower funding path is verified.
5. A worker (or the manual chain above) executes the Arc mint and credits the follower.

### Env

Required for live acknowledgement:

- `CCTP_ATTESTATION_API_URL`, default `https://iris-api-sandbox.circle.com`

Optional persistence:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

Script inputs:

- `CCTP_BURN_TX`
- `CCTP_SOURCE_DOMAIN`
- `CCTP_FOLLOWER`
- `CCTP_EXPECTED_AMOUNT_ATOMIC`
- `SHADOW_APP_URL`

### Run

```bash
cd app
CCTP_BURN_TX=0x... CCTP_SOURCE_DOMAIN=0 CCTP_FOLLOWER=0x... CCTP_EXPECTED_AMOUNT_ATOMIC=1000000 pnpm cctp:verify
```

Equivalent direct API call:

```bash
curl -sS https://shadow-arc.vercel.app/api/cctp-funding \
  -H 'content-type: application/json' \
  -d '{"burnTx":"0x...","sourceDomain":0,"follower":"0x...","expectedAmountAtomic":"1000000"}'
```

The route is honest by construction:

- `acknowledged: true` only when Circle returns a complete attestation.
- `credited: false` until an Arc mint/deposit actually credits the follower in Shadow.
- Public errors are sanitized and do not echo raw upstream responses or tokens.

## References

- Circle CCTP Iris attestation API: `GET /v2/messages/{sourceDomain}?transactionHash={burnTx}`
- CCTP V2 testnet contracts (same address across chains): MessageTransmitterV2
  `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`, TokenMessengerV2
  `0x8FE6B999DC680CcFDD5Bf7EB0974218be2542DAA`
- Gateway domain used for Arc testnet in the Circle sample: `26`
