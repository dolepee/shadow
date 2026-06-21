// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloat} from "../src/ShadowFloat.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface Vm {
    function warp(uint256) external;
}

contract FloatActor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function fund(ShadowFloat shadowFloat, uint256 amountUSDC) external {
        shadowFloat.fund(amountUSDC);
    }

    function requestSpend(
        ShadowFloat shadowFloat,
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash
    ) external returns (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) {
        return shadowFloat.requestSpend(agent, provider, endpointHash, amountUSDC, requestHash);
    }

    function recordX402Spend(
        ShadowFloat shadowFloat,
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash,
        bytes32 x402Hash,
        address facilitator
    ) external returns (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) {
        return shadowFloat.recordX402Spend(agent, provider, endpointHash, amountUSDC, requestHash, x402Hash, facilitator);
    }

    function repay(ShadowFloat shadowFloat, address agent, uint256 amountUSDC, bytes32 requestHash)
        external
        returns (bytes32 receiptHash)
    {
        return shadowFloat.repay(agent, amountUSDC, requestHash);
    }
}

contract ShadowFloatTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant USDC = 1e6;
    bytes32 constant ENDPOINT = keccak256("x402://provider.market-signal.v1");
    bytes32 constant ALPHA_MANDATE = keccak256("alpha-approved-x402-market-data");
    bytes32 constant BETA_MANDATE = keccak256("beta-denied-slash-history");

    MockAsset usdc;
    ShadowFloat shadowFloat;
    FloatActor treasuryFunder;
    FloatActor alpha;
    FloatActor beta;
    FloatActor outsider;
    address provider = address(0xBEEF);

    function setUp() public {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        shadowFloat = new ShadowFloat(address(usdc));
        treasuryFunder = new FloatActor();
        alpha = new FloatActor();
        beta = new FloatActor();
        outsider = new FloatActor();

        usdc.mint(address(treasuryFunder), 20 * USDC);
        usdc.mint(address(alpha), 2 * USDC);

        treasuryFunder.approveToken(address(usdc), address(shadowFloat), type(uint256).max);
        alpha.approveToken(address(usdc), address(shadowFloat), type(uint256).max);
        treasuryFunder.fund(shadowFloat, 10 * USDC);

        shadowFloat.setProviderMandate(provider, ENDPOINT, 1 * USDC, 2 * USDC, uint64(block.timestamp + 7 days), true);
        shadowFloat.grantFloat(address(alpha), address(alpha), 1 * USDC, 9300, ALPHA_MANDATE);
        shadowFloat.denyAgent(address(beta), address(beta), 2100, BETA_MANDATE, keccak256("beta-denied-seed"));
    }

    function testEligibleAgentGetsFloatLine() public {
        (
            address wallet,
            uint16 score,
            uint256 creditLimitUSDC,
            uint256 availableCreditUSDC,
            uint256 activeDebtUSDC,
            ShadowFloat.AgentStatus status,
            ,
            bytes32 mandateId,
            ,
        ) = shadowFloat.lines(address(alpha));

        require(wallet == address(alpha), "wallet");
        require(score == 9300, "score");
        require(creditLimitUSDC == 1 * USDC, "limit");
        require(availableCreditUSDC == 1 * USDC, "available");
        require(activeDebtUSDC == 0, "debt");
        require(status == ShadowFloat.AgentStatus.ELIGIBLE, "status");
        require(mandateId == ALPHA_MANDATE, "mandate");
    }

    function testApprovedSpendPaysProviderAndOpensDebt() public {
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("alpha-x402-allow-1")
        );

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(usdc.balanceOf(provider) == providerBefore + 100_000, "provider paid");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore - 100_000, "treasury debited");
        require(shadowFloat.totalProviderPaidUSDC() == 100_000, "paid total");
        require(shadowFloat.totalDebtOpenedUSDC() == 100_000, "debt total");
        require(shadowFloat.receiptCount() == 5, "grant+deny+allow+paid+debt receipts");

        (,, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC,,,,,) =
            shadowFloat.lines(address(alpha));
        require(creditLimitUSDC == 1 * USDC, "limit unchanged");
        require(availableCreditUSDC == 900_000, "available reduced");
        require(activeDebtUSDC == 100_000, "debt opened");
    }

    function testRecordX402SpendBindsSettlementAndReimbursesFacilitator() public {
        address facilitator = address(treasuryFunder);
        bytes32 requestHash = keccak256("alpha-x402-bound-allow");
        bytes32 x402Hash = keccak256("real-x402-settlement-tx");
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 facilitatorBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) = shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            requestHash,
            x402Hash,
            facilitator
        );

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(usdc.balanceOf(provider) == providerBefore, "provider was already paid by x402");
        require(usdc.balanceOf(facilitator) == facilitatorBefore + 100_000, "facilitator reimbursed");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore - 100_000, "treasury debited");
        require(shadowFloat.totalProviderPaidUSDC() == 100_000, "paid total");
        require(shadowFloat.totalDebtOpenedUSDC() == 100_000, "debt total");
        require(shadowFloat.receiptCount() == 5, "grant+deny+allow+paid+debt receipts");

        (,, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC,,,,,) =
            shadowFloat.lines(address(alpha));
        require(creditLimitUSDC == 1 * USDC, "limit unchanged");
        require(availableCreditUSDC == 900_000, "available reduced");
        require(activeDebtUSDC == 100_000, "debt opened");
    }

    function testRecordX402SpendOversizedBlocksWithoutReimbursement() public {
        address facilitator = address(treasuryFunder);
        uint256 facilitatorBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        (, bool allowed, ShadowFloat.BlockReason reason) = shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            5 * USDC,
            keccak256("alpha-x402-oversize-bound"),
            bytes32(0),
            facilitator
        );

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.AMOUNT_TOO_HIGH, "reason");
        require(usdc.balanceOf(facilitator) == facilitatorBefore, "facilitator unchanged");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore, "treasury unchanged");
        require(shadowFloat.totalBlockedUSDC() == 5 * USDC, "blocked total");
        require(shadowFloat.receiptCount() == 3, "single block receipt");
    }

    function testRecordX402SpendDeniedAgentDoesNotReimburse() public {
        address facilitator = address(treasuryFunder);
        uint256 facilitatorBefore = usdc.balanceOf(facilitator);

        (, bool allowed, ShadowFloat.BlockReason reason) = shadowFloat.recordX402Spend(
            address(beta),
            provider,
            ENDPOINT,
            100_000,
            keccak256("beta-x402-denied-bound"),
            bytes32(0),
            facilitator
        );

        require(!allowed, "denied");
        require(reason == ShadowFloat.BlockReason.CREDIT_DENIED, "reason");
        require(usdc.balanceOf(facilitator) == facilitatorBefore, "facilitator unchanged");
        require(shadowFloat.totalDeniedUSDC() == 100_000, "denied total");
    }

    function testRecordX402SpendDuplicateRequestGuarded() public {
        bytes32 requestHash = keccak256("alpha-x402-duplicate-bound");
        shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            requestHash,
            keccak256("settlement-one"),
            address(treasuryFunder)
        );

        (, bool allowed, ShadowFloat.BlockReason reason) = shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            requestHash,
            keccak256("settlement-two"),
            address(treasuryFunder)
        );

        require(!allowed, "duplicate blocked");
        require(reason == ShadowFloat.BlockReason.DUPLICATE_REQUEST, "duplicate reason");
        require(shadowFloat.totalProviderPaidUSDC() == 100_000, "paid once");
    }

    function testRecordX402SpendAllowedRequiresSettlementHash() public {
        bool reverted = false;
        try shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("alpha-x402-zero-hash"),
            bytes32(0),
            address(treasuryFunder)
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "allowed x402 spend should require settlement hash");
        require(shadowFloat.totalProviderPaidUSDC() == 0, "not reimbursed");
    }

    function testOversizedSpendBlocksBeforeFundsMove() public {
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        (, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            ENDPOINT,
            5 * USDC,
            keccak256("alpha-x402-oversize")
        );

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.AMOUNT_TOO_HIGH, "reason");
        require(usdc.balanceOf(provider) == providerBefore, "provider unchanged");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore, "treasury unchanged");
        require(shadowFloat.totalBlockedUSDC() == 5 * USDC, "blocked total");
        require(shadowFloat.receiptCount() == 3, "single block receipt");
    }

    function testDeniedAgentCannotSpend() public {
        uint256 providerBefore = usdc.balanceOf(provider);

        (, bool allowed, ShadowFloat.BlockReason reason) = beta.requestSpend(
            shadowFloat,
            address(beta),
            provider,
            ENDPOINT,
            100_000,
            keccak256("beta-denied-spend")
        );

        require(!allowed, "denied");
        require(reason == ShadowFloat.BlockReason.CREDIT_DENIED, "reason");
        require(usdc.balanceOf(provider) == providerBefore, "provider unchanged");
        require(shadowFloat.totalDeniedUSDC() == 100_000, "denied total");
    }

    function testWrongProviderBlocksBeforeFundsMove() public {
        address wrongProvider = address(0xCAFE);
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        (, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            wrongProvider,
            ENDPOINT,
            100_000,
            keccak256("alpha-wrong-provider")
        );

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.PROVIDER_NOT_ALLOWED, "reason");
        require(usdc.balanceOf(wrongProvider) == 0, "wrong provider unpaid");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore, "treasury unchanged");
    }

    function testWrongEndpointBlocksBeforeFundsMove() public {
        (, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            keccak256("x402://unknown"),
            100_000,
            keccak256("alpha-wrong-endpoint")
        );

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.ENDPOINT_NOT_ALLOWED, "reason");
        require(usdc.balanceOf(provider) == 0, "provider unpaid");
    }

    function testRepaymentRefreshesAvailableCredit() public {
        alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 250_000, keccak256("alpha-spend-before-repay"));

        alpha.repay(shadowFloat, address(alpha), 250_000, keccak256("alpha-repay-1"));

        (,,, uint256 availableCreditUSDC, uint256 activeDebtUSDC, ShadowFloat.AgentStatus status,,,,) =
            shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 1 * USDC, "available refreshed");
        require(activeDebtUSDC == 0, "debt cleared");
        require(status == ShadowFloat.AgentStatus.REPAID, "status repaid");
        require(shadowFloat.totalRepaidUSDC() == 250_000, "repaid total");
    }

    function testDailyLimitBlocksAfterAllowedSpend() public {
        shadowFloat.setProviderMandate(provider, ENDPOINT, 1 * USDC, 1_500_000, uint64(block.timestamp + 7 days), true);
        shadowFloat.grantFloat(address(alpha), address(alpha), 2 * USDC, 9300, ALPHA_MANDATE);

        alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 1 * USDC, keccak256("alpha-day-1"));
        (, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            ENDPOINT,
            1 * USDC,
            keccak256("alpha-day-2")
        );

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.DAILY_LIMIT_EXCEEDED, "daily limit");
        require(usdc.balanceOf(provider) == 1 * USDC, "only first paid");
    }

    function testDuplicateRequestCannotOpenSecondDebt() public {
        bytes32 requestHash = keccak256("alpha-duplicate");
        alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 100_000, requestHash);
        (, bool allowed, ShadowFloat.BlockReason reason) =
            alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 100_000, requestHash);

        require(!allowed, "duplicate blocked");
        require(reason == ShadowFloat.BlockReason.DUPLICATE_REQUEST, "duplicate reason");
        require(usdc.balanceOf(provider) == 100_000, "paid once");
    }

    function testUnauthorizedCallerCannotSpendAnotherAgentFloat() public {
        bool reverted = false;
        try outsider.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("outsider-spend-alpha")
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "outsider should revert");
        require(usdc.balanceOf(provider) == 0, "provider unpaid");
    }

    function testExpiredProviderMandateBlocks() public {
        vm.warp(block.timestamp + 8 days);
        (, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("alpha-expired-provider")
        );

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.EXPIRED, "expired");
    }

    function testReduceAndRevokeLine() public {
        shadowFloat.reduceLimit(address(alpha), 500_000, keccak256("alpha-limit-reduce"));
        (,, uint256 creditLimitUSDC, uint256 availableCreditUSDC,,,,,,) = shadowFloat.lines(address(alpha));
        require(creditLimitUSDC == 500_000, "reduced limit");
        require(availableCreditUSDC == 500_000, "reduced available");

        shadowFloat.revoke(address(alpha), keccak256("alpha-revoke"));
        ShadowFloat.AgentStatus status;
        (,,, availableCreditUSDC,, status,,,,) = shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 0, "revoked available");
        require(status == ShadowFloat.AgentStatus.REVOKED, "revoked status");
    }
}
