// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFeeRouter} from "./IFeeRouter.sol";
import {IERC20} from "../interfaces/IERC20.sol";

/// @title MirrorFeeSplitter (canary variant A, v3 — Forum-only, feature-gated)
/// @notice Bounded canary: routes the mirror fee through the verified FeeRouterV1
/// (`0xeff9bc359e8f2a5eabce55af3f1bb24f98eabf59`) for EXACTLY ONE allowlisted source
/// (Forum's confirmed address), and only while the operator has flipped
/// `externalRoutingEnabled` on. Every other source, Forum-while-disabled, the
/// unconfigured case, and every caught FeeRouter failure fall back to Shadow's
/// existing local accrual + claim path, unchanged. The Forum split MUST be
/// preconfigured via `preconfigureSplit()` before any intent — this contract never
/// calls `FeeRouter.createSplit` from the follower-loop hot path.
///
/// @dev Two token hops, both allowance-based and both provably cleaned up:
///   1. MirrorRouter -> MirrorFeeSplitter: the router approves this contract for
///      exactly `mirrorFeeUSDC` before calling `settleMirrorFee`; this contract pulls
///      via `transferFrom` inside the call. The router's allowance to this contract is
///      fully consumed by the pull on every call (success or fallback) — nothing is
///      left outstanding because the router only ever approves the exact amount it is
///      about to spend, mirroring MirrorRouter's own AMM approve/reset pattern.
///   2. MirrorFeeSplitter -> FeeRouter: `routeFee` approves FeeRouter for exactly
///      `mirrorFeeUSDC`, calls `pay`, then resets the approval to 0. If `pay` reverts,
///      the ENTIRE `routeFee` call frame reverts — including the approve that preceded
///      it — so the allowance is rolled back to 0 by EVM semantics, not by explicit
///      cleanup code. Both properties are asserted directly by tests, not assumed.
///
/// Batch liveness: `routeFee` is invoked via `this.routeFee(...)` (an external
/// self-call) wrapped in try/catch. Any failure — FeeRouter down, a bad split, a
/// reentrancy attempt — is caught and the fee is retained locally as accrual. The
/// enclosing MirrorRouter `publishIntent` follower loop can never revert because of
/// this contract.
contract MirrorFeeSplitter {
    IERC20 public immutable usdc;
    IFeeRouter public immutable feeRouter;
    address public immutable protocolFeeRecipient;
    address public authorizedRouter;

    // ── Canary scope (v3) ──────────────────────────────────────────────────────
    // External FeeRouter routing is permitted for EXACTLY ONE allowlisted source —
    // Forum's confirmed source address — and only while the operator has explicitly
    // enabled it. Every other source, and every fallback, uses Shadow's existing
    // local accrual + claim path unchanged. Forum's 70% share is paid to a
    // separately-specified, explicitly-confirmed payout address (may differ from the
    // source address that publishes the intent).
    address public immutable forumSource; // allowlist key: the only source that can route
    address public immutable forumPayout; // recipient of Forum's 70% split share
    bool public externalRoutingEnabled; // feature gate; starts OFF, operator-toggled

    uint16 public constant BPS = 10_000;
    uint16 public constant SOURCE_FEE_SHARE_BPS = 7_000;

    // Fallback accrual — identical semantics to MirrorRouter's original
    // sourceKickbackUSDC / protocolFeesUSDC. Used for every non-Forum source, for
    // Forum while routing is disabled, and for every caught-failure fallback.
    mapping(address => uint256) public sourceKickbackUSDC;
    uint256 public protocolFeesUSDC;

    // Preconfigured Forum split. Never populated lazily. Keyed by forumSource.
    mapping(address => uint256) private _splitIdBySource;
    mapping(address => bool) private _hasSplit;

    uint256 private _locked = 1;

    event ExternalRoutingSet(bool enabled);
    event AuthorizedRouterSet(address indexed router);
    event SplitPreconfigured(address indexed sourceAgent, uint256 indexed splitId);
    event MirrorFeeRouted(
        address indexed sourceAgent, uint256 splitId, uint256 sourceShareUSDC, uint256 protocolShareUSDC
    );
    event MirrorFeeAccruedFallback(
        address indexed sourceAgent, uint256 sourceShareUSDC, uint256 protocolShareUSDC, bytes reason
    );
    event SourceKickbackClaimed(address indexed sourceAgent, address indexed recipient, uint256 amountUSDC);
    event ProtocolFeesClaimed(address indexed recipient, uint256 amountUSDC);

    error ZeroRecipient();
    error Reentrancy();
    error OnlySelf();
    error UnauthorizedRouter();
    error NotProtocolFeeRecipient();
    error NothingToClaim();
    error TransferFailed();
    error AlreadyAuthorizedRouter();
    error AlreadyConfigured();
    error NotConfigured();
    error PullFailed();
    error TokenMismatch();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address usdc_,
        address feeRouter_,
        address protocolFeeRecipient_,
        address forumSource_,
        address forumPayout_
    ) {
        if (
            usdc_ == address(0) || feeRouter_ == address(0) || protocolFeeRecipient_ == address(0)
                || forumSource_ == address(0) || forumPayout_ == address(0)
        ) revert ZeroRecipient();

        IFeeRouter candidateRouter = IFeeRouter(feeRouter_);
        if (address(candidateRouter.usdc()) != usdc_) revert TokenMismatch();

        usdc = IERC20(usdc_);
        feeRouter = IFeeRouter(feeRouter_);
        protocolFeeRecipient = protocolFeeRecipient_;
        forumSource = forumSource_;
        forumPayout = forumPayout_;
        // externalRoutingEnabled starts false — the canary is inert until the operator
        // flips it on, and Shadow's accrual path is the default until then.
    }

    /// @notice Feature gate. Operator-only. External FeeRouter routing for Forum is
    /// disabled until this is set true, and can be turned back off at any time (all
    /// settlement then falls back to local accrual).
    function setExternalRouting(bool enabled) external {
        if (msg.sender != protocolFeeRecipient) revert NotProtocolFeeRecipient();
        externalRoutingEnabled = enabled;
        emit ExternalRoutingSet(enabled);
    }

    /// @notice Lock in the canary router address that is allowed to call
    /// `settleMirrorFee`. This prevents external callers from crafting or replaying
    /// signed fee-settlement intent evidence in the canary path.
    function setAuthorizedRouter(address router) external {
        if (msg.sender != protocolFeeRecipient) revert NotProtocolFeeRecipient();
        if (router == address(0)) revert ZeroRecipient();
        if (authorizedRouter != address(0)) revert AlreadyAuthorizedRouter();
        authorizedRouter = router;
        emit AuthorizedRouterSet(router);
    }

    /// @notice One-time setup of the FORUM split only, gated to the operator, called
    /// BEFORE any mirror intent. This is the ONLY place `FeeRouter.createSplit` is ever
    /// invoked — `settleMirrorFee` never creates a split. The split pays Forum's
    /// confirmed payout address its exact 70%; the protocol (recipients[0]) absorbs
    /// rounding dust, matching MirrorRouter's original `protocolFees += fee - sourceShare`.
    function preconfigureSplit() external returns (uint256 splitId) {
        if (msg.sender != protocolFeeRecipient) revert NotProtocolFeeRecipient();
        if (protocolFeeRecipient == forumPayout) revert ZeroRecipient();
        if (_hasSplit[forumSource]) revert AlreadyConfigured();

        // Protocol is recipients[0] on purpose: deployed FeeRouterV1 folds rounding
        // dust into the FIRST recipient. Ordering protocol first gives Forum's payout
        // (recipients[1]) its exact bps and the protocol the remainder — identical to
        // the pre-integration accrual behavior.
        address[] memory recipients = new address[](2);
        recipients[0] = protocolFeeRecipient;
        recipients[1] = forumPayout;
        uint16[] memory bps = new uint16[](2);
        bps[0] = BPS - SOURCE_FEE_SHARE_BPS;
        bps[1] = SOURCE_FEE_SHARE_BPS;

        splitId = feeRouter.createSplit(recipients, bps);
        _splitIdBySource[forumSource] = splitId;
        _hasSplit[forumSource] = true;
        emit SplitPreconfigured(forumSource, splitId);
    }

    /// @notice Settle one follower's mirror fee. Caller (the router) must have
    /// been authorized by the owner and approved this contract for exactly `mirrorFeeUSDC` beforehand; this call pulls
    /// it via `transferFrom`. Never reverts on FeeRouter/recipient failure — always
    /// either routes through FeeRouter (if preconfigured) or accrues locally.
    function settleMirrorFee(address sourceAgent, uint256 mirrorFeeUSDC) external nonReentrant {
        if (authorizedRouter == address(0) || msg.sender != authorizedRouter) revert UnauthorizedRouter();
        if (!usdc.transferFrom(msg.sender, address(this), mirrorFeeUSDC)) revert PullFailed();

        uint256 sourceShareUSDC = (mirrorFeeUSDC * SOURCE_FEE_SHARE_BPS) / BPS;
        uint256 protocolShareUSDC = mirrorFeeUSDC - sourceShareUSDC;

        // External routing is permitted ONLY for Forum's exact source address, ONLY
        // while the operator has enabled it, and ONLY once its split is preconfigured.
        // Every other source, Forum-while-disabled, and the unconfigured case all use
        // Shadow's existing local accrual path — zero FeeRouter interaction.
        bool routable = externalRoutingEnabled && sourceAgent == forumSource && _hasSplit[forumSource];

        if (!routable) {
            sourceKickbackUSDC[sourceAgent] += sourceShareUSDC;
            protocolFeesUSDC += protocolShareUSDC;
            emit MirrorFeeAccruedFallback(
                sourceAgent,
                sourceShareUSDC,
                protocolShareUSDC,
                bytes("not routable: non-forum, disabled, or unconfigured")
            );
            return;
        }

        try this.routeFee(sourceAgent, mirrorFeeUSDC) {
        // routed atomically through FeeRouter's audited split
        }
        catch (bytes memory reason) {
            sourceKickbackUSDC[sourceAgent] += sourceShareUSDC;
            protocolFeesUSDC += protocolShareUSDC;
            emit MirrorFeeAccruedFallback(sourceAgent, sourceShareUSDC, protocolShareUSDC, reason);
        }
    }

    /// @dev Self-call boundary so approve/pay/approve-reset is one try/catch unit. If
    /// `pay` reverts, this whole frame reverts and the approve before it is rolled
    /// back automatically — no stale allowance can persist.
    function routeFee(address sourceAgent, uint256 mirrorFeeUSDC) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 splitId = _splitIdBySource[sourceAgent];
        if (!_hasSplit[sourceAgent]) revert NotConfigured();
        if (splitId == 0) revert NotConfigured();

        if (!usdc.approve(address(feeRouter), mirrorFeeUSDC)) revert TransferFailed();
        feeRouter.pay(splitId, mirrorFeeUSDC);
        if (!usdc.approve(address(feeRouter), 0)) revert TransferFailed();
        uint256 sourceShareUSDC = (mirrorFeeUSDC * SOURCE_FEE_SHARE_BPS) / BPS;
        emit MirrorFeeRouted(sourceAgent, splitId, sourceShareUSDC, mirrorFeeUSDC - sourceShareUSDC);
    }

    function splitIdOf(address sourceAgent) external view returns (bool exists, uint256 splitId) {
        return (_hasSplit[sourceAgent], _splitIdBySource[sourceAgent]);
    }

    function claimSourceKickback(address recipient) external nonReentrant {
        if (recipient == address(0)) revert ZeroRecipient();
        uint256 amountUSDC = sourceKickbackUSDC[msg.sender];
        if (amountUSDC == 0) revert NothingToClaim();
        sourceKickbackUSDC[msg.sender] = 0;
        if (!usdc.transfer(recipient, amountUSDC)) revert TransferFailed();
        emit SourceKickbackClaimed(msg.sender, recipient, amountUSDC);
    }

    function claimProtocolFees(address recipient) external nonReentrant {
        if (msg.sender != protocolFeeRecipient) revert NotProtocolFeeRecipient();
        if (recipient == address(0)) revert ZeroRecipient();
        uint256 amountUSDC = protocolFeesUSDC;
        if (amountUSDC == 0) revert NothingToClaim();
        protocolFeesUSDC = 0;
        if (!usdc.transfer(recipient, amountUSDC)) revert TransferFailed();
        emit ProtocolFeesClaimed(recipient, amountUSDC);
    }
}
