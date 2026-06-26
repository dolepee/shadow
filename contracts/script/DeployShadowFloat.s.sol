// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {ShadowFloat} from "../src/ShadowFloat.sol";

// Deploys the Shadow Float permissionless signed-intent surface.
//
// Required env:
//   PRIVATE_KEY  deployer and initial owner/operator
//   ARC_USDC     Arc testnet USDC token address
contract DeployShadowFloat is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address arcUsdc = vm.envAddress("ARC_USDC");

        vm.startBroadcast(deployerKey);
        new ShadowFloat(arcUsdc);
        vm.stopBroadcast();
    }
}
