// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {ShadowAMM} from "../src/ShadowAMM.sol";
import {SourceRegistry} from "../src/SourceRegistry.sol";
import {CanaryMirrorRouter} from "../src/canary/CanaryMirrorRouter.sol";
import {MirrorFeeSplitter} from "../src/canary/MirrorFeeSplitter.sol";
import {IFeeRouter} from "../src/canary/IFeeRouter.sol";

contract CanaryActor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function deposit(CanaryMirrorRouter router, uint256 amount) external {
        router.depositUSDC(amount);
    }

    function follow(
        CanaryMirrorRouter router,
        address sourceAgent,
        uint256 maxAmountPerIntent,
        uint256 dailyCap,
        address allowedAsset,
        uint8 maxRiskLevel
    ) external {
        router.followSource(sourceAgent, maxAmountPerIntent, dailyCap, allowedAsset, maxRiskLevel, 10_000);
    }

    function publish(CanaryMirrorRouter router, CanaryMirrorRouter.TradeIntent calldata intent) external returns (uint256) {
        return router.publishIntent(intent);
    }

    function settleMirrorFee(MirrorFeeSplitter splitter, address sourceAgent, uint256 mirrorFeeUSDC) external {
        splitter.settleMirrorFee(sourceAgent, mirrorFeeUSDC);
    }

    function claimSourceKickback(MirrorFeeSplitter splitter, address recipient) external {
        splitter.claimSourceKickback(recipient);
    }

    function claimProtocolFees(MirrorFeeSplitter splitter, address recipient) external {
        splitter.claimProtocolFees(recipient);
    }
}

contract MockFeeRouter is IFeeRouter {
    struct Split {
        address creator;
        address[] recipients;
        uint16[] bps;
        uint256 totalRouted;
        uint64 createdAt;
    }

    address public _usdc;
    uint256 public nextSplitId = 1;

    mapping(uint256 => Split) private splits;
    mapping(uint256 => mapping(address => uint256)) public splitClaimable;
    mapping(address => uint256) public outstanding;

    constructor(address usdc_) {
        _usdc = usdc_;
    }

    function usdc() external view returns (address) {
        return _usdc;
    }

    function createSplit(address[] calldata recipients, uint16[] calldata bps)
        external
        returns (uint256 splitId)
    {
        require(recipients.length > 0, "no recipients");
        require(recipients.length == bps.length, "mismatched lengths");
        uint256 totalBps;
        for (uint256 i = 0; i < bps.length; i++) {
            totalBps += bps[i];
        }
        require(totalBps == 10_000, "bad bps");

        splitId = nextSplitId++;
        Split storage split = splits[splitId];
        split.creator = msg.sender;
        split.createdAt = uint64(block.timestamp);
        for (uint256 i = 0; i < recipients.length; i++) {
            split.recipients.push(recipients[i]);
            split.bps.push(bps[i]);
        }
    }

    function pay(uint256 splitId, uint256 amount) external virtual {
        Split storage split = splits[splitId];
        require(split.recipients.length > 0, "split not found");

        split.totalRouted += amount;

        uint256 allocated;
        for (uint256 i = 0; i < split.recipients.length; i++) {
            uint256 share = (amount * split.bps[i]) / 10_000;
            allocated += share;
            splitClaimable[splitId][split.recipients[i]] += share;
            outstanding[split.recipients[i]] += share;
        }

        uint256 dust = amount - allocated;
        if (dust > 0) {
            address dustRecipient = split.recipients[0];
            splitClaimable[splitId][dustRecipient] += dust;
            outstanding[dustRecipient] += dust;
        }
    }

    function claimableOf(uint256 splitId, address recipient) external view returns (uint256) {
        return splitClaimable[splitId][recipient];
    }

    function claim() external returns (uint256 amount) {
        amount = outstanding[msg.sender];
        require(amount > 0, "nothing to claim");
        outstanding[msg.sender] = 0;
        return amount;
    }

    function totalClaimableOf(address recipient) external view returns (uint256) {
        return outstanding[recipient];
    }

    function splitAt(uint256 splitId) external view returns (IFeeRouter.SplitView memory) {
        Split storage split = splits[splitId];
        return IFeeRouter.SplitView({
            creator: split.creator,
            recipients: split.recipients,
            bps: split.bps,
            totalRouted: split.totalRouted,
            createdAt: split.createdAt
        });
    }
}

