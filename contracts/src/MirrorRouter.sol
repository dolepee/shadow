// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {ShadowAMM} from "./ShadowAMM.sol";
import {SourceRegistry} from "./SourceRegistry.sol";
import {RiskPolicy} from "./RiskPolicy.sol";

contract MirrorRouter {
    using RiskPolicy for RiskPolicy.Policy;

    enum ReceiptStatus {
        COPIED,
        BLOCKED
    }

    struct TradeIntent {
        address asset;
        uint256 amountUSDC;
        uint256 minAmountOut;
        uint8 riskLevel;
        uint256 expiry;
        bytes32 intentHash;
    }

    struct Position {
        uint256 usdcIn;
        uint256 assetAmount;
        address sourceAgent;
        bool closed;
    }

    IERC20 public immutable usdc;
    IERC20 public immutable assetToken;
    ShadowAMM public immutable amm;
    SourceRegistry public immutable registry;
    address public immutable protocolFeeRecipient;
    uint256 public constant BPS = 10_000;
    uint256 public constant MIRROR_FEE_BPS = 10;
    uint256 public constant SOURCE_FEE_SHARE_BPS = 7_000;
    uint256 public constant MAX_FOLLOWERS_PER_SOURCE = 50;
    uint256 public nextIntentId = 1;

    mapping(address => uint256) public followerBalanceUSDC;
    mapping(address => uint256) public sourceKickbackUSDC;
    uint256 public protocolFeesUSDC;
    mapping(address => address[]) public followersBySource;
    mapping(address => mapping(address => RiskPolicy.Policy)) private policies;
    mapping(address => mapping(address => bool)) public isFollowing;
    mapping(uint256 => mapping(address => Position)) public positions;

    event Deposited(address indexed follower, uint256 amountUSDC);
    event Followed(
        address indexed follower,
        address indexed sourceAgent,
        uint256 maxAmountPerIntent,
        uint256 dailyCap,
        address indexed allowedAsset,
        uint8 maxRiskLevel,
        uint16 minBpsOut
    );
    event IntentPublished(
        uint256 indexed intentId,
        address indexed sourceAgent,
        address indexed asset,
        uint256 amountUSDC,
        uint8 riskLevel,
        bytes32 intentHash
    );
    event MirrorReceipt(
        uint256 indexed intentId,
        address indexed follower,
        address indexed sourceAgent,
        ReceiptStatus status,
        RiskPolicy.BlockReason reason,
        uint256 usdcAmount,
        uint256 mirrorFeeUSDC,
        uint256 assetAmountOut
    );
    event SourceKickbackClaimed(address indexed sourceAgent, address indexed recipient, uint256 amountUSDC);
    event ProtocolFeesClaimed(address indexed recipient, uint256 amountUSDC);
    event Withdrawn(address indexed follower, uint256 amountUSDC);
    event Unfollowed(address indexed follower, address indexed sourceAgent);
    event PositionOpened(
        uint256 indexed intentId,
        address indexed follower,
        address indexed sourceAgent,
        uint256 usdcIn,
        uint256 assetAmount
    );
    event PositionClosed(
        uint256 indexed intentId,
        address indexed follower,
        address indexed sourceAgent,
        uint256 usdcIn,
        uint256 usdcOut,
        int256 pnlBps
    );

    error ZeroAmount();
    error UnregisteredSource();
    error TooManyFollowers();
    error NothingToClaim();
    error NotProtocolFeeRecipient();
    error MinBpsOutTooHigh();
    error InsufficientBalance();
    error NotFollowing();
    error PositionNotOpen();

    constructor(address usdc_, address amm_, address registry_) {
        usdc = IERC20(usdc_);
        amm = ShadowAMM(amm_);
        registry = SourceRegistry(registry_);
        protocolFeeRecipient = msg.sender;
        assetToken = IERC20(address(ShadowAMM(amm_).asset()));
    }

    function depositUSDC(uint256 amountUSDC) external {
        if (amountUSDC == 0) revert ZeroAmount();
        require(usdc.transferFrom(msg.sender, address(this), amountUSDC), "USDC_TRANSFER_FAILED");
        followerBalanceUSDC[msg.sender] += amountUSDC;
        emit Deposited(msg.sender, amountUSDC);
    }

    function withdrawUSDC(uint256 amountUSDC) external {
        if (amountUSDC == 0) revert ZeroAmount();
        uint256 balance = followerBalanceUSDC[msg.sender];
        if (amountUSDC > balance) revert InsufficientBalance();
        followerBalanceUSDC[msg.sender] = balance - amountUSDC;
        require(usdc.transfer(msg.sender, amountUSDC), "USDC_TRANSFER_FAILED");
        emit Withdrawn(msg.sender, amountUSDC);
    }

    function unfollowSource(address sourceAgent) external {
        RiskPolicy.Policy storage policy = policies[msg.sender][sourceAgent];
        if (!policy.active) revert NotFollowing();
        policy.active = false;
        emit Unfollowed(msg.sender, sourceAgent);
    }

    function followSource(
        address sourceAgent,
        uint256 maxAmountPerIntent,
        uint256 dailyCap,
        address allowedAsset,
        uint8 maxRiskLevel,
        uint16 minBpsOut
    ) external {
        if (!registry.isRegistered(sourceAgent)) revert UnregisteredSource();
        if (minBpsOut > BPS) revert MinBpsOutTooHigh();

        if (!isFollowing[msg.sender][sourceAgent]) {
            if (followersBySource[sourceAgent].length >= MAX_FOLLOWERS_PER_SOURCE) revert TooManyFollowers();
            followersBySource[sourceAgent].push(msg.sender);
            isFollowing[msg.sender][sourceAgent] = true;
        }

        RiskPolicy.Policy storage policy = policies[msg.sender][sourceAgent];
        policy.maxAmountPerIntent = maxAmountPerIntent;
        policy.dailyCap = dailyCap;
        policy.allowedAsset = allowedAsset;
        policy.maxRiskLevel = maxRiskLevel;
        policy.minBpsOut = minBpsOut;
        policy.active = true;

        emit Followed(msg.sender, sourceAgent, maxAmountPerIntent, dailyCap, allowedAsset, maxRiskLevel, minBpsOut);
    }

    function getPolicy(address follower, address sourceAgent)
        external
        view
        returns (
            uint256 maxAmountPerIntent,
            uint256 dailyCap,
            address allowedAsset,
            uint8 maxRiskLevel,
            uint16 minBpsOut,
            uint256 spentToday,
            uint64 day,
            bool active
        )
    {
        RiskPolicy.Policy storage policy = policies[follower][sourceAgent];
        return (
            policy.maxAmountPerIntent,
            policy.dailyCap,
            policy.allowedAsset,
            policy.maxRiskLevel,
            policy.minBpsOut,
            policy.spentToday,
            policy.day,
            policy.active
        );
    }

    function publishIntent(TradeIntent calldata intent) external returns (uint256 intentId) {
        if (!registry.isRegistered(msg.sender)) revert UnregisteredSource();

        intentId = nextIntentId++;
        emit IntentPublished(
            intentId,
            msg.sender,
            intent.asset,
            intent.amountUSDC,
            intent.riskLevel,
            intent.intentHash
        );

        address[] storage followers = followersBySource[msg.sender];
        for (uint256 i = 0; i < followers.length; i++) {
            _processFollower(intentId, msg.sender, followers[i], intent);
        }
    }

    function _processFollower(
        uint256 intentId,
        address sourceAgent,
        address follower,
        TradeIntent calldata intent
    ) internal {
        if (!policies[follower][sourceAgent].active) return;

        if (intent.asset != address(amm.asset())) {
            emit MirrorReceipt(
                intentId,
                follower,
                sourceAgent,
                ReceiptStatus.BLOCKED,
                RiskPolicy.BlockReason.UNSUPPORTED_AMM_ASSET,
                intent.amountUSDC,
                0,
                0
            );
            return;
        }

        RiskPolicy.Policy storage policy = policies[follower][sourceAgent];
        RiskPolicy.BlockReason reason = policy.evaluate(
            followerBalanceUSDC[follower],
            intent.asset,
            intent.amountUSDC,
            intent.riskLevel,
            intent.expiry
        );

        if (reason != RiskPolicy.BlockReason.NONE) {
            emit MirrorReceipt(
                intentId,
                follower,
                sourceAgent,
                ReceiptStatus.BLOCKED,
                reason,
                intent.amountUSDC,
                0,
                0
            );
            return;
        }

        uint256 mirrorFeeUSDC = (intent.amountUSDC * MIRROR_FEE_BPS) / BPS;
        uint256 totalDebitUSDC = intent.amountUSDC + mirrorFeeUSDC;
        if (followerBalanceUSDC[follower] < totalDebitUSDC) {
            emit MirrorReceipt(
                intentId,
                follower,
                sourceAgent,
                ReceiptStatus.BLOCKED,
                RiskPolicy.BlockReason.INSUFFICIENT_BALANCE,
                intent.amountUSDC,
                mirrorFeeUSDC,
                0
            );
            return;
        }

        uint256 followerMinOut = (intent.minAmountOut * policy.minBpsOut) / BPS;
        uint256 quotedAssetOut = amm.quoteUSDCForAsset(intent.amountUSDC);
        if (quotedAssetOut < followerMinOut) {
            emit MirrorReceipt(
                intentId,
                follower,
                sourceAgent,
                ReceiptStatus.BLOCKED,
                RiskPolicy.BlockReason.SLIPPAGE_TOO_TIGHT,
                intent.amountUSDC,
                0,
                quotedAssetOut
            );
            return;
        }

        followerBalanceUSDC[follower] -= totalDebitUSDC;
        policy.recordSpend(intent.amountUSDC);

        uint256 sourceShareUSDC = (mirrorFeeUSDC * SOURCE_FEE_SHARE_BPS) / BPS;
        sourceKickbackUSDC[sourceAgent] += sourceShareUSDC;
        protocolFeesUSDC += mirrorFeeUSDC - sourceShareUSDC;

        require(usdc.approve(address(amm), intent.amountUSDC), "APPROVE_FAILED");
        uint256 assetOut = amm.swapExactUSDCForAsset(address(this), intent.amountUSDC, followerMinOut);
        require(usdc.approve(address(amm), 0), "APPROVE_RESET_FAILED");

        positions[intentId][follower] = Position({
            usdcIn: intent.amountUSDC,
            assetAmount: assetOut,
            sourceAgent: sourceAgent,
            closed: false
        });

        emit MirrorReceipt(
            intentId,
            follower,
            sourceAgent,
            ReceiptStatus.COPIED,
            RiskPolicy.BlockReason.NONE,
            intent.amountUSDC,
            mirrorFeeUSDC,
            assetOut
        );
        emit PositionOpened(intentId, follower, sourceAgent, intent.amountUSDC, assetOut);
    }

    function closePosition(uint256 intentId) external returns (uint256 usdcOut, int256 pnlBps) {
        Position storage pos = positions[intentId][msg.sender];
        if (pos.assetAmount == 0 || pos.closed) revert PositionNotOpen();

        pos.closed = true;
        uint256 assetAmount = pos.assetAmount;
        uint256 usdcIn = pos.usdcIn;
        address sourceAgent = pos.sourceAgent;

        require(assetToken.approve(address(amm), assetAmount), "ASSET_APPROVE_FAILED");
        usdcOut = amm.swapExactAssetForUSDC(address(this), assetAmount, 0);
        require(assetToken.approve(address(amm), 0), "ASSET_APPROVE_RESET_FAILED");

        followerBalanceUSDC[msg.sender] += usdcOut;

        pnlBps = int256((usdcOut * BPS) / usdcIn) - int256(BPS);
        emit PositionClosed(intentId, msg.sender, sourceAgent, usdcIn, usdcOut, pnlBps);
    }

    function followerCount(address sourceAgent) external view returns (uint256) {
        return followersBySource[sourceAgent].length;
    }

    function claimSourceKickback(address recipient) external {
        uint256 amountUSDC = sourceKickbackUSDC[msg.sender];
        if (amountUSDC == 0) revert NothingToClaim();
        sourceKickbackUSDC[msg.sender] = 0;
        require(usdc.transfer(recipient, amountUSDC), "USDC_TRANSFER_FAILED");
        emit SourceKickbackClaimed(msg.sender, recipient, amountUSDC);
    }

    function claimProtocolFees(address recipient) external {
        if (msg.sender != protocolFeeRecipient) revert NotProtocolFeeRecipient();
        uint256 amountUSDC = protocolFeesUSDC;
        if (amountUSDC == 0) revert NothingToClaim();
        protocolFeesUSDC = 0;
        require(usdc.transfer(recipient, amountUSDC), "USDC_TRANSFER_FAILED");
        emit ProtocolFeesClaimed(recipient, amountUSDC);
    }
}
