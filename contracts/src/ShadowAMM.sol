// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

contract ShadowAMM {
    IERC20 public immutable usdc;
    IERC20 public immutable asset;
    address public owner;
    uint256 public reserveUSDC;
    uint256 public reserveAsset;

    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS = 10_000;

    event LiquidityAdded(address indexed provider, uint256 usdcAmount, uint256 assetAmount);
    event SwapExecuted(
        address indexed caller,
        address indexed recipient,
        uint256 usdcIn,
        uint256 assetOut,
        uint256 reserveUSDCAfter,
        uint256 reserveAssetAfter
    );

    error NotOwner();
    error ZeroAmount();
    error InsufficientOutput();
    error InsufficientLiquidity();

    constructor(address usdc_, address asset_) {
        usdc = IERC20(usdc_);
        asset = IERC20(asset_);
        owner = msg.sender;
    }

    function addLiquidity(uint256 usdcAmount, uint256 assetAmount) external {
        if (msg.sender != owner) revert NotOwner();
        if (usdcAmount == 0 || assetAmount == 0) revert ZeroAmount();

        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "USDC_TRANSFER_FAILED");
        require(asset.transferFrom(msg.sender, address(this), assetAmount), "ASSET_TRANSFER_FAILED");

        reserveUSDC += usdcAmount;
        reserveAsset += assetAmount;

        emit LiquidityAdded(msg.sender, usdcAmount, assetAmount);
    }

    function quoteUSDCForAsset(uint256 usdcAmountIn) public view returns (uint256 assetOut) {
        if (usdcAmountIn == 0) return 0;
        if (reserveUSDC == 0 || reserveAsset == 0) return 0;

        uint256 amountInWithFee = usdcAmountIn * (BPS - FEE_BPS);
        return (reserveAsset * amountInWithFee) / ((reserveUSDC * BPS) + amountInWithFee);
    }

    function swapExactUSDCForAsset(address recipient, uint256 usdcAmountIn, uint256 minAssetOut)
        external
        returns (uint256 assetOut)
    {
        if (usdcAmountIn == 0) revert ZeroAmount();
        if (reserveUSDC == 0 || reserveAsset == 0) revert InsufficientLiquidity();

        assetOut = quoteUSDCForAsset(usdcAmountIn);
        if (assetOut < minAssetOut) revert InsufficientOutput();
        if (assetOut >= reserveAsset) revert InsufficientLiquidity();

        require(usdc.transferFrom(msg.sender, address(this), usdcAmountIn), "USDC_TRANSFER_FAILED");

        reserveUSDC += usdcAmountIn;
        reserveAsset -= assetOut;

        require(asset.transfer(recipient, assetOut), "ASSET_TRANSFER_FAILED");

        emit SwapExecuted(msg.sender, recipient, usdcAmountIn, assetOut, reserveUSDC, reserveAsset);
    }
}

