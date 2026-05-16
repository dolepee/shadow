// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowAMM} from "../src/ShadowAMM.sol";
import {MirrorRouter} from "../src/MirrorRouter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

// Deploys ShadowAMM v2 (with reverse swap) and MirrorRouter v4 (with positions + close)
// against the existing SourceRegistry. Seeds the new AMM with USDC + ARCETH liquidity.
//
// Required env:
//   PRIVATE_KEY            deployer that already owns ARCETH mint rights
//   ARC_USDC               existing arc USDC precompile address
//   SHADOW_ARCETH          existing ARCETH mock asset address (so we mint into the same token)
//   SHADOW_REGISTRY        existing SourceRegistry address (reused, sources stay registered)
//   SEED_USDC_AMOUNT       USDC units to seed (6-decimal raw, e.g. 10000000 for 10 USDC)
//   SEED_ARCETH_AMOUNT     ARCETH units to seed (18-decimal raw)
contract DeployV4 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address arcUsdc = vm.envAddress("ARC_USDC");
        address arcethAddr = vm.envAddress("SHADOW_ARCETH");
        address registry = vm.envAddress("SHADOW_REGISTRY");
        uint256 seedUsdc = vm.envUint("SEED_USDC_AMOUNT");
        uint256 seedArceth = vm.envUint("SEED_ARCETH_AMOUNT");

        vm.startBroadcast(deployerKey);

        ShadowAMM amm = new ShadowAMM(arcUsdc, arcethAddr);
        new MirrorRouter(arcUsdc, address(amm), registry);

        MockAsset(arcethAddr).mint(vm.addr(deployerKey), seedArceth);

        IERC20(arcUsdc).approve(address(amm), seedUsdc);
        IERC20(arcethAddr).approve(address(amm), seedArceth);
        amm.addLiquidity(seedUsdc, seedArceth);

        vm.stopBroadcast();
    }
}
