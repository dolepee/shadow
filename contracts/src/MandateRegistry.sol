// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {RiskPolicy} from "./RiskPolicy.sol";

contract MandateRegistry {
    using RiskPolicy for RiskPolicy.Policy;

    enum ActionType {
        UNKNOWN,
        SWAP,
        DEPOSIT,
        ALLOCATE,
        SPEND
    }

    struct Mandate {
        address owner;
        address circleAccount;
        address requiredSettlementAsset;
        address allowedTarget;
        ActionType actionType;
        RiskPolicy.Policy policy;
        bytes32 labelHash;
    }

    struct Action {
        uint256 mandateId;
        address actor;
        address circleAccount;
        address settlementAsset;
        address target;
        ActionType actionType;
        uint256 amountUSDC;
        uint8 riskLevel;
        uint16 minBpsOut;
        uint256 expiry;
        bytes32 intentHash;
        bytes32 executionRef;
    }

    IERC20 public immutable usdc;
    address public owner;
    uint256 public nextMandateId = 1;

    mapping(uint256 => Mandate) private mandates;
    mapping(address => bool) public recorders;

    event MandateCreated(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed circleAccount,
        address requiredSettlementAsset,
        address allowedTarget,
        ActionType actionType,
        uint256 maxAmountPerIntent,
        uint256 dailyCap,
        uint8 maxRiskLevel,
        uint16 minBpsOut,
        bytes32 labelHash
    );
    event RecorderSet(address indexed recorder, bool enabled);
    event MandateDeactivated(uint256 indexed mandateId);

    error NotOwner();
    error NotMandateOwner();
    error NotRecorder();
    error ZeroAddress();
    error SettlementAssetMustBeUSDC();
    error MinBpsOutTooHigh();

    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        owner = msg.sender;
    }

    function setRecorder(address recorder, bool enabled) external {
        if (msg.sender != owner) revert NotOwner();
        recorders[recorder] = enabled;
        emit RecorderSet(recorder, enabled);
    }

    function createMandate(
        address circleAccount,
        address requiredSettlementAsset,
        address allowedTarget,
        ActionType actionType,
        uint256 maxAmountPerIntent,
        uint256 dailyCap,
        uint8 maxRiskLevel,
        uint16 minBpsOut,
        bytes32 labelHash
    ) external returns (uint256 mandateId) {
        if (circleAccount == address(0)) revert ZeroAddress();
        if (requiredSettlementAsset != address(usdc)) revert SettlementAssetMustBeUSDC();
        if (minBpsOut > 10_000) revert MinBpsOutTooHigh();

        mandateId = nextMandateId++;
        Mandate storage mandate = mandates[mandateId];
        mandate.owner = msg.sender;
        mandate.circleAccount = circleAccount;
        mandate.requiredSettlementAsset = requiredSettlementAsset;
        mandate.allowedTarget = allowedTarget;
        mandate.actionType = actionType;
        mandate.policy.maxAmountPerIntent = maxAmountPerIntent;
        mandate.policy.dailyCap = dailyCap;
        mandate.policy.allowedAsset = requiredSettlementAsset;
        mandate.policy.maxRiskLevel = maxRiskLevel;
        mandate.policy.minBpsOut = minBpsOut;
        mandate.policy.active = true;
        mandate.labelHash = labelHash;

        emit MandateCreated(
            mandateId,
            msg.sender,
            circleAccount,
            requiredSettlementAsset,
            allowedTarget,
            actionType,
            maxAmountPerIntent,
            dailyCap,
            maxRiskLevel,
            minBpsOut,
            labelHash
        );
    }

    function deactivateMandate(uint256 mandateId) external {
        Mandate storage mandate = mandates[mandateId];
        if (msg.sender != mandate.owner) revert NotMandateOwner();
        mandate.policy.active = false;
        emit MandateDeactivated(mandateId);
    }

    function getMandateSpend(uint256 mandateId) external view returns (uint256 spentToday, uint64 day) {
        RiskPolicy.Policy storage policy = mandates[mandateId].policy;
        return (policy.spentToday, policy.day);
    }

    function getMandateAccounts(uint256 mandateId)
        external
        view
        returns (address mandateOwner, address circleAccount, address requiredSettlementAsset, address allowedTarget)
    {
        Mandate storage mandate = mandates[mandateId];
        return (mandate.owner, mandate.circleAccount, mandate.requiredSettlementAsset, mandate.allowedTarget);
    }

    function evaluate(Action calldata action)
        external
        view
        returns (bool allowed, RiskPolicy.BlockReason reason, bytes32 mandateHash, bytes32 actionHash)
    {
        return _evaluate(action);
    }

    function recordSpend(uint256 mandateId, uint256 amountUSDC) external {
        if (!recorders[msg.sender]) revert NotRecorder();
        mandates[mandateId].policy.recordSpend(amountUSDC);
    }

    function hashMandate(uint256 mandateId) public view returns (bytes32) {
        Mandate storage mandate = mandates[mandateId];
        RiskPolicy.Policy storage policy = mandate.policy;
        bytes32 accountsHash = keccak256(
            abi.encode(
                mandate.owner,
                mandate.circleAccount,
                mandate.requiredSettlementAsset,
                mandate.allowedTarget,
                mandate.actionType
            )
        );
        bytes32 policyHash = keccak256(
            abi.encode(
                policy.maxAmountPerIntent,
                policy.dailyCap,
                policy.allowedAsset,
                policy.maxRiskLevel,
                policy.minBpsOut,
                policy.active
            )
        );
        return
            keccak256(abi.encode(block.chainid, address(this), mandateId, accountsHash, policyHash, mandate.labelHash));
    }

    function hashAction(Action calldata action) public view returns (bytes32) {
        bytes32 partiesHash = keccak256(
            abi.encode(action.actor, action.circleAccount, action.settlementAsset, action.target, action.actionType)
        );
        bytes32 termsHash = keccak256(abi.encode(action.amountUSDC, action.riskLevel, action.minBpsOut, action.expiry));
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                action.mandateId,
                partiesHash,
                termsHash,
                action.intentHash,
                action.executionRef
            )
        );
    }

    function _evaluate(Action calldata action)
        internal
        view
        returns (bool allowed, RiskPolicy.BlockReason reason, bytes32 mandateHash, bytes32 actionHash)
    {
        Mandate storage mandate = mandates[action.mandateId];
        mandateHash = hashMandate(action.mandateId);
        actionHash = hashAction(action);

        if (action.circleAccount != mandate.circleAccount || action.actor != mandate.circleAccount) {
            return (false, RiskPolicy.BlockReason.NOT_FOLLOWING, mandateHash, actionHash);
        }
        if (action.settlementAsset != mandate.requiredSettlementAsset || action.settlementAsset != address(usdc)) {
            return (false, RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, mandateHash, actionHash);
        }
        if (mandate.allowedTarget != address(0) && action.target != mandate.allowedTarget) {
            return (false, RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, mandateHash, actionHash);
        }
        if (action.actionType != mandate.actionType) {
            return (false, RiskPolicy.BlockReason.NOT_FOLLOWING, mandateHash, actionHash);
        }
        if (action.minBpsOut < mandate.policy.minBpsOut) {
            return (false, RiskPolicy.BlockReason.SLIPPAGE_TOO_TIGHT, mandateHash, actionHash);
        }

        reason = mandate.policy
            .evaluate(
                usdc.balanceOf(action.circleAccount),
                action.settlementAsset,
                action.amountUSDC,
                action.riskLevel,
                action.expiry
            );
        allowed = reason == RiskPolicy.BlockReason.NONE;
    }
}
