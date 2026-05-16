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
        router.followSource(sourceAgent, maxAmountPerIntent, dailyCap, allowedAsset, maxRiskLevel, 10_000);
    }

    function followWithSlippage(
        MirrorRouter router,
        address sourceAgent,
        uint256 maxAmountPerIntent,
        uint256 dailyCap,
        address allowedAsset,
        uint8 maxRiskLevel,
        uint16 minBpsOut
    ) external {
        router.followSource(sourceAgent, maxAmountPerIntent, dailyCap, allowedAsset, maxRiskLevel, minBpsOut);
    }

    function publish(MirrorRouter router, MirrorRouter.TradeIntent calldata intent) external returns (uint256) {
        return router.publishIntent(intent);
    }

    function withdraw(MirrorRouter router, uint256 amount) external {
        router.withdrawUSDC(amount);
    }

    function unfollow(MirrorRouter router, address sourceAgent) external {
        router.unfollowSource(sourceAgent);
    }

    function closePosition(MirrorRouter router, uint256 intentId) external {
        router.closePosition(intentId);
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

        (, uint256 aAmount,,) = router.positions(1, address(followerA));
        (, uint256 bAmount,,) = router.positions(1, address(followerB));
        require(aAmount > 0, "follower A did not open a position");
        require(bAmount == 0, "follower B should be blocked");
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
        (, uint256 firstAssetAmount,,) = router.positions(1, address(followerA));
        source.publish(router, intent);
        (, uint256 secondAssetAmount,,) = router.positions(2, address(followerA));

        require(firstAssetAmount > 0, "first intent should copy");
        require(secondAssetAmount == 0, "second intent should be blocked");
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

    function testAmountTooHighBlocksIntent() public {
        followerA.follow(router, address(source), 1 * USDC, 5 * USDC, address(arceth), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 3 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-amount-too-high")
        });

        source.publish(router, intent);

        require(arceth.balanceOf(address(followerA)) == 0, "oversized intent should not copy");
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "amount too high should not debit");
    }

    function testRiskTooHighBlocksIntent() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 1);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 5,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-risk-too-high")
        });

        source.publish(router, intent);

        require(arceth.balanceOf(address(followerA)) == 0, "risky intent should not copy");
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "risk too high should not debit");
    }

    function testFollowerCapRevertsAtFiftyFirst() public {
        for (uint256 i = 0; i < 50; i++) {
            Actor a = new Actor();
            a.follow(router, address(source), 1 * USDC, 5 * USDC, address(arceth), 3);
        }
        require(router.followerCount(address(source)) == 50, "expected 50 followers");

        Actor extra = new Actor();
        bool reverted = false;
        try extra.follow(router, address(source), 1 * USDC, 5 * USDC, address(arceth), 3) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "51st follower should revert TooManyFollowers");
        require(router.followerCount(address(source)) == 50, "follower count should cap at 50");
    }

    function testFollowerSlippageBlocksStrictAllowsLenient() public {
        // AMM: 10_000 USDC / 100 ARCETH, 30bps fee.
        // Quote for 1 USDC ≈ 9.97e15 ARCETH (~0.00997).
        // Source publishes intent.minAmountOut = 0.01e18 (tighter than current quote).
        followerA.followWithSlippage(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3, 10_000);
        followerB.followWithSlippage(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3, 9_000);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 0.01e18,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-tight-source-bound")
        });

        source.publish(router, intent);

        (, uint256 aAmount,,) = router.positions(1, address(followerA));
        (, uint256 bAmount,,) = router.positions(1, address(followerB));
        require(aAmount == 0, "strict follower should block on slippage");
        require(bAmount > 0, "lenient follower should copy under slippage tolerance");
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "strict follower USDC should remain");
        require(
            router.followerBalanceUSDC(address(followerB)) == (4 * USDC) - MIRROR_FEE,
            "lenient follower USDC not deducted"
        );
    }

    function testMinBpsOutTooHighReverts() public {
        Actor a = new Actor();
        bool reverted = false;
        try a.followWithSlippage(router, address(source), 1 * USDC, 5 * USDC, address(arceth), 3, 10_001) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "minBpsOut > BPS should revert");
    }

    function testWithdrawReducesBalanceAndRefundsUSDC() public {
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "setup balance");
        require(usdc.balanceOf(address(followerA)) == 0, "setup wallet drained");

        followerA.withdraw(router, 3 * USDC);

        require(router.followerBalanceUSDC(address(followerA)) == 2 * USDC, "router balance not debited");
        require(usdc.balanceOf(address(followerA)) == 3 * USDC, "USDC not refunded to wallet");
    }

    function testWithdrawRevertsOverBalance() public {
        bool reverted = false;
        try followerA.withdraw(router, 10 * USDC) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "over-balance withdraw should revert");
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "balance unchanged on revert");
    }

    function testWithdrawZeroReverts() public {
        bool reverted = false;
        try followerA.withdraw(router, 0) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "zero withdraw should revert");
    }

    function testUnfollowDeactivatesPolicy() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);
        (, , , , , , , bool activeBefore) = router.getPolicy(address(followerA), address(source));
        require(activeBefore, "should be active after follow");

        followerA.unfollow(router, address(source));

        (, , , , , , , bool activeAfter) = router.getPolicy(address(followerA), address(source));
        require(!activeAfter, "should be inactive after unfollow");
    }

    function testUnfollowedFollowerSkippedOnPublishNoReceipt() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);
        followerB.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);
        followerA.unfollow(router, address(source));

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("post-unfollow-intent")
        });

        source.publish(router, intent);

        (, uint256 aAmount,,) = router.positions(1, address(followerA));
        (, uint256 bAmount,,) = router.positions(1, address(followerB));
        require(router.followerBalanceUSDC(address(followerA)) == 5 * USDC, "unfollowed wallet must not be debited");
        require(aAmount == 0, "unfollowed wallet must not open position");
        require(bAmount > 0, "still-following wallet should copy");
    }

    function testUnfollowWhenNotFollowingReverts() public {
        bool reverted = false;
        try followerA.unfollow(router, address(source)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "unfollow without prior follow should revert");
    }

    function testRefollowReactivatesWithoutDuplicateSlot() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);
        followerA.unfollow(router, address(source));
        require(router.followerCount(address(source)) == 1, "follower count after unfollow");

        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);
        require(router.followerCount(address(source)) == 1, "refollow must not duplicate slot");

        (, , , , , , , bool active) = router.getPolicy(address(followerA), address(source));
        require(active, "refollow should reactivate policy");

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("refollow-intent")
        });

        source.publish(router, intent);
        (, uint256 aAmount,,) = router.positions(1, address(followerA));
        require(aAmount > 0, "refollowed follower should copy");
    }

    function testClosePositionRealizesUSDCAndPnL() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-close-test")
        });

        source.publish(router, intent);
        (uint256 usdcIn, uint256 assetAmount, , bool closedBefore) = router.positions(1, address(followerA));
        require(usdcIn == 1 * USDC, "position usdcIn recorded");
        require(assetAmount > 0, "position asset recorded");
        require(!closedBefore, "position should be open");

        uint256 balanceBefore = router.followerBalanceUSDC(address(followerA));
        followerA.closePosition(router, 1);

        (, , , bool closedAfter) = router.positions(1, address(followerA));
        require(closedAfter, "position should be marked closed");
        uint256 balanceAfter = router.followerBalanceUSDC(address(followerA));
        require(balanceAfter > balanceBefore, "close should credit USDC to follower router balance");
        // Round-trip through 30bps fee both ways means net usdcOut < usdcIn — PnL bps should be negative.
        require(balanceAfter - balanceBefore < usdcIn, "round-trip should net less than usdcIn");
    }

    function testCloseAlreadyClosedReverts() public {
        followerA.follow(router, address(source), 2 * USDC, 5 * USDC, address(arceth), 3);

        MirrorRouter.TradeIntent memory intent = MirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("cat-arb-double-close")
        });

        source.publish(router, intent);
        followerA.closePosition(router, 1);

        bool reverted = false;
        try followerA.closePosition(router, 1) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "second close should revert PositionNotOpen");
    }

    function testCloseNonExistentReverts() public {
        bool reverted = false;
        try followerA.closePosition(router, 99) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "closing non-existent position should revert");
    }
}
