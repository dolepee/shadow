// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BondedMandateEnforcer} from "../src/BondedMandateEnforcer.sol";
import {MandateAttestor} from "../src/MandateAttestor.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MandateVaultSink} from "../src/MandateVaultSink.sol";
import {MorphoStyleVaultAdapter} from "../src/MorphoStyleVaultAdapter.sol";
import {Script} from "../src/Script.sol";
import {V4StyleArcAdapter} from "../src/V4StyleArcAdapter.sol";

// Deploys the Lepton M1 mandate-enforcement surface:
// MandateRegistry -> MandateAttestor -> BondedMandateEnforcer -> protocol adapters.
//
// Required env:
//   PRIVATE_KEY                  deployer and owner for registry/attestor recorder setup
//   ARC_RPC_URL                  Arc RPC endpoint passed to forge with --rpc-url
//   ARC_USDC                     Arc USDC token address
//   LEPTON_MIN_BOND_USDC         minimum enforcer bond in raw USDC units
contract DeployLeptonM1 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address arcUsdc = vm.envAddress("ARC_USDC");
        uint256 minBondUSDC = vm.envUint("LEPTON_MIN_BOND_USDC");

        vm.startBroadcast(deployerKey);

        MandateRegistry registry = new MandateRegistry(arcUsdc);
        MandateAttestor attestor = new MandateAttestor();
        BondedMandateEnforcer enforcer =
            new BondedMandateEnforcer(arcUsdc, address(registry), address(attestor), minBondUSDC);
        MandateVaultSink v4VaultSink = new MandateVaultSink(arcUsdc);
        V4StyleArcAdapter v4Adapter = new V4StyleArcAdapter(arcUsdc, address(enforcer), address(v4VaultSink));
        MandateVaultSink morphoVaultSink = new MandateVaultSink(arcUsdc);
        MorphoStyleVaultAdapter morphoAdapter = new MorphoStyleVaultAdapter(
            arcUsdc,
            address(enforcer),
            address(morphoVaultSink),
            keccak256("shadow-lepton-morpho-style-usdc-vault-market")
        );

        registry.setRecorder(address(enforcer), true);
        attestor.setRecorder(address(enforcer), true);
        v4VaultSink.setAdapter(address(v4Adapter));
        morphoVaultSink.setAdapter(address(morphoAdapter));

        v4Adapter;
        morphoAdapter;

        vm.stopBroadcast();
    }
}
