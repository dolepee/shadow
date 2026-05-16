// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowAMM} from "../src/ShadowAMM.sol";
import {MirrorRouter} from "../src/MirrorRouter.sol";

// Deploys ShadowAMM v2 (with reverse swap) and MirrorRouter v4 (with positions + close)
// against the existing SourceRegistry. Mints ARCETH to the deployer.
// Liquidity seeding runs off-script via agent/src/seed-v4-amm.ts: the Arc USDC
// precompile's isBlocklisted check StackUnderflows during forge simulation, so the
// transferFrom path must be sent with explicit gas (200_000) from viem.
//
// Required env:
//   PRIVATE_KEY            deployer that already owns ARCETH mint rights
//   ARC_USDC               existing arc USDC precompile address
//   SHADOW_ARCETH          existing ARCETH mock asset address (so we mint into the same token)
//   SHADOW_REGISTRY        existing SourceRegistry address (reused, sources stay registered)
//   SEED_ARCETH_AMOUNT     ARCETH units to mint to deployer (18-decimal raw)
contract DeployV4 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address arcUsdc = vm.envAddress("ARC_USDC");
        address arcethAddr = vm.envAddress("SHADOW_ARCETH");
        address registry = vm.envAddress("SHADOW_REGISTRY");
        uint256 mintArceth = vm.envUint("SEED_ARCETH_AMOUNT");

        vm.startBroadcast(deployerKey);

        ShadowAMM amm = new ShadowAMM(arcUsdc, arcethAddr);
        new MirrorRouter(arcUsdc, address(amm), registry);

        MockAsset(arcethAddr).mint(vm.addr(deployerKey), mintArceth);

        vm.stopBroadcast();
    }
}
