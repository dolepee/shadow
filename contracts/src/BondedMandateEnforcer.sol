// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {MandateAttestor} from "./MandateAttestor.sol";
import {MandateRegistry} from "./MandateRegistry.sol";
import {RiskPolicy} from "./RiskPolicy.sol";

contract BondedMandateEnforcer {
    IERC20 public immutable usdc;
    MandateRegistry public immutable registry;
    MandateAttestor public immutable attestor;
    uint256 public immutable minBondUSDC;

    struct PendingReceipt {
        address enforcer;
        uint64 deadline;
        bool open;
    }

    mapping(address => uint256) public bondUSDC;
    mapping(bytes32 => PendingReceipt) public pendingReceipts;

    event Bonded(address indexed enforcer, uint256 amountUSDC, uint256 totalBondUSDC);
    event Unbonded(address indexed enforcer, uint256 amountUSDC, uint256 totalBondUSDC);
    event ReceiptCommitted(bytes32 indexed actionHash, address indexed enforcer, uint64 deadline);
    event MissingReceiptSlashed(
        bytes32 indexed actionHash,
        address indexed enforcer,
        address indexed recipient,
        uint256 amountUSDC
    );
    event MandateChecked(
        bytes32 indexed receiptHash,
        uint256 indexed mandateId,
        address indexed enforcer,
        bytes32 actionHash,
        bool allowed,
        RiskPolicy.BlockReason reason
    );

    error ZeroAmount();
    error BondTooLow();
    error InsufficientBond();
    error DeadlineInPast();
    error PendingReceiptExists();
    error PendingReceiptNotFound();
    error ChallengeWindowOpen();
    error ReceiptAlreadyExists();

    constructor(address usdc_, address registry_, address attestor_, uint256 minBondUSDC_) {
        usdc = IERC20(usdc_);
        registry = MandateRegistry(registry_);
        attestor = MandateAttestor(attestor_);
        minBondUSDC = minBondUSDC_;
    }

    function bond(uint256 amountUSDC) external {
        if (amountUSDC == 0) revert ZeroAmount();
        require(usdc.transferFrom(msg.sender, address(this), amountUSDC), "USDC_TRANSFER_FAILED");
        bondUSDC[msg.sender] += amountUSDC;
        emit Bonded(msg.sender, amountUSDC, bondUSDC[msg.sender]);
    }

    function unbond(uint256 amountUSDC) external {
        if (amountUSDC == 0) revert ZeroAmount();
        uint256 currentBond = bondUSDC[msg.sender];
        if (amountUSDC > currentBond) revert InsufficientBond();
        uint256 remainingBond = currentBond - amountUSDC;
        if (remainingBond != 0 && remainingBond < minBondUSDC) revert BondTooLow();
        bondUSDC[msg.sender] = remainingBond;
        require(usdc.transfer(msg.sender, amountUSDC), "USDC_TRANSFER_FAILED");
        emit Unbonded(msg.sender, amountUSDC, remainingBond);
    }

    function commitAction(MandateRegistry.Action calldata action, uint64 deadline) external returns (bytes32 actionHash) {
        if (bondUSDC[msg.sender] < minBondUSDC) revert BondTooLow();
        if (deadline < block.timestamp) revert DeadlineInPast();
        actionHash = registry.hashAction(action);
        if (pendingReceipts[actionHash].open) revert PendingReceiptExists();
        pendingReceipts[actionHash] = PendingReceipt({enforcer: msg.sender, deadline: deadline, open: true});
        emit ReceiptCommitted(actionHash, msg.sender, deadline);
    }

    function challengeMissingReceipt(bytes32 actionHash, address recipient) external returns (uint256 slashedUSDC) {
        PendingReceipt storage pending = pendingReceipts[actionHash];
        if (!pending.open) revert PendingReceiptNotFound();
        if (block.timestamp <= pending.deadline) revert ChallengeWindowOpen();
        if (attestor.receiptByActionHash(actionHash) != bytes32(0)) revert ReceiptAlreadyExists();

        address accused = pending.enforcer;
        uint256 currentBond = bondUSDC[accused];
        slashedUSDC = currentBond < minBondUSDC ? currentBond : minBondUSDC;
        if (slashedUSDC == 0) revert InsufficientBond();

        pending.open = false;
        bondUSDC[accused] = currentBond - slashedUSDC;
        require(usdc.transfer(recipient, slashedUSDC), "USDC_TRANSFER_FAILED");
        emit MissingReceiptSlashed(actionHash, accused, recipient, slashedUSDC);
    }

    function enforce(MandateRegistry.Action calldata action)
        external
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason)
    {
        if (bondUSDC[msg.sender] < minBondUSDC) revert BondTooLow();

        bytes32 mandateHash;
        bytes32 actionHash;
        (allowed, reason, mandateHash, actionHash) = registry.evaluate(action);

        if (allowed) {
            registry.recordSpend(action.mandateId, action.amountUSDC);
        }

        PendingReceipt storage pending = pendingReceipts[actionHash];
        if (pending.open && pending.enforcer == msg.sender) {
            pending.open = false;
        }

        MandateAttestor.Decision decision = allowed ? MandateAttestor.Decision.ALLOW : MandateAttestor.Decision.BLOCK;
        receiptHash = attestor.attest(
            MandateAttestor.ReceiptInput({
                mandateId: action.mandateId,
                mandateHash: mandateHash,
                actionHash: actionHash,
                actor: action.actor,
                circleAccount: action.circleAccount,
                enforcer: msg.sender,
                settlementAsset: action.settlementAsset,
                target: action.target,
                amountUSDC: action.amountUSDC,
                decision: decision,
                reason: reason,
                executionRef: action.executionRef
            })
        );

        emit MandateChecked(receiptHash, action.mandateId, msg.sender, actionHash, allowed, reason);
    }
}
