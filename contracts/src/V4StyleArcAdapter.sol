// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BondedMandateEnforcer} from "./BondedMandateEnforcer.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {MandateRegistry} from "./MandateRegistry.sol";
import {RiskPolicy} from "./RiskPolicy.sol";

interface IMandateVaultSink {
    function recordDeposit(address circleAccount, uint256 amountUSDC, bytes32 receiptHash, bytes32 actionHash) external;
}

contract V4StyleArcAdapter {
    IERC20 public immutable usdc;
    BondedMandateEnforcer public immutable enforcer;
    address public immutable liquiditySink;
    uint256 public executedUSDC;
    uint256 public blockedUSDC;

    event AdapterBondPosted(address indexed funder, uint256 amountUSDC, uint256 adapterBondUSDC);
    event V4StyleActionChecked(
        bytes32 indexed receiptHash,
        uint256 indexed mandateId,
        address indexed circleAccount,
        bytes32 actionHash,
        bool allowed,
        RiskPolicy.BlockReason reason,
        uint256 amountUSDC
    );
    event USDCMovedAfterReceipt(
        bytes32 indexed receiptHash, address indexed circleAccount, address indexed liquiditySink, uint256 amountUSDC
    );
    event SinkRecordAttempted(
        bytes32 indexed receiptHash,
        address indexed liquiditySink,
        bool recorded
    );

    error WrongAdapterTarget();

    constructor(address usdc_, address enforcer_, address liquiditySink_) {
        usdc = IERC20(usdc_);
        enforcer = BondedMandateEnforcer(enforcer_);
        liquiditySink = liquiditySink_;
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

    function beforeSwapStyleAction(MandateRegistry.Action calldata action)
        external
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason)
    {
        if (action.target != address(this)) revert WrongAdapterTarget();

        bytes32 actionHash;
        (receiptHash, allowed, reason, actionHash) = _check(action);

        if (allowed) {
            executedUSDC += action.amountUSDC;
            require(usdc.transferFrom(action.circleAccount, liquiditySink, action.amountUSDC), "USDC_TRANSFER_FAILED");
            bool recorded = _recordSinkDeposit(action, receiptHash, actionHash);
            emit SinkRecordAttempted(receiptHash, liquiditySink, recorded);
            emit USDCMovedAfterReceipt(receiptHash, action.circleAccount, liquiditySink, action.amountUSDC);
        } else {
            blockedUSDC += action.amountUSDC;
        }

        emit V4StyleActionChecked(
            receiptHash, action.mandateId, action.circleAccount, actionHash, allowed, reason, action.amountUSDC
        );
    }

    function _check(MandateRegistry.Action calldata action)
        internal
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason, bytes32 actionHash)
    {
        (receiptHash, allowed, reason) = enforcer.enforce(action);
        actionHash = enforcer.registry().hashAction(action);
    }

    function _recordSinkDeposit(MandateRegistry.Action calldata action, bytes32 receiptHash, bytes32 actionHash)
        internal
        returns (bool recorded)
    {
        if (liquiditySink.code.length == 0) return false;
        try IMandateVaultSink(liquiditySink).recordDeposit(
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
