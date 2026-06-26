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

    function requestSignedSpend(
        ShadowFloat shadowFloat,
        ShadowFloat.FloatSpendIntent calldata intent,
        bytes calldata signature
    ) external returns (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) {
        return shadowFloat.requestSignedSpend(intent, signature);
    }

    function openSponsoredLine(
        ShadowFloat shadowFloat,
        address agent,
        uint256 reserveUSDC,
        bytes32 mandateId,
        uint64 lineExpiry,
        address provider,
        bytes32 endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC,
        uint64 providerExpiry
    ) external returns (bytes32 receiptHash) {
        return shadowFloat.openSponsoredLine(
            agent,
            reserveUSDC,
            mandateId,
            lineExpiry,
            provider,
            endpointHash,
            maxPerRequestUSDC,
            dailyLimitUSDC,
            providerExpiry
        );
    }

    function setSponsoredProviderMandate(
        ShadowFloat shadowFloat,
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC,
        uint64 expiry,
        bool active
    ) external {
        shadowFloat.setSponsoredProviderMandate(
            agent, provider, endpointHash, maxPerRequestUSDC, dailyLimitUSDC, expiry, active
        );
    }

    function closeSponsoredLine(ShadowFloat shadowFloat, address agent, address recipient, bytes32 requestHash)
        external
        returns (bytes32 receiptHash)
    {
        return shadowFloat.closeSponsoredLine(agent, recipient, requestHash);
    }

    function defaultSponsoredLine(ShadowFloat shadowFloat, address agent, address recipient, bytes32 requestHash)
        external
        returns (bytes32 receiptHash)
    {
        return shadowFloat.defaultSponsoredLine(agent, recipient, requestHash);
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

contract Reentrant1271Signer {
    bytes4 constant MAGIC_VALUE = 0x1626ba7e;

    ShadowFloat public target;
    ShadowFloat.FloatSpendIntent private intent;
    bytes private signature;
    bytes32 public validHash;

    function setReentry(ShadowFloat target_, ShadowFloat.FloatSpendIntent calldata intent_, bytes calldata signature_)
        external
    {
        target = target_;
        intent = intent_;
        signature = signature_;
        validHash = target_.hashFloatSpendIntent(intent_);
    }

    function isValidSignature(bytes32 hash, bytes calldata) external returns (bytes4) {
        if (address(target) != address(0)) {
            (bool ok,) = address(target).call(abi.encodeWithSelector(ShadowFloat.requestSignedSpend.selector, intent, signature));
            require(!ok, "reentry unexpectedly succeeded");
        }
        return hash == validHash ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}

contract ShadowFloatTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant USDC = 1e6;
    uint256 constant SIGNED_AGENT_PK = 0xA11CE;
    uint256 constant SPONSORED_AGENT_PK = 0x51A7E;
    uint256 constant OTHER_SIGNER_PK = 0xB0B;
    uint256 constant PROVIDER_PK = 0xBEEF;
    bytes32 constant ENDPOINT = keccak256("x402://provider.market-signal.v1");
    bytes32 constant ALPHA_MANDATE = keccak256("alpha-approved-x402-market-data");
    bytes32 constant BETA_MANDATE = keccak256("beta-denied-slash-history");
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant PROVIDER_DELIVERY_TYPEHASH = keccak256(
        "ProviderDeliveryReceipt(bytes32 requestHash,address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 responseHash,uint256 deliveredAt)"
    );

    MockAsset usdc;
    ShadowFloat shadowFloat;
    FloatActor treasuryFunder;
    FloatActor alpha;
    FloatActor beta;
    FloatActor outsider;
    FloatActor sponsor;
    address provider;

    function _grantSignedAgent() internal returns (address agent) {
        agent = vm.addr(SIGNED_AGENT_PK);
        shadowFloat.grantFloat(agent, agent, 1 * USDC, 9300, keccak256("signed-agent-v2"));
    }

    function _intent(address agent, uint256 amountUSDC, uint256 nonce, uint256 expiry)
        internal
        view
        returns (ShadowFloat.FloatSpendIntent memory)
    {
        return _intentFor(agent, provider, ENDPOINT, amountUSDC, nonce, expiry);
    }

    function _intentFor(
        address agent,
        address provider_,
        bytes32 endpointHash,
        uint256 amountUSDC,
        uint256 nonce,
        uint256 expiry
    ) internal pure returns (ShadowFloat.FloatSpendIntent memory) {
        return ShadowFloat.FloatSpendIntent({
            agent: agent,
            provider: provider_,
            endpointHash: endpointHash,
            amountUSDC: amountUSDC,
            maxDebtUSDC: amountUSDC + amountUSDC / 10,
            nonce: nonce,
            expiry: expiry,
            executor: address(0),
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

    function _delivery(bytes32 requestHash, address agent, uint256 amountUSDC, bytes32 responseHash)
        internal
        view
        returns (ShadowFloat.ProviderDeliveryReceipt memory)
    {
        return _deliveryFor(requestHash, agent, provider, ENDPOINT, amountUSDC, responseHash);
    }

    function _deliveryFor(
        bytes32 requestHash,
        address agent,
        address provider_,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 responseHash
    ) internal view returns (ShadowFloat.ProviderDeliveryReceipt memory) {
        return ShadowFloat.ProviderDeliveryReceipt({
            requestHash: requestHash,
            agent: agent,
            provider: provider_,
            endpointHash: endpointHash,
            amountUSDC: amountUSDC,
            responseHash: responseHash,
            deliveredAt: block.timestamp
        });
    }

    function _signDelivery(uint256 privateKey, ShadowFloat.ProviderDeliveryReceipt memory delivery)
        internal
        returns (bytes memory signature)
    {
        bytes32 digest = _hashDelivery(delivery);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = bytes.concat(r, s, bytes1(v));
    }

    function _hashDelivery(ShadowFloat.ProviderDeliveryReceipt memory delivery) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("ShadowFloat"),
                keccak256("1"),
                block.chainid,
                address(shadowFloat)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                PROVIDER_DELIVERY_TYPEHASH,
                delivery.requestHash,
                delivery.agent,
                delivery.provider,
                delivery.endpointHash,
                delivery.amountUSDC,
                delivery.responseHash,
                delivery.deliveredAt
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function setUp() public {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        shadowFloat = new ShadowFloat(address(usdc));
        treasuryFunder = new FloatActor();
        alpha = new FloatActor();
        beta = new FloatActor();
        outsider = new FloatActor();
        sponsor = new FloatActor();
        provider = vm.addr(PROVIDER_PK);

        usdc.mint(address(treasuryFunder), 20 * USDC);
        usdc.mint(address(alpha), 2 * USDC);
        usdc.mint(address(sponsor), 3 * USDC);

        treasuryFunder.approveToken(address(usdc), address(shadowFloat), type(uint256).max);
        alpha.approveToken(address(usdc), address(shadowFloat), type(uint256).max);
        sponsor.approveToken(address(usdc), address(shadowFloat), type(uint256).max);
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

    function testGrantRequiresAgentToBeItsSigningWallet() public {
        bool reverted = false;
        try shadowFloat.grantFloat(address(outsider), address(alpha), 1 * USDC, 8000, keccak256("wallet-mismatch")) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "line signer must be the agent address");
        (address wallet,,,,,,,,,) = shadowFloat.lines(address(outsider));
        require(wallet == address(0), "mismatched line reverted");
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

    function testUnsignedOperatorX402BindIsDisabled() public {
        bool reverted = false;
        try shadowFloat.recordX402Spend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("legacy-operator-x402"),
            keccak256("legacy-settlement"),
            address(this)
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "legacy unsigned x402 bind is disabled");
        require(shadowFloat.totalProviderPaidUSDC() == 0, "not reimbursed");
        require(shadowFloat.receiptCount() == 2, "no receipt written");
    }

    function testOperatorCannotDirectSpendAgainstAgentLineWithoutWalletAuthorization() public {
        bool reverted = false;
        try shadowFloat.requestSpend(
            address(alpha),
            provider,
            ENDPOINT,
            100_000,
            keccak256("operator-direct-spend-without-agent")
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "operator cannot spend without agent wallet authorization");
        require(usdc.balanceOf(provider) == 0, "provider unpaid");
        require(shadowFloat.totalProviderPaidUSDC() == 0, "no spend recorded");
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

    function testProviderCanConfirmDeliveryOnlyAfterPaidSpend() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 41, block.timestamp + 1 hours);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);
        bytes32 requestHash = shadowFloat.hashFloatSpendIntent(intent);

        shadowFloat.requestSignedSpend(intent, signature);
        require(shadowFloat.paidSpendCommitments(requestHash) != bytes32(0), "paid commitment");

        bytes32 responseHash = keccak256("provider-response-json");
        ShadowFloat.ProviderDeliveryReceipt memory delivery = _delivery(requestHash, agent, 100_000, responseHash);
        bytes32 deliveryHash = shadowFloat.recordProviderDelivery(delivery, _signDelivery(PROVIDER_PK, delivery));

        require(deliveryHash != bytes32(0), "delivery hash");
        require(shadowFloat.providerDeliveryByRequestHash(requestHash) == deliveryHash, "delivery recorded");
    }

    function testProviderDeliveryRejectsWrongSigner() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 42, block.timestamp + 1 hours);
        shadowFloat.requestSignedSpend(intent, _sign(SIGNED_AGENT_PK, intent));

        bytes32 requestHash = shadowFloat.hashFloatSpendIntent(intent);
        ShadowFloat.ProviderDeliveryReceipt memory delivery =
            _delivery(requestHash, agent, 100_000, keccak256("wrong-signer-response"));

        bool reverted = false;
        try shadowFloat.recordProviderDelivery(delivery, _signDelivery(OTHER_SIGNER_PK, delivery)) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "only provider signature accepted");
        require(shadowFloat.providerDeliveryByRequestHash(requestHash) == bytes32(0), "not recorded");
    }

    function testProviderDeliveryRejectsBlockedOrUnknownRequest() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory blockedIntent = _intent(agent, 5 * USDC, 43, block.timestamp + 1 hours);
        (, bool allowed,) = shadowFloat.requestSignedSpend(blockedIntent, _sign(SIGNED_AGENT_PK, blockedIntent));
        require(!allowed, "blocked setup");

        bytes32 requestHash = shadowFloat.hashFloatSpendIntent(blockedIntent);
        ShadowFloat.ProviderDeliveryReceipt memory delivery =
            _delivery(requestHash, agent, 5 * USDC, keccak256("blocked-response"));

        bool blockedReverted = false;
        try shadowFloat.recordProviderDelivery(delivery, _signDelivery(PROVIDER_PK, delivery)) {
            blockedReverted = false;
        } catch {
            blockedReverted = true;
        }
        require(blockedReverted, "blocked request has no delivery");

        ShadowFloat.ProviderDeliveryReceipt memory unknown =
            _delivery(keccak256("unknown-request"), agent, 100_000, keccak256("unknown-response"));
        bool unknownReverted = false;
        try shadowFloat.recordProviderDelivery(unknown, _signDelivery(PROVIDER_PK, unknown)) {
            unknownReverted = false;
        } catch {
            unknownReverted = true;
        }
        require(unknownReverted, "unknown request has no delivery");
    }

    function testProviderDeliveryRejectsMismatchedFieldsAndReplay() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 44, block.timestamp + 1 hours);
        shadowFloat.requestSignedSpend(intent, _sign(SIGNED_AGENT_PK, intent));
        bytes32 requestHash = shadowFloat.hashFloatSpendIntent(intent);

        ShadowFloat.ProviderDeliveryReceipt memory mismatched =
            _delivery(requestHash, agent, 99_999, keccak256("mismatched-response"));
        bool mismatchReverted = false;
        try shadowFloat.recordProviderDelivery(mismatched, _signDelivery(PROVIDER_PK, mismatched)) {
            mismatchReverted = false;
        } catch {
            mismatchReverted = true;
        }
        require(mismatchReverted, "mismatched delivery rejected");

        ShadowFloat.ProviderDeliveryReceipt memory delivery =
            _delivery(requestHash, agent, 100_000, keccak256("first-delivery"));
        shadowFloat.recordProviderDelivery(delivery, _signDelivery(PROVIDER_PK, delivery));

        ShadowFloat.ProviderDeliveryReceipt memory replay =
            _delivery(requestHash, agent, 100_000, keccak256("replay-delivery"));
        bool replayReverted = false;
        try shadowFloat.recordProviderDelivery(replay, _signDelivery(PROVIDER_PK, replay)) {
            replayReverted = false;
        } catch {
            replayReverted = true;
        }
        require(replayReverted, "delivery receipt is single-use");
    }

    function testProviderDeliverySupportsERC1271ProviderAndRejectsFutureDeliveryTime() public {
        address agent = _grantSignedAgent();
        Mock1271Signer providerSigner = new Mock1271Signer();
        shadowFloat.setProviderMandate(address(providerSigner), ENDPOINT, 1 * USDC, 2 * USDC, uint64(block.timestamp + 7 days), true);
        ShadowFloat.FloatSpendIntent memory intent =
            _intentFor(agent, address(providerSigner), ENDPOINT, 100_000, 45, block.timestamp + 1 hours);
        shadowFloat.requestSignedSpend(intent, _sign(SIGNED_AGENT_PK, intent));
        bytes32 requestHash = shadowFloat.hashFloatSpendIntent(intent);

        ShadowFloat.ProviderDeliveryReceipt memory delivery =
            _deliveryFor(requestHash, agent, address(providerSigner), ENDPOINT, 100_000, keccak256("erc1271-response"));
        bytes32 deliveryHash = _hashDelivery(delivery);
        providerSigner.setValidHash(deliveryHash);
        require(shadowFloat.recordProviderDelivery(delivery, hex"c0ffee") == deliveryHash, "erc1271 delivery");

        ShadowFloat.ProviderDeliveryReceipt memory future =
            _deliveryFor(keccak256("future-delivery"), agent, address(providerSigner), ENDPOINT, 100_000, keccak256("future-response"));
        future.deliveredAt = block.timestamp + 1;
        bool futureReverted = false;
        try shadowFloat.recordProviderDelivery(future, hex"c0ffee") {
            futureReverted = false;
        } catch {
            futureReverted = true;
        }
        require(futureReverted, "future delivery rejected");
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

    function testSignedSpendMaxDebtCapsCumulativeDebt() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory first = _intent(agent, 100_000, 46, block.timestamp + 1 hours);
        first.maxDebtUSDC = 200_000;
        shadowFloat.requestSignedSpend(first, _sign(SIGNED_AGENT_PK, first));

        ShadowFloat.FloatSpendIntent memory second = _intent(agent, 100_000, 47, block.timestamp + 1 hours);
        second.maxDebtUSDC = 100_000;
        bool reverted = false;
        try shadowFloat.requestSignedSpend(second, _sign(SIGNED_AGENT_PK, second)) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "cumulative max debt rejected");
        require(!shadowFloat.intentNonceUsed(agent, 47), "nonce unused after cumulative cap");
    }

    function testSponsorCanOpenPermissionlessLineAndAgentSignedSpendPaysProvider() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        uint256 sponsorBefore = usdc.balanceOf(address(sponsor));
        uint256 treasuryBefore = usdc.balanceOf(address(shadowFloat));

        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-funded-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        (address lineSponsor, uint256 reserveUSDC) = shadowFloat.lineSponsors(agent);
        require(lineSponsor == address(sponsor), "sponsor recorded");
        require(reserveUSDC == 1 * USDC, "reserve recorded");
        require(shadowFloat.totalSponsoredReserveUSDC() == 1 * USDC, "sponsored reserve total");
        require(usdc.balanceOf(address(sponsor)) == sponsorBefore - 1 * USDC, "sponsor funded reserve");
        require(usdc.balanceOf(address(shadowFloat)) == treasuryBefore + 1 * USDC, "contract received reserve");

        (, uint16 score, uint256 creditLimitUSDC, uint256 initialAvailable,,,,,,) = shadowFloat.lines(agent);
        require(score == 7_500, "baseline score");
        require(creditLimitUSDC == 25_000, "baseline earned limit");
        require(initialAvailable == 25_000, "baseline available");

        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 10_000, 101, block.timestamp + 1 hours);
        bytes memory signature = _sign(SPONSORED_AGENT_PK, intent);
        uint256 providerBefore = usdc.balanceOf(provider);
        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.requestSignedSpend(intent, signature);

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(usdc.balanceOf(provider) == providerBefore + 10_000, "provider paid directly");
        require(shadowFloat.intentNonceUsed(agent, 101), "nonce used");

        (,,, uint256 availableCreditUSDC, uint256 activeDebtUSDC,,,,,) = shadowFloat.lines(agent);
        require(availableCreditUSDC == 15_000, "available reduced");
        require(activeDebtUSDC == 10_000, "debt opened");
    }

    function testSponsoredLineRejectsLegacyRequestSpendAndOperatorX402() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-v2-only-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        bool legacyReverted = false;
        vm.prank(agent);
        try shadowFloat.requestSpend(agent, provider, ENDPOINT, 10_000, keccak256("sponsored-legacy-spend")) {
            legacyReverted = false;
        } catch {
            legacyReverted = true;
        }
        require(legacyReverted, "sponsored lines require signed intent path");

        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 10_000, 103, block.timestamp + 1 hours);
        bool x402Reverted = false;
        try shadowFloat.recordSignedX402Spend(
            intent,
            keccak256("sponsored-x402-disallowed"),
            address(this),
            _sign(SPONSORED_AGENT_PK, intent)
        ) {
            x402Reverted = false;
        } catch {
            x402Reverted = true;
        }
        require(x402Reverted, "sponsored lines use direct provider payment only");
        require(!shadowFloat.intentNonceUsed(agent, 103), "nonce unused after sponsored x402 reject");
    }

    function testSponsoredLineDebtIncludesFeeAndCloseRequiresRepayment() public {
        shadowFloat.setFeeBps(100);
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-fee-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 10_000, 102, block.timestamp + 1 hours);
        shadowFloat.requestSignedSpend(intent, _sign(SPONSORED_AGENT_PK, intent));
        (,, uint256 limitAfterSpend, uint256 availableCreditUSDC, uint256 activeDebtUSDC,,,,,) =
            shadowFloat.lines(agent);
        require(limitAfterSpend == 25_000, "limit unchanged until repay band");
        require(availableCreditUSDC == 14_900, "fee reduces capacity");
        require(activeDebtUSDC == 10_100, "debt includes fee");

        bool closeWhileDebtReverted = false;
        try sponsor.closeSponsoredLine(shadowFloat, agent, address(sponsor), keccak256("close-before-repay")) {
            closeWhileDebtReverted = false;
        } catch {
            closeWhileDebtReverted = true;
        }
        require(closeWhileDebtReverted, "cannot close active debt");

        uint256 sponsorBeforeClose = usdc.balanceOf(address(sponsor));
        sponsor.repay(shadowFloat, agent, 10_100, keccak256("sponsor-repay-full-debt"));
        (, uint16 scoreAfterRepay, uint256 limitAfterRepay, uint256 availableAfterRepay, uint256 debtRepaid,,,,,) =
            shadowFloat.lines(agent);
        require(scoreAfterRepay == 8_250, "repay increases score from behavior");
        require(limitAfterRepay == 50_000, "repay increases earned limit");
        require(availableAfterRepay == 50_000, "capacity restored to earned limit");
        require(debtRepaid == 0, "debt repaid");

        sponsor.closeSponsoredLine(shadowFloat, agent, address(sponsor), keccak256("sponsor-close-repaid-line"));

        (address lineSponsor, uint256 reserveUSDC) = shadowFloat.lineSponsors(agent);
        require(lineSponsor == address(0), "sponsor cleared");
        require(reserveUSDC == 0, "reserve cleared");
        (address wallet,, uint256 creditLimitUSDC, uint256 refreshedAvailable, uint256 debtAfter,,,,,) =
            shadowFloat.lines(agent);
        require(wallet == address(0), "wallet cleared");
        require(creditLimitUSDC == 0, "limit cleared");
        require(refreshedAvailable == 0, "available cleared");
        require(debtAfter == 0, "debt cleared");
        require(shadowFloat.totalSponsoredReserveUSDC() == 0, "sponsored reserve total cleared");
        (uint16 paid, uint16 signedPaid, uint16 repaid,,,) = shadowFloat.behaviorStats(agent);
        require(paid == 0 && signedPaid == 0 && repaid == 0, "behavior stats cleared");
        require(usdc.balanceOf(address(sponsor)) == sponsorBeforeClose - 10_100 + 1 * USDC, "reserve returned");
    }

    function testSponsorCanDefaultUnrepaidSponsoredLineAndRecoverRemainder() public {
        shadowFloat.setFeeBps(100);
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-default-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 10_000, 104, block.timestamp + 1 hours);
        shadowFloat.requestSignedSpend(intent, _sign(SPONSORED_AGENT_PK, intent));
        (,,, uint256 availableBeforeDefault, uint256 activeDebtBeforeDefault,,,,,) = shadowFloat.lines(agent);
        require(activeDebtBeforeDefault == 10_100, "debt includes fee before default");
        require(availableBeforeDefault == 14_900, "available before default");

        uint256 sponsorBeforeDefault = usdc.balanceOf(address(sponsor));
        bytes32 receiptHash =
            sponsor.defaultSponsoredLine(shadowFloat, agent, address(sponsor), keccak256("sponsor-default-recover"));

        require(receiptHash != bytes32(0), "default receipt");
        (address lineSponsor, uint256 reserveUSDC) = shadowFloat.lineSponsors(agent);
        require(lineSponsor == address(0) && reserveUSDC == 0, "sponsor cleared");
        (address wallet,, uint256 creditLimitUSDC, uint256 availableAfter, uint256 debtAfter, ShadowFloat.AgentStatus status,,,,) =
            shadowFloat.lines(agent);
        require(wallet == address(0), "wallet cleared");
        require(creditLimitUSDC == 0, "limit cleared");
        require(availableAfter == 0, "available cleared");
        require(debtAfter == 0, "debt written off");
        require(status == ShadowFloat.AgentStatus.DEFAULTED, "default status");
        require(shadowFloat.totalSponsoredReserveUSDC() == 0, "reserve floor released");
        require(shadowFloat.totalSponsoredAvailableCreditUSDC() == 0, "sponsored available cleared");
        require(shadowFloat.totalDefaultedUSDC() == 10_100, "default total");
        require(shadowFloat.defaultedDebtUSDC(agent) == 10_100, "agent default total");
        require(usdc.balanceOf(address(sponsor)) == sponsorBeforeDefault + 989_900, "remainder returned");
    }

    function testOwnerCannotRedirectSponsorDefaultRemainder() public {
        shadowFloat.setFeeBps(100);
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("owner-default-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 10_000, 114, block.timestamp + 1 hours);
        shadowFloat.requestSignedSpend(intent, _sign(SPONSORED_AGENT_PK, intent));

        bool redirected = false;
        try shadowFloat.defaultSponsoredLine(agent, address(alpha), keccak256("owner-redirect-default")) {
            redirected = true;
        } catch {}
        require(!redirected, "owner cannot redirect sponsor reserve");

        uint256 sponsorBeforeDefault = usdc.balanceOf(address(sponsor));
        shadowFloat.defaultSponsoredLine(agent, address(sponsor), keccak256("owner-default-to-sponsor"));
        require(usdc.balanceOf(address(sponsor)) == sponsorBeforeDefault + 989_900, "owner default returns to sponsor");
    }

    function testSponsoredBlockedSpendCutsEarnedLineFromBehavior() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-cut-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        (,, uint256 initialLimit, uint256 initialAvailable,,,,,,) = shadowFloat.lines(agent);
        require(initialLimit == 25_000, "initial earned limit");
        require(initialAvailable == 25_000, "initial earned available");

        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 5 * USDC, 202, block.timestamp + 1 hours);
        uint256 providerBefore = usdc.balanceOf(provider);
        (, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.requestSignedSpend(intent, _sign(SPONSORED_AGENT_PK, intent));

        require(!allowed, "blocked");
        require(reason == ShadowFloat.BlockReason.AMOUNT_TOO_HIGH, "blocked for overreach");
        require(usdc.balanceOf(provider) == providerBefore, "provider unpaid");

        (, uint16 scoreAfterBlock, uint256 limitAfterBlock, uint256 availableAfterBlock, uint256 debtAfterBlock,,,,,) =
            shadowFloat.lines(agent);
        (,,, uint16 blocked,,) = shadowFloat.behaviorStats(agent);
        require(blocked == 1, "blocked behavior counted");
        require(scoreAfterBlock == 7_250, "block reduces score");
        require(limitAfterBlock == 0, "block cuts earned limit");
        require(availableAfterBlock == 0, "available cut");
        require(debtAfterBlock == 0, "no debt opened");
    }

    function testOnlySponsorCanCloseOrChangeSponsoredProviderMandate() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-only-controls"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        bool nonSponsorCloseReverted = false;
        try outsider.closeSponsoredLine(shadowFloat, agent, address(outsider), keccak256("outsider-close")) {
            nonSponsorCloseReverted = false;
        } catch {
            nonSponsorCloseReverted = true;
        }
        require(nonSponsorCloseReverted, "non-sponsor close rejected");

        bool nonSponsorMandateReverted = false;
        try outsider.setSponsoredProviderMandate(
            shadowFloat,
            agent,
            provider,
            ENDPOINT,
            1,
            1,
            uint64(block.timestamp + 7 days),
            false
        ) {
            nonSponsorMandateReverted = false;
        } catch {
            nonSponsorMandateReverted = true;
        }
        require(nonSponsorMandateReverted, "non-sponsor provider policy rejected");
    }

    function testSponsoredProviderMandatesDoNotSurviveCloseAndReopen() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        address staleProvider = address(0xCAFE);
        bytes32 staleEndpoint = keccak256("x402://stale-provider");
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-epoch-one"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );
        sponsor.setSponsoredProviderMandate(
            shadowFloat,
            agent,
            staleProvider,
            staleEndpoint,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days),
            true
        );
        sponsor.closeSponsoredLine(shadowFloat, agent, address(sponsor), keccak256("close-epoch-one"));

        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-epoch-two"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        ShadowFloat.FloatSpendIntent memory staleIntent =
            _intentFor(agent, staleProvider, staleEndpoint, 10_000, 105, block.timestamp + 1 hours);
        (, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.requestSignedSpend(staleIntent, _sign(SPONSORED_AGENT_PK, staleIntent));
        require(!allowed, "stale provider rejected");
        require(reason == ShadowFloat.BlockReason.PROVIDER_NOT_ALLOWED, "stale provider reason");
        require(usdc.balanceOf(staleProvider) == 0, "stale provider unpaid");
    }

    function testSponsoredLineUsesSponsorProviderPolicyNotOwnerGlobalPolicy() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        address ownerAllowedProvider = address(0xCAFE);
        bytes32 ownerEndpoint = keccak256("x402://owner-global-provider");
        shadowFloat.setProviderMandate(
            ownerAllowedProvider,
            ownerEndpoint,
            1 * USDC,
            1 * USDC,
            uint64(block.timestamp + 7 days),
            true
        );
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-policy-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        ShadowFloat.FloatSpendIntent memory ownerGlobalIntent =
            _intentFor(agent, ownerAllowedProvider, ownerEndpoint, 100_000, 103, block.timestamp + 1 hours);
        (, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.requestSignedSpend(ownerGlobalIntent, _sign(SPONSORED_AGENT_PK, ownerGlobalIntent));
        require(!allowed, "owner-global provider ignored for sponsored line");
        require(reason == ShadowFloat.BlockReason.PROVIDER_NOT_ALLOWED, "sponsor policy required");
        require(usdc.balanceOf(ownerAllowedProvider) == 0, "owner global provider unpaid");
    }

    function testOwnerAdminCannotMutateSponsoredLineReserve() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-admin-protected-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        bool grantReverted = false;
        try shadowFloat.grantFloat(agent, agent, 1 * USDC, 9_300, keccak256("owner-regrant-sponsored-line")) {
            grantReverted = false;
        } catch {
            grantReverted = true;
        }
        require(grantReverted, "owner cannot regrant sponsored line");

        bool reduceReverted = false;
        try shadowFloat.reduceLimit(agent, 500_000, keccak256("owner-reduce-sponsored-line")) {
            reduceReverted = false;
        } catch {
            reduceReverted = true;
        }
        require(reduceReverted, "owner cannot reduce sponsored line");

        bool revokeReverted = false;
        try shadowFloat.revoke(agent, keccak256("owner-revoke-sponsored-line")) {
            revokeReverted = false;
        } catch {
            revokeReverted = true;
        }
        require(revokeReverted, "owner cannot revoke sponsored line");

        bool denyReverted = false;
        try shadowFloat.denyAgent(agent, agent, 1_000, keccak256("owner-deny-sponsored-line"), keccak256("deny")) {
            denyReverted = false;
        } catch {
            denyReverted = true;
        }
        require(denyReverted, "owner cannot deny sponsored line");

        bool defaultReverted = false;
        try shadowFloat.markDefault(agent, keccak256("owner-default-sponsored-line")) {
            defaultReverted = false;
        } catch {
            defaultReverted = true;
        }
        require(defaultReverted, "owner cannot default sponsored line");
    }

    function testWithdrawCannotDrainSponsorFundedAvailableReserve() public {
        address agent = vm.addr(SPONSORED_AGENT_PK);
        sponsor.openSponsoredLine(
            shadowFloat,
            agent,
            1 * USDC,
            keccak256("sponsor-withdraw-protected-agent"),
            uint64(block.timestamp + 7 days),
            provider,
            ENDPOINT,
            500_000,
            750_000,
            uint64(block.timestamp + 7 days)
        );

        bool reverted = false;
        try shadowFloat.withdraw(address(outsider), 9 * USDC + 1) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "owner withdraw cannot break sponsored reserve");

        shadowFloat.withdraw(address(outsider), 9 * USDC);
        require(usdc.balanceOf(address(shadowFloat)) == 2 * USDC, "alpha plus sponsored reserve remains");
        require(shadowFloat.totalAvailableCreditUSDC() == 1_025_000, "available reserve protected");
        require(shadowFloat.totalSponsoredAvailableCreditUSDC() == 25_000, "sponsored available tracked");
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

    function testSignedSpendCanRestrictExecutor() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 21, block.timestamp + 1 hours);
        intent.executor = address(alpha);
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);

        bool wrongExecutorReverted = false;
        try shadowFloat.requestSignedSpend(intent, signature) {
            wrongExecutorReverted = false;
        } catch {
            wrongExecutorReverted = true;
        }
        require(wrongExecutorReverted, "wrong executor rejected");
        require(!shadowFloat.intentNonceUsed(agent, 21), "nonce remains unused");

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) =
            alpha.requestSignedSpend(shadowFloat, intent, signature);
        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(shadowFloat.intentNonceUsed(agent, 21), "nonce used");
        require(usdc.balanceOf(provider) == 100_000, "provider paid");
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

    function testSignedSpendRejectsFeeAboveSignedMaxDebt() public {
        address agent = _grantSignedAgent();
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 32, block.timestamp + 1 hours);
        intent.maxDebtUSDC = 100_000;
        bytes memory signature = _sign(SIGNED_AGENT_PK, intent);
        shadowFloat.setFeeBps(100);

        bool reverted = false;
        try shadowFloat.requestSignedSpend(intent, signature) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "fee above signed max debt rejected");
        require(!shadowFloat.intentNonceUsed(agent, 32), "nonce remains unused");
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

    function testSignedSpendRejectsERC1271ReentryDuringSignatureCheck() public {
        Reentrant1271Signer signer = new Reentrant1271Signer();
        address agent = address(signer);
        shadowFloat.grantFloat(agent, agent, 1 * USDC, 9300, keccak256("reentrant-erc1271-agent-v2"));
        ShadowFloat.FloatSpendIntent memory intent = _intent(agent, 100_000, 9, block.timestamp + 1 hours);
        bytes memory signature = hex"c0ffee";
        signer.setReentry(shadowFloat, intent, signature);
        uint256 providerBefore = usdc.balanceOf(provider);

        (bytes32 receiptHash, bool allowed, ShadowFloat.BlockReason reason) =
            shadowFloat.requestSignedSpend(intent, signature);

        require(receiptHash != bytes32(0), "receipt");
        require(allowed, "allowed");
        require(reason == ShadowFloat.BlockReason.NONE, "reason");
        require(shadowFloat.intentNonceUsed(agent, 9), "nonce used");
        require(usdc.balanceOf(provider) == providerBefore + 100_000, "provider paid once");
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
