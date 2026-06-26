// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloat} from "../src/ShadowFloat.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
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

contract Mock1271Signer {
    bytes4 constant MAGIC_VALUE = 0x1626ba7e;
    bytes32 public validHash;

    function setValidHash(bytes32 hash) external {
        validHash = hash;
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return hash == validHash ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}

contract ShadowFloatTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant USDC = 1e6;
    uint256 constant SIGNED_AGENT_PK = 0xA11CE;
    uint256 constant OTHER_SIGNER_PK = 0xB0B;
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

    function _grantSignedAgent() internal returns (address agent) {
        agent = vm.addr(SIGNED_AGENT_PK);
        shadowFloat.grantFloat(agent, agent, 1 * USDC, 9300, keccak256("signed-agent-v2"));
    }

    function _intent(address agent, uint256 amountUSDC, uint256 nonce, uint256 expiry)
        internal
        view
        returns (ShadowFloat.FloatSpendIntent memory)
    {
        return ShadowFloat.FloatSpendIntent({
            agent: agent,
            provider: provider,
            endpointHash: ENDPOINT,
            amountUSDC: amountUSDC,
            nonce: nonce,
            expiry: expiry,
            reason: "signed v2 spend intent"
        });
    }

    function _sign(uint256 privateKey, ShadowFloat.FloatSpendIntent memory intent)
        internal
        returns (bytes memory signature)
    {
        bytes32 digest = shadowFloat.hashFloatSpendIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = bytes.concat(r, s, bytes1(v));
    }

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
        require(shadowFloat.totalAvailableCreditUSDC() == 1 * USDC, "reserved available");
    }

    function testCannotGrantMoreAvailableCreditThanTreasuryCanFund() public {
        bool reverted = false;
        try shadowFloat.grantFloat(address(outsider), address(outsider), 11 * USDC, 8000, keccak256("oversized-line")) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "grant should preserve treasury solvency");
        (address wallet,,,,,,,,,) = shadowFloat.lines(address(outsider));
        require(wallet == address(0), "line reverted");
    }

    function testDeterministicScoreGrantSetsRecommendedLineAndExpiry() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        shadowFloat.grantFloatFromScore(
            address(outsider),
            address(outsider),
            2,
            0,
            1,
            0,
            0,
            0,
            0,
            keccak256("invited-score-line"),
            expiry
        );

        (,, uint256 creditLimitUSDC, uint256 availableCreditUSDC,,, uint64 lastReview,,,) =
            shadowFloat.lines(address(outsider));
        require(shadowFloat.deterministicScore(2, 0, 1, 0, 0, 0, 0) == 7850, "score formula");
        require(shadowFloat.recommendedLimitUSDC(7850) == 25_000, "limit formula");
        require(creditLimitUSDC == 25_000, "deterministic limit");
        require(availableCreditUSDC == 25_000, "deterministic available");
        require(lastReview > 0, "reviewed");
        require(shadowFloat.lineExpiries(address(outsider)) == expiry, "expiry");

        (bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.previewSpend(address(outsider), provider, ENDPOINT, 10_000, keccak256("invited-preview"));
        require(allowed, "allowed before expiry");
        require(reason == ShadowFloat.BlockReason.NONE, "no reason");

        vm.warp(block.timestamp + 2 days);
        (allowed, reason) =
            shadowFloat.previewSpend(address(outsider), provider, ENDPOINT, 10_000, keccak256("invited-preview-expired"));
        require(!allowed, "blocked after expiry");
        require(reason == ShadowFloat.BlockReason.EXPIRED, "line expired");
    }

    function testWithdrawCannotBreakAvailableCreditReserve() public {
        bool reverted = false;
        try shadowFloat.withdraw(address(outsider), 9 * USDC + 1) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "withdraw should preserve line reserve");
        require(usdc.balanceOf(address(shadowFloat)) == 10 * USDC, "treasury unchanged");
        shadowFloat.withdraw(address(outsider), 9 * USDC);
        require(usdc.balanceOf(address(shadowFloat)) == 1 * USDC, "reserve remains");
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
        require(shadowFloat.totalAvailableCreditUSDC() == 900_000, "reserved available reduced");
    }

    function testFeeAccruesIntoDebtWithoutChangingProviderPayment() public {
        shadowFloat.setFeeBps(100);
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("alpha-fee-backed-spend")
        );

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(usdc.balanceOf(provider) == providerBefore + 100_000, "provider paid action amount");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore - 100_000, "treasury fronts action amount");
        require(shadowFloat.totalProviderPaidUSDC() == 100_000, "paid total");
        require(shadowFloat.totalFeesAccruedUSDC() == 1_000, "fee accrued");
        require(shadowFloat.totalDebtOpenedUSDC() == 101_000, "debt includes fee");
        require(shadowFloat.receiptCount() == 6, "grant+deny+allow+paid+fee+debt receipts");

        (,,, uint256 availableCreditUSDC, uint256 activeDebtUSDC,,,,,) = shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 899_000, "available reduced by amount plus fee");
        require(activeDebtUSDC == 101_000, "debt includes fee");
        require(shadowFloat.totalAvailableCreditUSDC() == 899_000, "reserve tracks available");
    }

    function testRecordX402SpendBindsSettlementAndReimbursesFacilitator() public {
        address facilitator = address(this);
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
        require(shadowFloat.totalAvailableCreditUSDC() == 900_000, "reserved available reduced");
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
            address(this)
        );

        bool reverted = false;
        try shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            requestHash,
            keccak256("settlement-two"),
            address(this)
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "duplicate x402 bind should revert");
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
            address(this)
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "allowed x402 spend should require settlement hash");
        require(shadowFloat.totalProviderPaidUSDC() == 0, "not reimbursed");
    }

    function testRecordX402SpendReimbursesOnlySubmittingOperator() public {
        bool reverted = false;
        try shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("alpha-x402-wrong-facilitator"),
            keccak256("settlement-wrong-facilitator"),
            address(treasuryFunder)
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "facilitator must submit bind");
        require(shadowFloat.totalProviderPaidUSDC() == 0, "not reimbursed");
    }

    function testSignedSpendVerifiesOnchainAndPaysProvider() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 1, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);
        bytes32 requestHash = shadowFloat.hashFloatSpendIntent(intent);
        uint256 providerBefore = usdc.balanceOf(provider);

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.requestSignedSpend(intent, signature);

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(shadowFloat.intentNonceUsed(agent, 1), "nonce used");
        require(shadowFloat.receiptByRequestHash(requestHash) != bytes32(0), "request bound");
        require(usdc.balanceOf(provider) == providerBefore + 100_000, "provider paid");

        (,,, uint256 availableCreditUSDC, uint256 activeDebtUSDC,,,,,) = shadowFloat.lines(agent);
        require(availableCreditUSDC == 900_000, "available reduced");
        require(activeDebtUSDC == 100_000, "debt opened");
    }

    function testSignedX402SpendVerifiesOnchainBeforeReimbursement() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 2, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);
        bytes32 requestHash = shadowFloat.hashFloatSpendIntent(intent);
        bytes32 x402Hash = keccak256("signed-v2-x402-settlement");
        uint256 facilitatorBefore = usdc.balanceOf(address(this));

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.recordSignedX402Spend(intent, x402Hash, address(this), signature);

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(shadowFloat.intentNonceUsed(agent, 2), "nonce used");
        require(shadowFloat.receiptByRequestHash(requestHash) != bytes32(0), "request bound");
        require(usdc.balanceOf(address(this)) == facilitatorBefore + 100_000, "facilitator reimbursed");
    }

    function testSignedSpendRejectsWrongSigner() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 3, block.timestamp + 1 hours);
        bytes memory signature = _sign(OTHER_SIGNER_PK, intent);

        bool reverted = false;
        try shadowFloat.requestSignedSpend(intent, signature) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "wrong signer rejected");
        require(!shadowFloat.intentNonceUsed(agent, 3), "nonce remains unused");
        require(usdc.balanceOf(provider) == 0, "provider unpaid");
    }

    function testSignedSpendRejectsTamperedIntentFields() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory signedIntent = _intent(agent, 100_000, 31, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, signedIntent);
        ShadowFloat.FloatSpendIntent memory tampered = signedIntent;
        tampered.amountUSDC = 101_000;

        bool amountReverted = false;
        try shadowFloat.requestSignedSpend(tampered, signature) {
            amountReverted = false;
        } catch {
            amountReverted = true;
        }

        require(amountReverted, "tampered amount rejected");
        require(!shadowFloat.intentNonceUsed(agent, 31), "amount tamper nonce unused");

        tampered = signedIntent;
        tampered.provider = address(0xCAFE);
        bool providerReverted = false;
        try shadowFloat.requestSignedSpend(tampered, signature) {
            providerReverted = false;
        } catch {
            providerReverted = true;
        }

        require(providerReverted, "tampered provider rejected");
        require(!shadowFloat.intentNonceUsed(agent, 31), "provider tamper nonce unused");
        require(usdc.balanceOf(provider) == 0, "provider unpaid");
    }

    function testSignedSpendRejectsExpiredIntent() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 4, block.timestamp - 1);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);

        bool reverted = false;
        try shadowFloat.requestSignedSpend(intent, signature) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "expired intent rejected");
        require(!shadowFloat.intentNonceUsed(agent, 4), "nonce remains unused");
    }

    function testSignedSpendRejectsCancelledIntent() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 5, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);

        bool cancelReverted = false;
        try shadowFloat.cancelIntent(agent, 5) {
            cancelReverted = false;
        } catch {
            cancelReverted = true;
        }
        require(cancelReverted, "only signer can cancel");

        vm.prank(agent);
        shadowFloat.cancelIntent(agent, 5);

        bool spendReverted = false;
        try shadowFloat.requestSignedSpend(intent, signature) {
            spendReverted = false;
        } catch {
            spendReverted = true;
        }

        require(spendReverted, "cancelled intent rejected");
        require(shadowFloat.intentNonceCancelled(agent, 5), "nonce cancelled");
        require(!shadowFloat.intentNonceUsed(agent, 5), "nonce remains unused");
    }

    function testConsumedSignedIntentCannotBeCancelled() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 51, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);
        shadowFloat.requestSignedSpend(intent, signature);

        vm.prank(agent);
        bool reverted = false;
        try shadowFloat.cancelIntent(agent, 51) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "used nonce cannot be cancelled");
        require(shadowFloat.intentNonceUsed(agent, 51), "nonce used");
        require(!shadowFloat.intentNonceCancelled(agent, 51), "nonce not cancelled");
    }

    function testSignedSpendRejectsReplay() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 6, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);

        shadowFloat.requestSignedSpend(intent, signature);

        bool reverted = false;
        try shadowFloat.requestSignedSpend(intent, signature) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "replay rejected");
        require(usdc.balanceOf(provider) == 100_000, "paid once");
    }

    function testBlockedSignedSpendConsumesNonceAndMovesNoFunds() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 5 * USDC, 7, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        (, bool allowed, ShadowFloat.BlockReason reason) = shadowFloat.requestSignedSpend(intent, signature);

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.AMOUNT_TOO_HIGH, "reason");
        require(shadowFloat.intentNonceUsed(agent, 7), "nonce consumed");
        require(usdc.balanceOf(provider) == 0, "provider unpaid");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore, "treasury unchanged");
    }

    function testSignedSpendSupportsERC1271Signer() public {
        Mock1271Signer signer = new Mock1271Signer();
        address agent = address(signer);
        shadowFloat.grantFloat(agent, agent, 1 * USDC, 9300, keccak256("erc1271-agent-v2"));
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 8, block.timestamp + 1 hours);
        signer.setValidHash(shadowFloat.hashFloatSpendIntent(intent));

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.requestSignedSpend(intent, hex"c0ffee");

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(shadowFloat.intentNonceUsed(agent, 8), "nonce used");
        require(usdc.balanceOf(provider) == 100_000, "provider paid");
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

    function testBlockedRequestHashCannotSpamReceipts() public {
        bytes32 requestHash = keccak256("alpha-oversize-no-spam");
        (bytes32 firstReceipt, bool allowed, ShadowFloat.BlockReason reason) =
            alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 5 * USDC, requestHash);
        require(!allowed, "first blocked");
        require(reason == ShadowFloat.BlockReason.AMOUNT_TOO_HIGH, "first reason");
        uint256 countAfterFirst = shadowFloat.receiptCount();

        (bytes32 secondReceipt, bool allowedAgain, ShadowFloat.BlockReason reasonAgain) =
            alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 5 * USDC, requestHash);
        require(!allowedAgain, "second blocked");
        require(reasonAgain == ShadowFloat.BlockReason.DUPLICATE_REQUEST, "duplicate reason");
        require(secondReceipt == firstReceipt, "returns original receipt");
        require(shadowFloat.receiptCount() == countAfterFirst, "no duplicate receipt written");
    }

    function testSpendRequiresNonzeroRequestHash() public {
        uint256 countBefore = shadowFloat.receiptCount();
        bool reverted = false;
        try alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 10_000, bytes32(0)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "zero hash rejected before receipt");
        require(shadowFloat.receiptCount() == countBefore, "zero hash cannot write receipts");

        (bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.previewSpend(address(alpha), provider, ENDPOINT, 10_000, bytes32(0));
        require(!allowed, "zero hash preview blocked");
        require(reason == ShadowFloat.BlockReason.MISSING_REQUEST_HASH, "preview reason");
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
        require(shadowFloat.totalAvailableCreditUSDC() == 1 * USDC, "reserved available restored");
    }

    function testDefaultedAgentCannotSpendAndRepayDoesNotRestoreCapacity() public {
        alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 100_000, keccak256("alpha-spend-before-default"));

        shadowFloat.markDefault(address(alpha), keccak256("alpha-default"));
        (,,, uint256 availableCreditUSDC, uint256 activeDebtUSDC, ShadowFloat.AgentStatus status,,,,) =
            shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 0, "default removes capacity");
        require(activeDebtUSDC == 100_000, "default keeps debt");
        require(status == ShadowFloat.AgentStatus.DEFAULTED, "default status");
        require(shadowFloat.totalDefaultedUSDC() == 100_000, "default total");
        require(shadowFloat.defaultedDebtUSDC(address(alpha)) == 100_000, "agent default total");

        (, bool allowed, ShadowFloat.BlockReason reason) = alpha.requestSpend(
            shadowFloat,
            address(alpha),
            provider,
            ENDPOINT,
            10_000,
            keccak256("defaulted-agent-spend")
        );
        require(!allowed, "defaulted blocked");
        require(reason == ShadowFloat.BlockReason.DEFAULTED, "defaulted reason");

        alpha.repay(shadowFloat, address(alpha), 50_000, keccak256("default-partial-repay"));
        (,,, availableCreditUSDC, activeDebtUSDC, status,,,,) = shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 0, "partial default repay does not restore capacity");
        require(activeDebtUSDC == 50_000, "partial default debt");
        require(status == ShadowFloat.AgentStatus.DEFAULTED, "still defaulted");

        alpha.repay(shadowFloat, address(alpha), 50_000, keccak256("default-final-repay"));
        (,,, availableCreditUSDC, activeDebtUSDC, status,,,,) = shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 0, "final default repay still no capacity");
        require(activeDebtUSDC == 0, "default debt cleared");
        require(status == ShadowFloat.AgentStatus.REPAID, "repaid after default cure");
    }

    function testDefaultedLineCannotBeReclassifiedBeforeRepayment() public {
        alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 100_000, keccak256("alpha-spend-before-default-lock"));
        shadowFloat.markDefault(address(alpha), keccak256("alpha-default-lock"));

        bool reverted = false;
        try shadowFloat.denyAgent(address(alpha), address(alpha), 2_000, ALPHA_MANDATE, keccak256("deny-defaulted")) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "deny cannot reclassify defaulted debt");

        reverted = false;
        try shadowFloat.revoke(address(alpha), keccak256("revoke-defaulted")) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "revoke cannot reclassify defaulted debt");

        reverted = false;
        try shadowFloat.reduceLimit(address(alpha), 0, keccak256("reduce-defaulted")) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "reduce cannot reclassify defaulted debt");

        reverted = false;
        try shadowFloat.grantFloat(address(alpha), address(alpha), 1 * USDC, 9_300, ALPHA_MANDATE) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "grant cannot reclassify defaulted debt");

        (,,, uint256 availableCreditUSDC, uint256 activeDebtUSDC, ShadowFloat.AgentStatus status,,,,) =
            shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 0, "default capacity remains zero");
        require(activeDebtUSDC == 100_000, "default debt remains");
        require(status == ShadowFloat.AgentStatus.DEFAULTED, "status remains defaulted");
        require(shadowFloat.totalDefaultedUSDC() == 100_000, "default counted once");
    }

    function testNewDrawMovesRepaidLineBackToActiveDebtStatus() public {
        alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 100_000, keccak256("alpha-spend-before-redraw"));
        alpha.repay(shadowFloat, address(alpha), 100_000, keccak256("alpha-repay-before-redraw"));

        (,,,,, ShadowFloat.AgentStatus repaidStatus,,,,) = shadowFloat.lines(address(alpha));
        require(repaidStatus == ShadowFloat.AgentStatus.REPAID, "should be repaid before redraw");

        alpha.requestSpend(shadowFloat, address(alpha), provider, ENDPOINT, 100_000, keccak256("alpha-redraw-after-repay"));

        (,,, uint256 availableCreditUSDC, uint256 activeDebtUSDC, ShadowFloat.AgentStatus status,,,,) =
            shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 900_000, "available reduced again");
        require(activeDebtUSDC == 100_000, "debt active again");
        require(status == ShadowFloat.AgentStatus.LIMITED, "status active debt");
        require(shadowFloat.totalAvailableCreditUSDC() == 900_000, "reserved available active again");
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
        require(shadowFloat.totalAvailableCreditUSDC() == 500_000, "reserved reduced");

        shadowFloat.revoke(address(alpha), keccak256("alpha-revoke"));
        ShadowFloat.AgentStatus status;
        (,,, availableCreditUSDC,, status,,,,) = shadowFloat.lines(address(alpha));
        require(availableCreditUSDC == 0, "revoked available");
        require(status == ShadowFloat.AgentStatus.REVOKED, "revoked status");
        require(shadowFloat.totalAvailableCreditUSDC() == 0, "reserve released");
    }
}
