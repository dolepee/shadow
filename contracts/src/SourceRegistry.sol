// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SourceRegistry {
    struct SourceAgent {
        address agent;
        string name;
        string metadataURI;
        uint16 reputationScore;
        address erc8004Registry;
        uint256 erc8004TokenId;
        bool registered;
    }

    address public owner;
    mapping(address => SourceAgent) public sources;
    address[] public sourceList;

    event SourceRegistered(
        address indexed agent,
        string name,
        string metadataURI,
        uint16 reputationScore,
        address indexed erc8004Registry,
        uint256 erc8004TokenId
    );
    event ReputationUpdated(address indexed agent, uint16 reputationScore);

    error NotOwner();
    error InvalidAgent();
    error NotRegistered();
    error ReputationTooHigh();

    constructor() {
        owner = msg.sender;
    }

    function registerSource(
        address agent,
        string calldata name,
        string calldata metadataURI,
        uint16 reputationScore,
        address erc8004Registry,
        uint256 erc8004TokenId
    ) external {
        if (msg.sender != owner) revert NotOwner();
        if (agent == address(0)) revert InvalidAgent();
        if (reputationScore > 10_000) revert ReputationTooHigh();

        if (!sources[agent].registered) {
            sourceList.push(agent);
        }

        sources[agent] = SourceAgent({
            agent: agent,
            name: name,
            metadataURI: metadataURI,
            reputationScore: reputationScore,
            erc8004Registry: erc8004Registry,
            erc8004TokenId: erc8004TokenId,
            registered: true
        });

        emit SourceRegistered(agent, name, metadataURI, reputationScore, erc8004Registry, erc8004TokenId);
    }

    function updateReputation(address agent, uint16 reputationScore) external {
        if (msg.sender != owner) revert NotOwner();
        if (!sources[agent].registered) revert NotRegistered();
        if (reputationScore > 10_000) revert ReputationTooHigh();

        sources[agent].reputationScore = reputationScore;
        emit ReputationUpdated(agent, reputationScore);
    }

    function isRegistered(address agent) external view returns (bool) {
        return sources[agent].registered;
    }

    function sourceCount() external view returns (uint256) {
        return sourceList.length;
    }
}

