// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowAMM} from "../src/ShadowAMM.sol";
import {SourceRegistry} from "../src/SourceRegistry.sol";
import {CanaryMirrorRouter} from "../src/canary/CanaryMirrorRouter.sol";
import {MirrorFeeSplitter} from "../src/canary/MirrorFeeSplitter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Deploys an isolated Forum-only canary stack on Arc testnet.
/// Existing Shadow registry, AMM, router, and liquidity are not reused.
/// External FeeRouter routing remains disabled after deployment.
contract DeployForumCanary is Script {
    uint256 constant SEED_USDC = 250_000; // 0.25 USDC
    uint256 constant SEED_ASSET = 1 ether;
    uint256 constant FOLLOWER_DEPOSIT_USDC = 20_000; // 0.02 USDC
    uint256 constant MAX_AMOUNT_PER_INTENT = 10_000; // 0.01 USDC
    uint256 constant DAILY_CAP = 10_000; // exactly one canary copy
    uint256 constant FOLLOWER_GAS_STIPEND = 0.01 ether;
    uint8 constant MAX_RISK_LEVEL = 1;
    uint16 constant MIN_BPS_OUT = 9_000;
    address constant ERC8004_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 followerKey = vm.envUint("FORUM_CANARY_FOLLOWER_PRIVATE_KEY");
        address arcUsdc = vm.envAddress("ARC_USDC");
        address feeRouter = vm.envAddress("FORUM_FEE_ROUTER");
        address forumSource = vm.envAddress("FORUM_SOURCE");
        address forumPayout = vm.envAddress("FORUM_PAYOUT");

        address deployer = vm.addr(deployerKey);
        address follower = vm.addr(followerKey);
        require(deployer != follower, "CANARY_FOLLOWER_MUST_BE_DISTINCT");
        require(follower != forumSource && follower != forumPayout, "FOLLOWER_MUST_NOT_BE_FORUM");
        require(deployer.balance >= FOLLOWER_GAS_STIPEND, "INSUFFICIENT_CANARY_GAS");
        require(IERC20(arcUsdc).balanceOf(deployer) >= SEED_USDC + FOLLOWER_DEPOSIT_USDC, "INSUFFICIENT_CANARY_USDC");

        vm.startBroadcast(deployerKey);

        MockAsset asset = new MockAsset("Forum Canary Asset", "FCAN", 18);
        ShadowAMM amm = new ShadowAMM(arcUsdc, address(asset));
        SourceRegistry registry = new SourceRegistry();
        MirrorFeeSplitter splitter = new MirrorFeeSplitter(arcUsdc, feeRouter, deployer, forumSource, forumPayout);
        CanaryMirrorRouter router = new CanaryMirrorRouter(arcUsdc, address(amm), address(registry), address(splitter));

        splitter.setAuthorizedRouter(address(router));
        splitter.preconfigureSplit();
        registry.registerSource(
            forumSource, "Forum", "ipfs://shadow/forum-feerouter-canary", 7_600, ERC8004_IDENTITY_REGISTRY, 0
        );

        asset.mint(deployer, SEED_ASSET);
        IERC20(arcUsdc).approve(address(amm), SEED_USDC);
        asset.approve(address(amm), SEED_ASSET);
        amm.addLiquidity(SEED_USDC, SEED_ASSET);

        require(IERC20(arcUsdc).transfer(follower, FOLLOWER_DEPOSIT_USDC), "FOLLOWER_USDC_FUNDING_FAILED");
        payable(follower).transfer(FOLLOWER_GAS_STIPEND);
        vm.stopBroadcast();

        vm.startBroadcast(followerKey);
        IERC20(arcUsdc).approve(address(router), FOLLOWER_DEPOSIT_USDC);
        router.depositUSDC(FOLLOWER_DEPOSIT_USDC);
        router.followSource(forumSource, MAX_AMOUNT_PER_INTENT, DAILY_CAP, address(asset), MAX_RISK_LEVEL, MIN_BPS_OUT);
        vm.stopBroadcast();

        require(!splitter.externalRoutingEnabled(), "ROUTING_MUST_START_DISABLED");
        require(registry.isRegistered(forumSource), "FORUM_NOT_REGISTERED");
        require(router.isFollowing(follower, forumSource), "FOLLOWER_NOT_CONFIGURED");
    }
}
