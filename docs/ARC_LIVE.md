# Shadow Arc Testnet Deployment

Chain: Arc Testnet, chain id `5042002`

## Contracts

- ARCETH mock asset: `0xD5690B00aDE1eF88f9906a535AB5cf2E6Bca371a`
- ShadowAMM: `0xAF31AfF4d6fF8538d0Cd0bB8F919c8D589CF8D6D`
- SourceRegistry: `0x9741C71dCb83fc0b2C4eb1C14c1eA46d8BCB5A90`
- MirrorRouter: `0x5B4e94297C583ac7eE94Df38760f530D1414A7E7`
- Arc USDC: `0x3600000000000000000000000000000000000000`

## Seeded Agents

- CatArb: `0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8`
- LobsterRisk: `0xFF3BDb60E16538333C9A290BB80bE52b3b82D2f3`

Both agents store ERC-8004 style identity references to the Arc testnet identity registry:

```text
0x8004A818BFB912233c491871b3d84c89A494BD9e
```

## Live Receipts

First CatArb intent transaction:

```text
0x3c223ceb58dd46ef5250143c739c1e45a5619f26609133d6cace4e4672e5f9df
```

Observed state after the first intent:

- Follower A ARCETH balance: `166249791562447890`
- Follower B ARCETH balance: `0`
- Follower A router USDC balance: `499000`
- Follower B router USDC balance: `1000000`
- CatArb source kickback: `700`

Interpretation: the same source intent copied for Follower A and blocked for Follower B.
