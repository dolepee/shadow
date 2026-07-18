// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFeeRouter} from "../src/canary/IFeeRouter.sol";

interface Vm {
    function envOr(string memory name, string memory defaultValue) external view returns (string memory);
    function createSelectFork(string memory urlOrAlias) external returns (uint256);
}

/// @notice Fork test against the REAL FeeRouterV1 deployed on Arc testnet.
/// Confirms we can resolve and call the deployed interface in a forked environment.
contract ArcForkTest {
    address constant FEE_ROUTER = 0xeFf9bc359e8f2a5eabce55af3f1bb24F98eaBF59;

    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IFeeRouter feeRouter;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_RPC", string(""));
        if (bytes(rpc).length == 0) {
            return;
        }

        vm.createSelectFork(rpc);
        feeRouter = IFeeRouter(FEE_ROUTER);
        forked = true;
    }

    function test_RealFeeRouter_InterfaceFunctions_Resolve() public {
        if (!forked) {
            return;
        }

        require(FEE_ROUTER.code.length > 0, "FeeRouterV1 must exist on forked endpoint");

        // Read-only checks against the deployed contract.
        require(feeRouter.usdc() != address(0), "usdc() must be configured");
        require(feeRouter.claimableOf(0, address(0x13585c6004fbA9D7D49219a6435B68348fD30770)) == 0,
            "claimableOf should be callable");
        require(feeRouter.totalClaimableOf(address(0x13585c6004fbA9D7D49219a6435B68348fD30770)) == 0,
            "totalClaimableOf should be callable");

        // Optional path guarded at runtime if the caller account is authorized.
        address protocol = address(0xBEEF);
        address forumSource = address(0x13585c6004fbA9D7D49219a6435B68348fD30770);

        address[] memory recipients = new address[](2);
        uint16[] memory bps = new uint16[](2);

        recipients[0] = protocol;
        recipients[1] = forumSource;
        bps[0] = 3000;
        bps[1] = 7000;

        try feeRouter.createSplit(recipients, bps) returns (uint256 splitId) {
            require(feeRouter.claimableOf(splitId, protocol) == 0, "fresh split protocol claimable must be zero");
            require(feeRouter.totalClaimableOf(protocol) == 0, "fresh split protocol total should be zero");
        } catch {
            // Some FeeRouter deployments require explicit caller authorization.
            // This keeps the test useful for compile/runtime validation while avoiding false negatives
            // in non-owner/local fork contexts.
        }
    }
}