contract FailingFeeRouter is MockFeeRouter {
    constructor(address usdc_) MockFeeRouter(usdc_) {}

    function pay(uint256, uint256) external override {
        revert("feerouter unavailable");
    }
}

contract CanaryMirrorRouterFeeRouterTest {
    uint256 constant USDC = 1e6;
    uint256 constant ARCETH = 1e18;
    uint16 constant BPS = 10_000;
    uint16 constant MIRROR_FEE_BPS = 10;

    MockAsset public usdc;
    MockAsset public arceth;
    ShadowAMM public amm;
    SourceRegistry public registry;

    MockFeeRouter public feeRouter;
    MirrorFeeSplitter public splitter;
    CanaryMirrorRouter public router;

    CanaryActor public forumSource;
    CanaryActor public rivalSource;
    CanaryActor public follower;

    function _setup(address forumPayout, bool routingEnabled, bool failRouter)
        internal
    {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        arceth = new MockAsset("Arc Test ETH", "ARCETH", 18);

        amm = new ShadowAMM(address(usdc), address(arceth));
        registry = new SourceRegistry();

        forumSource = new CanaryActor();
        rivalSource = new CanaryActor();
        follower = new CanaryActor();

        registry.registerSource(
            address(forumSource),
            "Forum",
            "ipfs://forum",
            7_600,
            0x8004A818BFB912233c491871b3d84c89A494BD9e,
            1
        );
        registry.registerSource(
            address(rivalSource),
            "Rival",
            "ipfs://rival",
            7_500,
            0x8004A818BFB912233c491871b3d84c89A494BD9e,
            2
        );

        usdc.mint(address(this), 1_000_000 * USDC);
        arceth.mint(address(this), 1_000 * ARCETH);
        usdc.approve(address(amm), type(uint256).max);
        arceth.approve(address(amm), type(uint256).max);
        amm.addLiquidity(10_000 * USDC, 100 * ARCETH);

        if (failRouter) {
            feeRouter = new FailingFeeRouter(address(usdc));
        } else {
            feeRouter = new MockFeeRouter(address(usdc));
        }
        splitter = new MirrorFeeSplitter(address(usdc), address(feeRouter), address(this), address(forumSource), forumPayout);
        router = new CanaryMirrorRouter(address(usdc), address(amm), address(registry), address(splitter));

        splitter.setAuthorizedRouter(address(router));
        splitter.setExternalRouting(routingEnabled);

        follower.approveToken(address(usdc), address(router), type(uint256).max);
        usdc.mint(address(follower), 5 * USDC);
        follower.deposit(router, 5 * USDC);
    }

    function _publishIntent(CanaryActor source) internal {
        follower.follow(
            router,
            address(source),
            2 * USDC,
            5 * USDC,
            address(arceth),
            3
        );

        CanaryMirrorRouter.TradeIntent memory intent = CanaryMirrorRouter.TradeIntent({
            asset: address(arceth),
            amountUSDC: 1 * USDC,
            minAmountOut: 1,
            riskLevel: 2,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("intent")
        });

        source.publish(router, intent);
    }

    function _expectedMirrorFeeShares() internal pure returns (uint256 sourceShare, uint256 protocolShare) {
        uint256 fee = (USDC * MIRROR_FEE_BPS) / BPS;
        sourceShare = (fee * 7_000) / BPS;
        protocolShare = fee - sourceShare;
    }

    function testFallbackForNonForumSourceEvenIfRoutingEnabled() public {
        _setup(address(0xB0B), true, false);
        MockFeeRouter mock = feeRouter;
        splitter.preconfigureSplit();

        _publishIntent(rivalSource);

        (uint256 expectedSourceShare, uint256 expectedProtocolShare) = _expectedMirrorFeeShares();
        require(splitter.sourceKickbackUSDC(address(rivalSource)) == expectedSourceShare, "rival source local share incorrect");
        require(splitter.protocolFeesUSDC() == expectedProtocolShare, "rival protocol local share incorrect");
        require(mock.totalClaimableOf(address(rivalSource)) == 0, "non-forum source should not hit fee router");
        require(mock.totalClaimableOf(address(this)) == 0, "protocol should not be claimable for non-forum source");
    }

    function testForumSourceFallsBackWhenRoutingDisabled() public {
        _setup(address(0xC0DE), false, false);
        MockFeeRouter mock = feeRouter;
        splitter.preconfigureSplit();

        _publishIntent(forumSource);

        (uint256 expectedSourceShare, uint256 expectedProtocolShare) = _expectedMirrorFeeShares();
        require(splitter.sourceKickbackUSDC(address(forumSource)) == expectedSourceShare, "forum source should fallback when routing disabled");
        require(splitter.protocolFeesUSDC() == expectedProtocolShare, "protocol should fallback when routing disabled");
        require(mock.totalClaimableOf(address(0xC0DE)) == 0, "forum fee should not hit fee router when disabled");
        require(mock.totalClaimableOf(address(this)) == 0, "protocol should be zero when fallback");
    }

    function testForumSourceRoutesThroughFeeRouterWhenEnabledAndConfigured() public {
        address forumPayout = address(0xF00D);
        _setup(forumPayout, true, false);
        MockFeeRouter mock = feeRouter;

        splitter.preconfigureSplit();
        _publishIntent(forumSource);

        (uint256 expectedSourceShare, uint256 expectedProtocolShare) = _expectedMirrorFeeShares();
        require(splitter.sourceKickbackUSDC(address(forumSource)) == 0, "forum source should not locally accrue when routed");
        require(splitter.protocolFeesUSDC() == 0, "protocol should not locally accrue when routed");
        require(mock.totalClaimableOf(forumPayout) == expectedSourceShare, "forum payout incorrect");
        require(mock.totalClaimableOf(address(this)) == expectedProtocolShare, "protocol routing share incorrect");

        (bool hasSplit, uint256 splitId) = splitter.splitIdOf(address(forumSource));
        require(hasSplit, "forum split missing");
        require(mock.splitAt(splitId).totalRouted == (USDC * MIRROR_FEE_BPS) / BPS, "split routing total incorrect");
    }

    function testFallbackWhenFeeRouterReverts() public {
        _setup(address(0xBEEF), true, true);
        splitter.preconfigureSplit();

        _publishIntent(forumSource);

        (uint256 expectedSourceShare, uint256 expectedProtocolShare) = _expectedMirrorFeeShares();
        require(splitter.sourceKickbackUSDC(address(forumSource)) == expectedSourceShare, "fee router failure should fallback to source share");
        require(splitter.protocolFeesUSDC() == expectedProtocolShare, "fee router failure should fallback to protocol share");
    }

    function testClaimsAndUnauthorizedCallerPaths() public {
        address forumPayout = address(0xFEED);
        _setup(forumPayout, false, false);
        splitter.preconfigureSplit();

        _publishIntent(rivalSource);
        (uint256 expectedSourceShare, uint256 expectedProtocolShare) = _expectedMirrorFeeShares();

        // Source claim path.
        rivalSource.claimSourceKickback(splitter, address(0xA11E));
        require(usdc.balanceOf(address(0xA11E)) == expectedSourceShare, "source claim incorrect");

        bool sourceSecondClaimReverted;
        try rivalSource.claimSourceKickback(splitter, address(0xA11E)) {
            sourceSecondClaimReverted = false;
        } catch {
            sourceSecondClaimReverted = true;
        }
        require(sourceSecondClaimReverted, "second source claim should revert");

        // Protocol claim path and auth.
        splitter.claimProtocolFees(address(0xD3AD));
        require(usdc.balanceOf(address(0xD3AD)) == expectedProtocolShare, "protocol claim incorrect");

        bool protocolSecondClaimReverted;
        try splitter.claimProtocolFees(address(0xD3AD)) {
            protocolSecondClaimReverted = false;
        } catch {
            protocolSecondClaimReverted = true;
        }
        require(protocolSecondClaimReverted, "second protocol claim should revert");

        // Unauthorized protocol claimant cannot call claimProtocolFees.
        CanaryActor intruder = new CanaryActor();
        bool protocolUnauthorized;
        try intruder.claimProtocolFees(splitter, address(0xD3AD)) {
            protocolUnauthorized = false;
        } catch {
            protocolUnauthorized = true;
        }
        require(protocolUnauthorized, "unauthorized protocol claimant should revert");
    }

    function testUnauthorizedRouterCannotSettleFee() public {
        _setup(address(0xBA5E), false, false);
        CanaryActor intruder = new CanaryActor();
        bool failed;
        try intruder.settleMirrorFee(splitter, address(forumSource), USDC) {
            failed = false;
        } catch {
            failed = true;
        }
        require(failed, "only authorized router should settle mirror fee");
    }
}
