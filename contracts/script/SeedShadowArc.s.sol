// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {SourceRegistry} from "../src/SourceRegistry.sol";
import {MirrorRouter} from "../src/MirrorRouter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract SeedShadowArc is Script {
    uint256 constant USDC = 1e6;
    uint256 constant NATIVE_GAS_STIPEND = 0.05 ether;
    address constant ERC8004_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 catKey = vm.envUint("CAT_AGENT_PRIVATE_KEY");
        uint256 lobsterKey = vm.envUint("LOBSTER_AGENT_PRIVATE_KEY");
        uint256 followerAKey = vm.envUint("FOLLOWER_A_PRIVATE_KEY");
        uint256 followerBKey = vm.envUint("FOLLOWER_B_PRIVATE_KEY");

        address usdc = vm.envAddress("ARC_USDC");
        address arceth = vm.envAddress("SHADOW_ARCETH");
        address registryAddress = vm.envAddress("SHADOW_REGISTRY");
        address routerAddress = vm.envAddress("SHADOW_ROUTER");

        _registerAndFund(deployerKey, catKey, lobsterKey, followerAKey, followerBKey, usdc, registryAddress);
        _setupFollower(followerAKey, catKey, usdc, arceth, routerAddress, 2 * USDC);
        _setupFollower(followerBKey, catKey, usdc, arceth, routerAddress, 500_000);
        _publishDemoIntent(catKey, arceth, routerAddress);
    }

    function _registerAndFund(
        uint256 deployerKey,
        uint256 catKey,
        uint256 lobsterKey,
        uint256 followerAKey,
        uint256 followerBKey,
        address usdc,
        address registryAddress
    ) internal {
        SourceRegistry registry = SourceRegistry(registryAddress);
        address cat = vm.addr(catKey);
        address lobster = vm.addr(lobsterKey);
        address followerA = vm.addr(followerAKey);
        address followerB = vm.addr(followerBKey);

        vm.startBroadcast(deployerKey);
        registry.registerSource(cat, "CatArb", "ipfs://shadow/cat-arb", 7_600, ERC8004_IDENTITY_REGISTRY, 1);
        registry.registerSource(lobster, "LobsterRisk", "ipfs://shadow/lobster-risk", 6_200, ERC8004_IDENTITY_REGISTRY, 2);

        payable(cat).transfer(NATIVE_GAS_STIPEND);
        payable(lobster).transfer(NATIVE_GAS_STIPEND);
        payable(followerA).transfer(NATIVE_GAS_STIPEND);
        payable(followerB).transfer(NATIVE_GAS_STIPEND);

        require(IERC20(usdc).transfer(followerA, 2 * USDC), "FUND_A_FAILED");
        require(IERC20(usdc).transfer(followerB, 2 * USDC), "FUND_B_FAILED");
        vm.stopBroadcast();
    }

    function _setupFollower(
        uint256 followerKey,
        uint256 catKey,
        address usdc,
        address arceth,
        address routerAddress,
        uint256 maxAmountPerIntent
    ) internal {
        MirrorRouter router = MirrorRouter(routerAddress);
        vm.startBroadcast(followerKey);
        IERC20(usdc).approve(routerAddress, type(uint256).max);
        router.depositUSDC(2 * USDC);
        router.followSource(vm.addr(catKey), maxAmountPerIntent, 2 * USDC, arceth, 3);
        vm.stopBroadcast();
    }

    function _publishDemoIntent(uint256 catKey, address arceth, address routerAddress) internal {
        MirrorRouter router = MirrorRouter(routerAddress);
        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: arceth,
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 days,
            intentHash: keccak256("cat-arb-demo-intent-1")
        });

        vm.startBroadcast(catKey);
        router.publishIntent(intent);
        vm.stopBroadcast();
    }
}
