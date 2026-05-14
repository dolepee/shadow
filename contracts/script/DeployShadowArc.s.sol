// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowAMM} from "../src/ShadowAMM.sol";
import {SourceRegistry} from "../src/SourceRegistry.sol";
import {MirrorRouter} from "../src/MirrorRouter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract DeployShadowArc is Script {
    uint256 constant ARCETH = 1e18;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address arcUsdc = vm.envAddress("ARC_USDC");
        uint256 seedUsdcAmount = vm.envUint("SEED_USDC_AMOUNT");
        uint256 seedArcethAmount = vm.envUint("SEED_ARCETH_AMOUNT");

        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);

        MockAsset arceth = new MockAsset("Arc Test ETH", "ARCETH", 18);
        ShadowAMM amm = new ShadowAMM(arcUsdc, address(arceth));
        SourceRegistry registry = new SourceRegistry();
        new MirrorRouter(arcUsdc, address(amm), address(registry));

        arceth.mint(deployer, seedArcethAmount);
        IERC20(arcUsdc).approve(address(amm), seedUsdcAmount);
        arceth.approve(address(amm), seedArcethAmount);
        amm.addLiquidity(seedUsdcAmount, seedArcethAmount);

        vm.stopBroadcast();
    }
}

