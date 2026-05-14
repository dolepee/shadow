// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {ShadowAMM} from "../src/ShadowAMM.sol";
import {SourceRegistry} from "../src/SourceRegistry.sol";
import {MirrorRouter} from "../src/MirrorRouter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract Actor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function deposit(MirrorRouter router, uint256 amount) external {
        router.depositUSDC(amount);
    }

    function follow(
        MirrorRouter router,
        address sourceAgent,
        uint256 maxAmountPerIntent,
        uint256 dailyCap,
        address allowedAsset,
        uint8 maxRiskLevel
    ) external {
        router.followSource(sourceAgent, maxAmountPerIntent, dailyCap, allowedAsset, maxRiskLevel);
    }

    function publish(MirrorRouter router, MirrorRouter.TradeIntent calldata intent) external returns (uint256) {
        return router.publishIntent(intent);
    }
}

contract ShadowFlowTest {
    uint256 constant USDC = 1e6;
    uint256 constant ARCETH = 1e18;
    uint256 constant MIRROR_FEE = 1_000;

    MockAsset usdc;
    MockAsset arceth;
    MockAsset arcbtc;
    ShadowAMM amm;
    SourceRegistry registry;
    MirrorRouter router;

    Actor source;
    Actor followerA;
    Actor followerB;

    function setUp() public {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        arceth = new MockAsset("Arc Test ETH", "ARCETH", 18);
        arcbtc = new MockAsset("Arc Test BTC", "ARCBTC", 18);
        amm = new ShadowAMM(address(usdc), address(arceth));
        registry = new SourceRegistry();
        router = new MirrorRouter(address(usdc), address(amm), address(registry));

        source = new Actor();
        followerA = new Actor();
        followerB = new Actor();

        registry.registerSource(
            address(source),
            "CatArb",
            "ipfs://cat-arb",
            7_600,
            0x8004A818BFB912233c491871b3d84c89A494BD9e,
            1
        );

        usdc.mint(address(this), 1_000_000 * USDC);
        arceth.mint(address(this), 1_000 * ARCETH);
        usdc.approve(address(amm), type(uint256).max);
        arceth.approve(address(amm), type(uint256).max);
        amm.addLiquidity(10_000 * USDC, 100 * ARCETH);

        usdc.mint(address(followerA), 5 * USDC);
        usdc.mint(address(followerB), 5 * USDC);

        followerA.approveToken(address(usdc), address(router), type(uint256).max);
        followerB.approveToken(address(usdc), address(router), type(uint256).max);
        followerA.deposit(router, 5 * USDC);
        followerB.deposit(router, 5 * USDC);
    }

    function testOneIntentCopiesAndBlocksFollowers() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);
        followerB.follow(router, address(source), 500_000, 5 * USDC, address(arceth), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-long-arceth")
        });

        source.publish(router, intent);

        require(arceth.balanceOf(address(followerA)) > 0, "follower A did not receive ARCETH");
        require(arceth.balanceOf(address(followerB)) == 0, "follower B should be blocked");
        require(router.followerBalanceUSDC(address(followerA)) == (4 * USDC) - MIRROR_FEE, "follower A USDC not deducted");
        require(router.followerBalanceUSDC(address(followerB)) == 5 * USDC, "follower B USDC should remain");
        require(router.sourceKickbackUSDC(address(source)) == 700, "source kickback not accrued");
        require(router.protocolFeesUSDC() == 300, "protocol fee not accrued");
    }

    function testAssetPolicyBlocksUnsupportedAsset() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arcbtc), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arcbtc),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-long-arcbtc")
        });

        source.publish(router, intent);

        require(arceth.balanceOf(address(followerA)) == 0, "unsupported asset should not swap");
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "blocked USDC should remain");
    }

    function testDailyCapBlocksSecondIntent() public {
        followerA.follow(router, address(source), 2 * USDC, 1 * USDC, address(arceth), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-long-arceth")
        });

        source.publish(router, intent);
        uint256 firstAssetBalance = arceth.balanceOf(address(followerA));
        source.publish(router, intent);

        require(firstAssetBalance > 0, "first intent should copy");
        require(arceth.balanceOf(address(followerA)) == firstAssetBalance, "second intent should be blocked");
        require(router.followerBalanceUSDC(address(followerA)) == (4 * USDC) - MIRROR_FEE, "only first intent should deduct");
    }

    function testMirrorFeeCanBlockInsufficientBalance() public {
        followerA.follow(router, address(source), 5 * USDC, 5 * USDC, address(arceth), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 5 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-long-arceth-too-large-after-fee")
        });

        source.publish(router, intent);

        require(arceth.balanceOf(address(followerA)) == 0, "intent should not copy without fee balance");
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "blocked USDC should remain");
    }

    function testExpiredIntentBlocksBeforeSwap() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: 0,
            intentHash: keccak256("cat-arb-expired-intent")
        });

        source.publish(router, intent);

        require(arceth.balanceOf(address(followerA)) == 0, "expired intent should not copy");
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "expired intent should not debit");
    }
}
