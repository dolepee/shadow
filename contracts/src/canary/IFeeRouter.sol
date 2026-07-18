// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interface to the deployed FeeRouterV1 on Arc testnet
/// (`0xeff9bc359e8f2a5eabce55af3f1bb24f98eabf59`). FeeRouter is an
/// accrue-then-claim primitive: `pay` routes an amount into per-recipient
/// claimable balances by basis-point shares; recipients withdraw via `claim`.
/// It is NOT a push-to-wallet transfer.
///
/// VERIFIED: as of 2026-07-18 this contract is SOURCE-VERIFIED on
/// testnet.arcscan.app as `FeeRouterV1`
/// (https://testnet.arcscan.app/address/0xeff9bc359e8f2a5eabce55af3f1bb24f98eabf59).
/// Reviewers can read the exact deployed source directly rather than trusting the
/// ABI. It has settled real transactions for Rising Technology, CitePay Markets,
/// and qdee.
///
/// Claim accounting (matches the verified source exactly):
///  - `claimableOf(splitId, recipient)` is a HISTORICAL, cumulative per-split view —
///    it is NOT decremented by `claim`.
///  - `totalClaimableOf(recipient)` is the OUTSTANDING claimable balance; `claim`
///    sweeps and zeroes exactly this.
interface IFeeRouter {
    struct SplitView {
        address creator;
        address[] recipients;
        uint16[] bps;
        uint256 totalRouted;
        uint64 createdAt;
    }

    function usdc() external view returns (address);

    function createSplit(address[] calldata recipients, uint16[] calldata bps) external returns (uint256 splitId);

    function pay(uint256 splitId, uint256 amount) external;

    /// @dev Historical cumulative allocation for (split, recipient). Not zeroed on claim.
    function claimableOf(uint256 splitId, address recipient) external view returns (uint256);

    /// @dev Sweeps the caller's outstanding `totalClaimableOf` and zeroes it.
    function claim() external returns (uint256 amount);

    /// @dev Outstanding (unclaimed) balance across all splits for the recipient.
    function totalClaimableOf(address recipient) external view returns (uint256);

    function splitAt(uint256 splitId) external view returns (SplitView memory);
}
