// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RiskPolicy} from "./RiskPolicy.sol";

contract MandateAttestor {
    enum Decision {
        ALLOW,
        BLOCK
    }

    struct ReceiptInput {
        uint256 mandateId;
        bytes32 mandateHash;
        bytes32 actionHash;
        address actor;
        address circleAccount;
        address enforcer;
        address settlementAsset;
        address target;
        uint256 amountUSDC;
        Decision decision;
        RiskPolicy.BlockReason reason;
        bytes32 executionRef;
    }

    struct Receipt {
        uint256 sequence;
        uint256 mandateId;
        bytes32 mandateHash;
        bytes32 actionHash;
        address actor;
        address circleAccount;
        address enforcer;
        address settlementAsset;
        address target;
        uint256 amountUSDC;
        Decision decision;
        RiskPolicy.BlockReason reason;
        bytes32 executionRef;
        uint64 timestamp;
        uint64 blockNumber;
        bool exists;
    }

    address public owner;
    uint256 public nextReceiptId = 1;
    bytes32[] private receiptHashes;

    mapping(address => bool) public recorders;
    mapping(bytes32 => Receipt) private receipts;
    mapping(bytes32 => bytes32) public receiptByActionHash;

    event RecorderSet(address indexed recorder, bool enabled);
    event MandateReceipt(
        uint256 indexed sequence,
        bytes32 indexed receiptHash,
        uint256 indexed mandateId,
        bytes32 actionHash,
        Decision decision,
        RiskPolicy.BlockReason reason
    );

    error NotOwner();
    error NotRecorder();
    error DuplicateReceipt();
    error MissingReceipt();

    constructor() {
        owner = msg.sender;
    }

    function setRecorder(address recorder, bool enabled) external {
        if (msg.sender != owner) revert NotOwner();
        recorders[recorder] = enabled;
        emit RecorderSet(recorder, enabled);
    }

    function attest(ReceiptInput calldata input) external returns (bytes32 receiptHash) {
        if (!recorders[msg.sender]) revert NotRecorder();
        if (receiptByActionHash[input.actionHash] != bytes32(0)) revert DuplicateReceipt();

        uint256 sequence = nextReceiptId++;
        uint64 timestamp = uint64(block.timestamp);
        uint64 blockNumber = uint64(block.number);
        receiptHash = _hashReceipt(input, sequence, timestamp, blockNumber);

        Receipt storage receipt = receipts[receiptHash];
        receipt.sequence = sequence;
        receipt.mandateId = input.mandateId;
        receipt.mandateHash = input.mandateHash;
        receipt.actionHash = input.actionHash;
        receipt.actor = input.actor;
        receipt.circleAccount = input.circleAccount;
        receipt.enforcer = input.enforcer;
        receipt.settlementAsset = input.settlementAsset;
        receipt.target = input.target;
        receipt.amountUSDC = input.amountUSDC;
        receipt.decision = input.decision;
        receipt.reason = input.reason;
        receipt.executionRef = input.executionRef;
        receipt.timestamp = timestamp;
        receipt.blockNumber = blockNumber;
        receipt.exists = true;
        receiptByActionHash[input.actionHash] = receiptHash;
        receiptHashes.push(receiptHash);

        emit MandateReceipt(sequence, receiptHash, input.mandateId, input.actionHash, input.decision, input.reason);
    }

    function getReceiptDecision(bytes32 receiptHash)
        external
        view
        returns (
            uint256 mandateId,
            uint256 amountUSDC,
            Decision decision,
            RiskPolicy.BlockReason reason,
            bytes32 executionRef
        )
    {
        Receipt storage receipt = receipts[receiptHash];
        if (!receipt.exists) revert MissingReceipt();
        return (receipt.mandateId, receipt.amountUSDC, receipt.decision, receipt.reason, receipt.executionRef);
    }

    function getReceiptParties(bytes32 receiptHash)
        external
        view
        returns (address actor, address circleAccount, address enforcer, address settlementAsset, address target)
    {
        Receipt storage receipt = receipts[receiptHash];
        if (!receipt.exists) revert MissingReceipt();
        return (receipt.actor, receipt.circleAccount, receipt.enforcer, receipt.settlementAsset, receipt.target);
    }

    function getReceiptHashes(bytes32 receiptHash)
        external
        view
        returns (uint256 sequence, bytes32 mandateHash, bytes32 actionHash, uint64 timestamp, uint64 blockNumber)
    {
        Receipt storage receipt = receipts[receiptHash];
        if (!receipt.exists) revert MissingReceipt();
        return (receipt.sequence, receipt.mandateHash, receipt.actionHash, receipt.timestamp, receipt.blockNumber);
    }

    function receiptCount() external view returns (uint256) {
        return receiptHashes.length;
    }

    function receiptHashAt(uint256 index) external view returns (bytes32) {
        return receiptHashes[index];
    }

    function _hashReceipt(ReceiptInput calldata input, uint256 sequence, uint64 timestamp, uint64 blockNumber)
        internal
        view
        returns (bytes32)
    {
        bytes32 partiesHash = keccak256(
            abi.encode(input.actor, input.circleAccount, input.enforcer, input.settlementAsset, input.target)
        );
        bytes32 decisionHash = keccak256(abi.encode(input.amountUSDC, input.decision, input.reason, input.executionRef));
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                sequence,
                input.mandateId,
                input.mandateHash,
                input.actionHash,
                partiesHash,
                decisionHash,
                timestamp,
                blockNumber
            )
        );
    }
}
