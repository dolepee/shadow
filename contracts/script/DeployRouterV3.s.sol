// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {MirrorRouter} from "../src/MirrorRouter.sol";

contract DeployRouterV3 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address arcUsdc = vm.envAddress("ARC_USDC");
        address amm = vm.envAddress("SHADOW_AMM");
        address registry = vm.envAddress("SHADOW_REGISTRY");

        vm.startBroadcast(deployerKey);
        new MirrorRouter(arcUsdc, amm, registry);
        vm.stopBroadcast();
    }
}
