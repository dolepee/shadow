// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BondedMandateEnforcer} from "./BondedMandateEnforcer.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {MandateRegistry} from "./MandateRegistry.sol";
import {RiskPolicy} from "./RiskPolicy.sol";

interface IMorphoStyleVaultSink {
    function recordDeposit(address circleAccount, uint256 amountUSDC, bytes32 receiptHash, bytes32 actionHash) external;
}

contract MorphoStyleVaultAdapter {
    IERC20 public immutable usdc;
    BondedMandateEnforcer public immutable enforcer;
    address public immutable vaultSink;
    bytes32 public immutable marketId;
    uint256 public depositedUSDC;
    uint256 public blockedUSDC;

    event AdapterBondPosted(address indexed funder, uint256 amountUSDC, uint256 adapterBondUSDC);
    event MorphoStyleDepositChecked(
        bytes32 indexed receiptHash,
        uint256 indexed mandateId,
        address indexed circleAccount,
        bytes32 actionHash,
        bool allowed,
        RiskPolicy.BlockReason reason,
        uint256 amountUSDC,
        bytes32 marketId,
        bytes32 executionRef
    );
    event USDCDepositedAfterReceipt(
        bytes32 indexed receiptHash, address indexed circleAccount, address indexed vaultSink, uint256 amountUSDC
    );
    event VaultRecordAttempted(bytes32 indexed receiptHash, address indexed vaultSink, bool recorded);

    error WrongAdapterTarget();
    error UnsupportedActionType();
    error ZeroMarketId();
    error MissingExecutionRef();

    constructor(address usdc_, address enforcer_, address vaultSink_, bytes32 marketId_) {
        if (marketId_ == bytes32(0)) revert ZeroMarketId();
        usdc = IERC20(usdc_);
        enforcer = BondedMandateEnforcer(enforcer_);
        vaultSink = vaultSink_;
        marketId = marketId_;
    }

    function postBond(uint256 amountUSDC) external {
        require(usdc.transferFrom(msg.sender, address(this), amountUSDC), "USDC_TRANSFER_FAILED");
        require(usdc.approve(address(enforcer), amountUSDC), "USDC_APPROVE_FAILED");
        enforcer.bond(amountUSDC);
        require(usdc.approve(address(enforcer), 0), "USDC_APPROVE_RESET_FAILED");
        emit AdapterBondPosted(msg.sender, amountUSDC, adapterBondUSDC());
    }

    function adapterBondUSDC() public view returns (uint256) {
        return enforcer.bondUSDC(address(this));
    }

    function surfaceHash() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "shadow.arc.morpho-style.vault-adapter.v1",
                block.chainid,
                address(this),
                address(usdc),
                vaultSink,
                marketId
            )
        );
    }

    function morphoMarketExecutionRef(
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv,
        bytes32 salt
    ) external view returns (bytes32) {
        return keccak256(
            abi.encode(
                "shadow.arc.morpho-style.market.v1",
                block.chainid,
                address(this),
                marketId,
                loanToken,
                collateralToken,
                oracle,
                irm,
                lltv,
                salt
            )
        );
    }

    function depositWithMandate(MandateRegistry.Action calldata action)
        external
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason)
    {
        if (action.target != address(this)) revert WrongAdapterTarget();
        if (action.actionType != MandateRegistry.ActionType.DEPOSIT) revert UnsupportedActionType();
        if (action.executionRef == bytes32(0)) revert MissingExecutionRef();

        bytes32 actionHash;
        (receiptHash, allowed, reason, actionHash) = _check(action);

        if (allowed) {
            depositedUSDC += action.amountUSDC;
            require(usdc.transferFrom(action.circleAccount, vaultSink, action.amountUSDC), "USDC_TRANSFER_FAILED");
            bool recorded = _recordVaultDeposit(action, receiptHash, actionHash);
            emit VaultRecordAttempted(receiptHash, vaultSink, recorded);
            emit USDCDepositedAfterReceipt(receiptHash, action.circleAccount, vaultSink, action.amountUSDC);
        } else {
            blockedUSDC += action.amountUSDC;
        }

        emit MorphoStyleDepositChecked(
            receiptHash,
            action.mandateId,
            action.circleAccount,
            actionHash,
            allowed,
            reason,
            action.amountUSDC,
            marketId,
            action.executionRef
        );
    }

    function _check(MandateRegistry.Action calldata action)
        internal
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason, bytes32 actionHash)
    {
        (receiptHash, allowed, reason) = enforcer.enforce(action);
        actionHash = enforcer.registry().hashAction(action);
    }

    function _recordVaultDeposit(MandateRegistry.Action calldata action, bytes32 receiptHash, bytes32 actionHash)
        internal
        returns (bool recorded)
    {
        if (vaultSink.code.length == 0) return false;
        try IMorphoStyleVaultSink(vaultSink).recordDeposit(
            action.circleAccount,
            action.amountUSDC,
            receiptHash,
            actionHash
        ) {
            recorded = true;
        } catch {
            recorded = false;
        }
    }
}
