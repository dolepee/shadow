// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Anchors an AI Pilot decision onchain. The follower (msg.sender) and
/// decisionHash uniquely identify a plan; downstream tooling joins on
/// (follower, decisionHash) to link execution receipts (deposit + N
/// followSource calls) back to the plan the AI proposed.
/// Anyone can attest. The contract holds no state beyond a counter; the event
/// log is the audit trail.
contract PilotAttestor {
    event PilotDecision(
        address indexed follower,
        bytes32 indexed decisionHash,
        uint256 totalUSDC,
        uint8 sliceCount,
        uint16 confidenceBps,
        bytes32 modelHash,
        uint64 timestamp
    );

    uint256 public attestationCount;
    mapping(address => uint256) public attestationsByFollower;

    function attest(
        bytes32 decisionHash,
        uint256 totalUSDC,
        uint8 sliceCount,
        uint16 confidenceBps,
        bytes32 modelHash
    ) external {
        attestationCount += 1;
        attestationsByFollower[msg.sender] += 1;
        emit PilotDecision(
            msg.sender,
            decisionHash,
            totalUSDC,
            sliceCount,
            confidenceBps,
            modelHash,
            uint64(block.timestamp)
        );
    }
}
