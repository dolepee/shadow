// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

contract MandateVaultSink {
    struct DepositRecord {
        address circleAccount;
        uint256 amountUSDC;
        bytes32 actionHash;
        uint64 timestamp;
        bool exists;
    }

    IERC20 public immutable usdc;
    address public owner;
    address public adapter;
    uint256 public totalDepositedUSDC;

    mapping(address => uint256) public depositsByAccountUSDC;
    mapping(bytes32 => DepositRecord) public depositsByReceipt;

    event AdapterSet(address indexed adapter);
    event VaultDepositRecorded(
        bytes32 indexed receiptHash,
        bytes32 indexed actionHash,
        address indexed circleAccount,
        uint256 amountUSDC,
        uint256 totalDepositedUSDC
    );
    event VaultWithdrawal(address indexed circleAccount, address indexed recipient, uint256 amountUSDC);

    error NotOwner();
    error NotAdapter();
    error ZeroAddress();
    error ZeroAmount();
    error DuplicateReceipt();
    error DepositNotFunded();
    error InsufficientDeposit();
    error TransferFailed();

    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        owner = msg.sender;
    }

    function setAdapter(address adapter_) external {
        if (msg.sender != owner) revert NotOwner();
        if (adapter_ == address(0)) revert ZeroAddress();
        adapter = adapter_;
        emit AdapterSet(adapter_);
    }

    function recordDeposit(address circleAccount, uint256 amountUSDC, bytes32 receiptHash, bytes32 actionHash) external {
        if (msg.sender != adapter) revert NotAdapter();
        if (depositsByReceipt[receiptHash].exists) revert DuplicateReceipt();
        if (usdc.balanceOf(address(this)) < totalDepositedUSDC + amountUSDC) revert DepositNotFunded();

        totalDepositedUSDC += amountUSDC;
        depositsByAccountUSDC[circleAccount] += amountUSDC;
        depositsByReceipt[receiptHash] = DepositRecord({
            circleAccount: circleAccount,
            amountUSDC: amountUSDC,
            actionHash: actionHash,
            timestamp: uint64(block.timestamp),
            exists: true
        });

        emit VaultDepositRecorded(receiptHash, actionHash, circleAccount, amountUSDC, totalDepositedUSDC);
    }

    function withdraw(uint256 amountUSDC, address recipient) external {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountUSDC == 0) revert ZeroAmount();
        uint256 balance = depositsByAccountUSDC[msg.sender];
        if (amountUSDC > balance) revert InsufficientDeposit();

        depositsByAccountUSDC[msg.sender] = balance - amountUSDC;
        totalDepositedUSDC -= amountUSDC;
        if (!usdc.transfer(recipient, amountUSDC)) revert TransferFailed();
        emit VaultWithdrawal(msg.sender, recipient, amountUSDC);
    }
}
