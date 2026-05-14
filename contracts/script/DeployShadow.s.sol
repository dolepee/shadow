// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowAMM} from "../src/ShadowAMM.sol";
import {SourceRegistry} from "../src/SourceRegistry.sol";
import {MirrorRouter} from "../src/MirrorRouter.sol";

contract DeployShadow is Script {
    uint256 constant USDC = 1e6;
    uint256 constant ARCETH = 1e18;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);

        MockAsset usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        MockAsset arceth = new MockAsset("Arc Test ETH", "ARCETH", 18);
        ShadowAMM amm = new ShadowAMM(address(usdc), address(arceth));
        SourceRegistry registry = new SourceRegistry();
        new MirrorRouter(address(usdc), address(amm), address(registry));

        usdc.mint(deployer, 1_000_000 * USDC);
        arceth.mint(deployer, 1_000 * ARCETH);

        usdc.approve(address(amm), 10_000 * USDC);
        arceth.approve(address(amm), 100 * ARCETH);
        amm.addLiquidity(10_000 * USDC, 100 * ARCETH);

        vm.stopBroadcast();
    }
}
