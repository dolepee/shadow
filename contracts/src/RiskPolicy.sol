// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library RiskPolicy {
    enum BlockReason {
        NONE,
        NOT_FOLLOWING,
        INSUFFICIENT_BALANCE,
        AMOUNT_TOO_HIGH,
        DAILY_CAP_EXCEEDED,
        ASSET_NOT_ALLOWED,
        UNSUPPORTED_AMM_ASSET,
        RISK_TOO_HIGH,
        INTENT_EXPIRED
    }

    struct Policy {
        uint256 maxAmountPerIntent;
        uint256 dailyCap;
        address allowedAsset;
        uint8 maxRiskLevel;
        uint256 spentToday;
        uint64 day;
        bool active;
    }

    function evaluate(
        Policy storage policy,
        uint256 followerBalance,
        address asset,
        uint256 amountUSDC,
        uint8 riskLevel,
        uint256 expiry
    ) internal view returns (BlockReason) {
        if (!policy.active) return BlockReason.NOT_FOLLOWING;
        if (expiry < block.timestamp) return BlockReason.INTENT_EXPIRED;
        if (followerBalance < amountUSDC) return BlockReason.INSUFFICIENT_BALANCE;
        if (amountUSDC > policy.maxAmountPerIntent) return BlockReason.AMOUNT_TOO_HIGH;
        if (policy.allowedAsset != asset) return BlockReason.ASSET_NOT_ALLOWED;
        if (riskLevel > policy.maxRiskLevel) return BlockReason.RISK_TOO_HIGH;

        uint64 currentDay = uint64(block.timestamp / 1 days);
        uint256 spent = policy.day == currentDay ? policy.spentToday : 0;
        if (policy.dailyCap > 0 && spent + amountUSDC > policy.dailyCap) {
            return BlockReason.DAILY_CAP_EXCEEDED;
        }

        return BlockReason.NONE;
    }

    function recordSpend(Policy storage policy, uint256 amountUSDC) internal {
        uint64 currentDay = uint64(block.timestamp / 1 days);
        if (policy.day != currentDay) {
            policy.day = currentDay;
            policy.spentToday = 0;
        }
        policy.spentToday += amountUSDC;
    }
}
