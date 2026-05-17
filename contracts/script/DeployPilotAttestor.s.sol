// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {PilotAttestor} from "../src/PilotAttestor.sol";

contract DeployPilotAttestor is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        new PilotAttestor();
        vm.stopBroadcast();
    }
}
