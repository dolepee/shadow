// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {ShadowFloatMainnet} from "../src/ShadowFloatMainnet.sol";

interface VmMainnet {
    function addr(uint256 privateKey) external returns (address);
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract Mainnet1271Wallet {
    bytes4 private constant MAGIC = 0x1626ba7e;

    uint8 public mode;
    bytes32 public expectedDigest;
    address public target;
    bytes public reentryData;

    function configure(uint8 mode_, bytes32 expectedDigest_, address target_, bytes calldata reentryData_) external {
        mode = mode_;
        expectedDigest = expectedDigest_;
        target = target_;
        reentryData = reentryData_;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external returns (bytes4) {
        if (mode == 2) revert("wallet validation reverted");
        if (mode == 3) {
            assembly {
                mstore(0, 0)
                return(0, 1)
            }
        }
        if (mode == 4) {
            (bool ok,) = target.call(reentryData);
            require(!ok, "nested spend succeeded");
        }
        if (mode == 1 || digest != expectedDigest) return bytes4(0xffffffff);
        return MAGIC;
    }
}

contract ShadowFloatMainnetTest {
    VmMainnet private constant vm = VmMainnet(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USDC = 1e6;
    uint256 private constant SPONSOR_PK = 0x5100;
    uint256 private constant OTHER_SPONSOR_PK = 0x5200;
    uint256 private constant AGENT_PK = 0xA11CE;
    uint256 private constant OTHER_AGENT_PK = 0xB0B;
    uint256 private constant SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    address private constant PROVIDER = address(0xBEEF);
    bytes32 private constant ENDPOINT = keccak256("x402://mainnet/provider.v1");

    MockAsset private usdc;
    ShadowFloatMainnet private float;
    address private sponsor;
    address private otherSponsor;
    address private agent;
    address private otherAgent;

    function setUp() public {
        sponsor = vm.addr(SPONSOR_PK);
        otherSponsor = vm.addr(OTHER_SPONSOR_PK);
        agent = vm.addr(AGENT_PK);
        otherAgent = vm.addr(OTHER_AGENT_PK);

        usdc = new MockAsset("Mock USDC", "USDC", 6);
        ShadowFloatMainnet.Limits memory maxima = ShadowFloatMainnet.Limits({
            protocolReserve: 100 * USDC,
            lineReserve: 10 * USDC,
            lineSpend: 20 * USDC,
            perSpend: 5 * USDC,
            dailySpend: 10 * USDC
        });
        ShadowFloatMainnet.Limits memory initial = ShadowFloatMainnet.Limits({
            protocolReserve: 50 * USDC,
            lineReserve: 5 * USDC,
            lineSpend: 10 * USDC,
            perSpend: 2 * USDC,
            dailySpend: 5 * USDC
        });
        float = new ShadowFloatMainnet(
            address(usdc), block.chainid, maxima, initial, uint64(1 hours), uint64(7 days), uint64(2 days)
        );

        float.setSponsorAllowed(sponsor, true);
        float.setSponsorAllowed(otherSponsor, true);
        usdc.mint(sponsor, 100 * USDC);
        usdc.mint(otherSponsor, 100 * USDC);
        usdc.mint(agent, 100 * USDC);
        usdc.mint(otherAgent, 100 * USDC);
        _approve(sponsor);
        _approve(otherSponsor);
        _approve(agent);
        _approve(otherAgent);
    }

    function _approve(address actor) private {
        vm.prank(actor);
        usdc.approve(address(float), type(uint256).max);
    }

    function _params(address lineAgent, uint256 reserve, uint256 lineSpendCap)
        private
        view
        returns (ShadowFloatMainnet.OpenLineParams memory)
    {
        return ShadowFloatMainnet.OpenLineParams({
            agent: lineAgent,
            reserve: reserve,
            lineSpendCap: lineSpendCap,
            dailySpendCap: 5 * USDC,
            lineExpiry: uint64(block.timestamp + 30 days),
            maximumRepaymentWindow: uint64(7 days),
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            providerPerSpendCap: 2 * USDC,
            providerDailyCap: 5 * USDC,
            providerExpiry: uint64(block.timestamp + 30 days)
        });
    }

    function _open(address lineSponsor, address lineAgent) private returns (bytes32 lineId) {
        return _openWith(lineSponsor, lineAgent, 5 * USDC, 10 * USDC);
    }

    function _openWith(address lineSponsor, address lineAgent, uint256 reserve, uint256 lineSpendCap)
        private
        returns (bytes32 lineId)
    {
        ShadowFloatMainnet.OpenLineParams memory params = _params(lineAgent, reserve, lineSpendCap);
        vm.prank(lineSponsor);
        return float.openLine(params);
    }

    function _intent(bytes32 lineId, address lineSponsor, address lineAgent, uint256 principal, uint256 nonce)
        private
        view
        returns (ShadowFloatMainnet.SpendIntent memory intent)
    {
        ShadowFloatMainnet.Line memory line = float.getLine(lineId);
        intent = ShadowFloatMainnet.SpendIntent({
            agent: lineAgent,
            sponsor: lineSponsor,
            lineId: lineId,
            lineEpoch: line.epoch,
            termsHash: float.currentTermsHash(lineId, PROVIDER),
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            principal: principal,
            maximumTotalDebt: principal,
            dueAt: block.timestamp + 1 days,
            nonce: nonce,
            signatureExpiry: block.timestamp + 1 hours,
            executor: address(0)
        });
    }

    function _sign(uint256 privateKey, ShadowFloatMainnet.SpendIntent memory intent)
        private
        returns (bytes memory signature)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, float.hashSpendIntent(intent));
        return bytes.concat(r, s, bytes1(v));
    }

    function _draw(bytes32 lineId, uint256 principal, uint256 nonce)
        private
        returns (ShadowFloatMainnet.SpendIntent memory intent)
    {
        intent = _intent(lineId, sponsor, agent, principal, nonce);
        (bool paid, ShadowFloatMainnet.BlockReason reason) = float.executeSpend(intent, _sign(AGENT_PK, intent));
        _assertTrue(paid, "expected provider payment");
        _assertEq(uint256(reason), uint256(ShadowFloatMainnet.BlockReason.NONE), "unexpected block reason");
    }

    function test_RED_01_legacyOwnerCreditCannotConsumeSponsoredReserve() public {
        bytes32 protectedLine = _open(sponsor, agent);
        bytes32 otherLine = _open(otherSponsor, otherAgent);
        ShadowFloatMainnet.SpendIntent memory spend = _intent(otherLine, otherSponsor, otherAgent, 1 * USDC, 1);
        float.executeSpend(spend, _sign(OTHER_AGENT_PK, spend));

        (bool legacyCreditExists,) = address(float)
            .call(
                abi.encodeWithSignature(
                    "grantFloat(address,address,uint256,uint16,bytes32)", agent, agent, 5 * USDC, 9_000, bytes32(0)
                )
            );
        _assertTrue(!legacyCreditExists, "legacy owner credit surface exists");

        vm.prank(sponsor);
        float.closeLine(protectedLine);
        _assertEq(usdc.balanceOf(sponsor), 100 * USDC, "sponsor did not reclaim isolated reserve");
    }

    function test_RED_02_oldSignatureCannotExecuteAfterCloseAndReopen() public {
        bytes32 firstLine = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory stale = _intent(firstLine, sponsor, agent, 10_000, 2);
        bytes memory signature = _sign(AGENT_PK, stale);

        vm.prank(sponsor);
        float.closeLine(firstLine);
        bytes32 secondLine = _open(sponsor, agent);
        _assertTrue(secondLine != firstLine, "line epoch did not change");

        (bool ok,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, stale, signature));
        _assertTrue(!ok, "stale epoch signature executed");
        _assertEq(usdc.balanceOf(PROVIDER), 0, "stale signature paid provider");
    }

    function test_RED_03_defaultCannotExecuteBeforeMaturity() public {
        bytes32 lineId = _open(sponsor, agent);
        _draw(lineId, 1 * USDC, 3);

        vm.prank(sponsor);
        (bool ok,) = address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.declareDefault.selector, lineId));
        _assertTrue(!ok, "default succeeded before dueAt");
        _assertEq(
            uint256(float.getLine(lineId).state), uint256(ShadowFloatMainnet.LineState.DRAWN), "line left DRAWN state"
        );
    }

    function test_RED_04_feeOrTermsChangeInvalidatesPriorSignature() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory stale = _intent(lineId, sponsor, agent, 1 * USDC, 4);
        bytes memory signature = _sign(AGENT_PK, stale);

        (bool chargeSurface,) = address(float).call(abi.encodeWithSignature("setFeeBps(uint16)", uint16(100)));
        _assertTrue(!chargeSurface, "nonzero charge surface exists");

        vm.prank(sponsor);
        float.setProviderPolicy(lineId, PROVIDER, ENDPOINT, 1 * USDC, 4 * USDC, uint64(block.timestamp + 20 days), true);
        (bool ok,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, stale, signature));
        _assertTrue(!ok, "pre-change signature executed under new terms");
        _assertEq(usdc.balanceOf(PROVIDER), 0, "stale terms paid provider");
    }

    function test_RED_05_pauseCannotBlockRepaymentOrReclaim() public {
        bytes32 lineId = _open(sponsor, agent);
        _draw(lineId, 1 * USDC, 5);
        float.setOpeningsPaused(true);
        float.setSpendsPaused(true);

        vm.prank(agent);
        float.repay(lineId, 1 * USDC);
        vm.prank(sponsor);
        float.closeLine(lineId);
        _assertEq(usdc.balanceOf(sponsor), 100 * USDC, "pause trapped sponsor reserve");
    }

    function testRepaymentImmediatelyBeforeMaturity() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _draw(lineId, 1 * USDC, 10);
        vm.warp(intent.dueAt - 1);
        vm.prank(agent);
        float.repay(lineId, 1 * USDC);
        _assertEq(uint256(float.getLine(lineId).state), uint256(ShadowFloatMainnet.LineState.OPEN), "not reopened");
    }

    function testPartialAndFullRepaymentExactlyAtMaturity() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _draw(lineId, 1 * USDC, 11);
        vm.warp(intent.dueAt);
        vm.prank(agent);
        float.repay(lineId, 400_000);
        vm.prank(agent);
        float.repay(lineId, 600_000);
        _assertEq(float.getLine(lineId).principalOutstanding, 0, "debt remains at boundary");
    }

    function testPartialAndFullRepaymentAfterMaturityBeforeExpiry() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _draw(lineId, 1 * USDC, 12);
        vm.warp(intent.dueAt + 1 days);
        vm.prank(agent);
        float.repay(lineId, 400_000);
        vm.prank(agent);
        float.repay(lineId, 600_000);
        _assertEq(float.getLine(lineId).principalOutstanding, 0, "post-maturity debt remains");
    }

    function testPartialAndFullRepaymentAfterLineExpiryBeforeDefault() public {
        bytes32 lineId = _open(sponsor, agent);
        _draw(lineId, 1 * USDC, 13);
        uint256 lineExpiry = float.getLine(lineId).expiry;
        vm.warp(lineExpiry + 1);

        vm.prank(agent);
        float.repay(lineId, 400_000);
        vm.prank(agent);
        float.repay(lineId, 600_000);
        ShadowFloatMainnet.Line memory line = float.getLine(lineId);
        _assertEq(line.principalOutstanding, 0, "post-expiry debt remains");
        _assertEq(uint256(line.state), uint256(ShadowFloatMainnet.LineState.OPEN), "line did not reopen");

        vm.prank(sponsor);
        (bool defaultOk,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.declareDefault.selector, lineId));
        _assertTrue(!defaultOk, "fully repaid line defaulted");
    }

    function testDefaultSucceedsExactlyAtMaturityAndOnlyOnce() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _draw(lineId, 1 * USDC, 14);
        vm.warp(intent.dueAt);
        vm.prank(sponsor);
        float.declareDefault(lineId);
        vm.prank(sponsor);
        (bool secondDefault,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.declareDefault.selector, lineId));
        _assertTrue(!secondDefault, "default executed twice");
    }

    function testCumulativeLineSpendDoesNotReplenishAfterRepayment() public {
        bytes32 lineId = _openWith(sponsor, agent, 5 * USDC, 1_500_000);
        _draw(lineId, 1 * USDC, 20);
        vm.prank(agent);
        float.repay(lineId, 1 * USDC);

        ShadowFloatMainnet.SpendIntent memory second = _intent(lineId, sponsor, agent, 600_000, 21);
        (bool paid, ShadowFloatMainnet.BlockReason reason) = float.executeSpend(second, _sign(AGENT_PK, second));
        _assertTrue(!paid, "cumulative line spend replenished");
        _assertEq(uint256(reason), uint256(ShadowFloatMainnet.BlockReason.LINE_SPEND_CAP), "wrong cap reason");
    }

    function testPolicyBlockConsumesNonceAndCannotPayAfterUnpause() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, agent, 1 * USDC, 30);
        bytes memory signature = _sign(AGENT_PK, intent);
        float.setSpendsPaused(true);
        (bool paid, ShadowFloatMainnet.BlockReason reason) = float.executeSpend(intent, signature);
        _assertTrue(!paid, "paused intent paid");
        _assertEq(uint256(reason), uint256(ShadowFloatMainnet.BlockReason.SPENDS_PAUSED), "wrong reason");
        float.setSpendsPaused(false);
        (bool retryOk,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, intent, signature));
        _assertTrue(!retryOk, "blocked intent became payable");
    }

    function testAllowlistEndpointProviderAndCapBlocksAreTerminal() public {
        bytes32 lineId = _open(sponsor, agent);

        ShadowFloatMainnet.SpendIntent memory removedSponsor = _intent(lineId, sponsor, agent, 1 * USDC, 31);
        bytes memory removedSponsorSignature = _sign(AGENT_PK, removedSponsor);
        float.setSponsorAllowed(sponsor, false);
        _assertTerminalBlock(
            removedSponsor,
            removedSponsorSignature,
            ShadowFloatMainnet.BlockReason.SPONSOR_NOT_ALLOWED,
            "removed sponsor intent"
        );
        float.setSponsorAllowed(sponsor, true);

        ShadowFloatMainnet.SpendIntent memory wrongEndpoint = _intent(lineId, sponsor, agent, 1 * USDC, 32);
        wrongEndpoint.endpointHash = keccak256("x402://wrong-endpoint");
        _assertTerminalBlock(
            wrongEndpoint,
            _sign(AGENT_PK, wrongEndpoint),
            ShadowFloatMainnet.BlockReason.ENDPOINT_NOT_ALLOWED,
            "wrong endpoint intent"
        );

        vm.prank(sponsor);
        float.setProviderPolicy(lineId, PROVIDER, ENDPOINT, 0, 0, 0, false);
        ShadowFloatMainnet.SpendIntent memory disabledProvider = _intent(lineId, sponsor, agent, 1 * USDC, 33);
        _assertTerminalBlock(
            disabledProvider,
            _sign(AGENT_PK, disabledProvider),
            ShadowFloatMainnet.BlockReason.PROVIDER_NOT_ALLOWED,
            "disabled provider intent"
        );

        vm.prank(sponsor);
        float.setProviderPolicy(lineId, PROVIDER, ENDPOINT, 2 * USDC, 5 * USDC, uint64(block.timestamp + 30 days), true);
        ShadowFloatMainnet.SpendIntent memory reducedCap = _intent(lineId, sponsor, agent, 1 * USDC, 34);
        bytes memory reducedCapSignature = _sign(AGENT_PK, reducedCap);
        float.reduceCap(ShadowFloatMainnet.CapKind.PER_SPEND, 1 * USDC - 1);
        _assertTerminalBlock(
            reducedCap, reducedCapSignature, ShadowFloatMainnet.BlockReason.PER_SPEND_CAP, "reduced cap intent"
        );
    }

    function testCancelledNonceAndDuplicateSubmissionCannotPay() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory cancelled = _intent(lineId, sponsor, agent, 1 * USDC, 35);
        bytes memory cancelledSignature = _sign(AGENT_PK, cancelled);
        vm.prank(agent);
        float.cancelNonce(lineId, cancelled.nonce);
        _assertSpendReverts(cancelled, cancelledSignature, "cancelled nonce paid");

        ShadowFloatMainnet.SpendIntent memory submitted = _intent(lineId, sponsor, agent, 1 * USDC, 36);
        bytes memory submittedSignature = _sign(AGENT_PK, submitted);
        uint256 providerBefore = usdc.balanceOf(PROVIDER);
        (bool paid,) = float.executeSpend(submitted, submittedSignature);
        _assertTrue(paid, "first submission failed");
        _assertSpendReverts(submitted, submittedSignature, "duplicate submission paid");
        _assertEq(usdc.balanceOf(PROVIDER), providerBefore + 1 * USDC, "provider paid more than once");
    }

    function testAllSignedFieldsBindAndExecutorIsEnforced() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, agent, 1 * USDC, 40);
        bytes memory signature = _sign(AGENT_PK, intent);
        intent.maximumTotalDebt += 1;
        (bool mutatedOk,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, intent, signature));
        _assertTrue(!mutatedOk, "mutated signed field accepted");

        ShadowFloatMainnet.SpendIntent memory restricted = _intent(lineId, sponsor, agent, 1 * USDC, 41);
        restricted.executor = otherAgent;
        bytes memory restrictedSignature = _sign(AGENT_PK, restricted);
        (bool wrongExecutor,) = address(float)
            .call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, restricted, restrictedSignature));
        _assertTrue(!wrongExecutor, "wrong executor accepted");
        vm.prank(otherAgent);
        (bool paid,) = float.executeSpend(restricted, restrictedSignature);
        _assertTrue(paid, "bound executor could not submit");
    }

    function testContractDomainChangesDigest() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, agent, 1 * USDC, 49);
        ShadowFloatMainnet.Limits memory maxima = ShadowFloatMainnet.Limits({
            protocolReserve: 100 * USDC,
            lineReserve: 10 * USDC,
            lineSpend: 20 * USDC,
            perSpend: 5 * USDC,
            dailySpend: 10 * USDC
        });
        ShadowFloatMainnet other = new ShadowFloatMainnet(
            address(usdc), block.chainid, maxima, maxima, uint64(1 hours), uint64(7 days), uint64(2 days)
        );
        _assertTrue(float.hashSpendIntent(intent) != other.hashSpendIntent(intent), "contract domain not bound");
    }

    function testSignatureExpiryIsInclusiveAndExpiredIntentFails() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, agent, 1 * USDC, 42);
        bytes memory signature = _sign(AGENT_PK, intent);
        vm.warp(intent.signatureExpiry);
        (bool paid,) = float.executeSpend(intent, signature);
        _assertTrue(paid, "intent failed at inclusive expiry boundary");

        vm.prank(agent);
        float.repay(lineId, 1 * USDC);
        ShadowFloatMainnet.SpendIntent memory expired = _intent(lineId, sponsor, agent, 1 * USDC, 43);
        bytes memory expiredSignature = _sign(AGENT_PK, expired);
        vm.warp(expired.signatureExpiry + 1);
        _assertSpendReverts(expired, expiredSignature, "expired intent executed");
        _assertTrue(!float.nonceUsed(lineId, expired.nonce), "expired intent consumed nonce");
    }

    function testCanonicalEOASignatureRules() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, agent, 1 * USDC, 44);
        bytes32 digest = float.hashSpendIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);

        bytes32 highS = bytes32(SECP256K1_ORDER - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        _assertSpendReverts(intent, bytes.concat(r, highS, bytes1(flippedV)), "high-s accepted");
        _assertSpendReverts(intent, bytes.concat(r, s, bytes1(uint8(29))), "invalid-v accepted");
        _assertSpendReverts(intent, bytes.concat(r, s), "short signature accepted");
        _assertTrue(!float.nonceUsed(lineId, intent.nonce), "invalid EOA signature consumed nonce");
    }

    function testDebtAndDueAtBoundsAreEnforcedWithoutConsumingNonce() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory debtBound = _intent(lineId, sponsor, agent, 1 * USDC, 45);
        debtBound.maximumTotalDebt = 1 * USDC - 1;
        _assertSpendReverts(debtBound, _sign(AGENT_PK, debtBound), "debt above signed maximum executed");
        _assertTrue(!float.nonceUsed(lineId, debtBound.nonce), "bad debt bound consumed nonce");

        ShadowFloatMainnet.SpendIntent memory earlyDue = _intent(lineId, sponsor, agent, 1 * USDC, 46);
        earlyDue.dueAt = block.timestamp + 1 hours - 1;
        _assertSpendReverts(earlyDue, _sign(AGENT_PK, earlyDue), "too-early dueAt executed");

        ShadowFloatMainnet.SpendIntent memory exactDue = _intent(lineId, sponsor, agent, 1 * USDC, 47);
        exactDue.dueAt = block.timestamp + 1 hours;
        (bool paid,) = float.executeSpend(exactDue, _sign(AGENT_PK, exactDue));
        _assertTrue(paid, "minimum repayment window boundary failed");
    }

    function testCrossProviderTermsCannotBeSubstituted() public {
        bytes32 lineId = _open(sponsor, agent);
        address providerTwo = address(0xCAFE);
        vm.prank(sponsor);
        float.setProviderPolicy(
            lineId,
            providerTwo,
            keccak256("x402://other-provider"),
            1 * USDC,
            2 * USDC,
            uint64(block.timestamp + 20 days),
            true
        );

        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, agent, 1 * USDC, 48);
        intent.termsHash = float.currentTermsHash(lineId, providerTwo);
        _assertSpendReverts(intent, _sign(AGENT_PK, intent), "cross-provider terms accepted");
    }

    function testPerSpendAndDailyBoundaries() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory atCap = _intent(lineId, sponsor, agent, 2 * USDC, 70);
        (bool paid,) = float.executeSpend(atCap, _sign(AGENT_PK, atCap));
        _assertTrue(paid, "exact per-spend cap failed");
        vm.prank(agent);
        float.repay(lineId, 2 * USDC);

        ShadowFloatMainnet.SpendIntent memory next = _intent(lineId, sponsor, agent, 2 * USDC, 71);
        float.executeSpend(next, _sign(AGENT_PK, next));
        vm.prank(agent);
        float.repay(lineId, 2 * USDC);

        ShadowFloatMainnet.SpendIntent memory exactDaily = _intent(lineId, sponsor, agent, 1 * USDC, 72);
        float.executeSpend(exactDaily, _sign(AGENT_PK, exactDaily));
        vm.prank(agent);
        float.repay(lineId, 1 * USDC);

        ShadowFloatMainnet.SpendIntent memory overDaily = _intent(lineId, sponsor, agent, 1, 73);
        (bool dailyPaid, ShadowFloatMainnet.BlockReason reason) =
            float.executeSpend(overDaily, _sign(AGENT_PK, overDaily));
        _assertTrue(!dailyPaid, "daily cap exceeded");
        _assertEq(uint256(reason), uint256(ShadowFloatMainnet.BlockReason.DAILY_SPEND_CAP), "wrong daily cap reason");
    }

    function testSpendAboveFundedReserveBlocksTerminally() public {
        bytes32 lineId = _openWith(sponsor, agent, 1 * USDC, 5 * USDC);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, agent, 1 * USDC + 1, 74);
        _assertTerminalBlock(
            intent,
            _sign(AGENT_PK, intent),
            ShadowFloatMainnet.BlockReason.LINE_RESERVE_CAP,
            "spend above funded reserve"
        );
    }

    function testProviderPolicyEditCannotResetSameDayUsage() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory first = _intent(lineId, sponsor, agent, 1 * USDC, 75);
        float.executeSpend(first, _sign(AGENT_PK, first));
        vm.prank(agent);
        float.repay(lineId, 1 * USDC);

        vm.prank(sponsor);
        float.setProviderPolicy(lineId, PROVIDER, ENDPOINT, 2 * USDC, 1 * USDC, uint64(block.timestamp + 30 days), true);
        ShadowFloatMainnet.SpendIntent memory second = _intent(lineId, sponsor, agent, 1, 76);
        _assertTerminalBlock(
            second,
            _sign(AGENT_PK, second),
            ShadowFloatMainnet.BlockReason.DAILY_SPEND_CAP,
            "policy edit reset provider daily usage"
        );
    }

    function testPostDefaultRepaymentBecomesSponsorRecovery() public {
        bytes32 lineId = _open(sponsor, agent);
        ShadowFloatMainnet.SpendIntent memory intent = _draw(lineId, 1 * USDC, 80);
        vm.warp(intent.dueAt);
        vm.prank(sponsor);
        float.declareDefault(lineId);
        vm.prank(sponsor);
        float.claimDefaulted(lineId);
        _assertEq(float.totalCommittedCapital(), 1 * USDC, "default loss left committed incorrectly");

        vm.prank(agent);
        float.repay(lineId, 1 * USDC);
        ShadowFloatMainnet.Line memory recovered = float.getLine(lineId);
        _assertEq(recovered.recoveryAvailable, 1 * USDC, "recovery not assigned to sponsor");
        _assertEq(uint256(recovered.state), uint256(ShadowFloatMainnet.LineState.DEFAULTED), "capacity reopened");
        vm.prank(sponsor);
        float.claimDefaulted(lineId);
        _assertEq(float.totalCommittedCapital(), 0, "recovered default still committed");
        _assertEq(usdc.balanceOf(sponsor), 100 * USDC, "sponsor did not receive full recovery");
    }

    function testTwoStepOwnershipAndOperatorRemoval() public {
        address nextOwner = address(0xABCD);
        float.proposeOwner(nextOwner);
        vm.prank(nextOwner);
        float.acceptOwnership();
        _assertTrue(float.owner() == nextOwner, "ownership not accepted");

        vm.prank(nextOwner);
        float.setOperator(address(0x0F3A), true);
        vm.prank(nextOwner);
        float.setOperator(address(0x0F3A), false);
        vm.prank(address(0x0F3A));
        (bool pauseOk,) = address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.setSpendsPaused.selector, true));
        _assertTrue(!pauseOk, "removed operator retained authority");
    }

    function testFuzz_AccountingRemainsExactAfterPartialRepayment(uint96 rawPrincipal, uint96 rawRepayment) public {
        bytes32 lineId = _open(sponsor, agent);
        uint256 principal = 1 + (uint256(rawPrincipal) % (2 * USDC));
        _draw(lineId, principal, 90);
        uint256 repayment = 1 + (uint256(rawRepayment) % principal);
        vm.prank(agent);
        float.repay(lineId, repayment);

        ShadowFloatMainnet.Line memory line = float.getLine(lineId);
        _assertEq(line.availableReserve + line.principalOutstanding, 5 * USDC, "line capital diverged");
        _assertEq(usdc.balanceOf(address(float)), float.totalSponsorObligations(), "global obligation diverged");
        _assertEq(float.totalCommittedCapital(), 5 * USDC, "committed capital changed");
    }

    function testFuzz_ConcurrentSequenceMaintainsIsolation(bytes32 entropy) public {
        bytes32 first = _open(sponsor, agent);
        bytes32 second = _open(otherSponsor, otherAgent);
        uint256 firstNonce = 100;
        uint256 secondNonce = 200;

        for (uint256 i; i < 24; ++i) {
            uint8 choice = uint8(entropy[i]);
            bool useFirst = choice & 1 == 0;
            bytes32 lineId = useFirst ? first : second;
            address lineSponsor = useFirst ? sponsor : otherSponsor;
            address lineAgent = useFirst ? agent : otherAgent;
            uint256 privateKey = useFirst ? AGENT_PK : OTHER_AGENT_PK;
            ShadowFloatMainnet.Line memory line = float.getLine(lineId);

            if (choice % 7 == 0) {
                float.setSpendsPaused(!float.spendsPaused());
            } else if (line.state == ShadowFloatMainnet.LineState.OPEN) {
                uint256 principal = 1 + (uint256(choice) % 100_000);
                uint256 nonce = useFirst ? firstNonce++ : secondNonce++;
                ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, lineSponsor, lineAgent, principal, nonce);
                (bool ok,) = address(float)
                    .call(
                        abi.encodeWithSelector(
                            ShadowFloatMainnet.executeSpend.selector, intent, _sign(privateKey, intent)
                        )
                    );
                ok;
            } else if (line.state == ShadowFloatMainnet.LineState.DRAWN) {
                uint256 repayment = 1 + (uint256(choice) % line.principalOutstanding);
                vm.prank(lineAgent);
                float.repay(lineId, repayment);
            }

            vm.warp(block.timestamp + (uint256(choice) % 2 hours));
            _assertEq(usdc.balanceOf(address(float)), float.totalSponsorObligations(), "sequence insolvency");
            _assertActiveLineCapital(first, 5 * USDC);
            _assertActiveLineCapital(second, 5 * USDC);
        }
    }

    function testCapIncreaseIsDelayedAndOperatorCanOnlyCancel() public {
        address operator = address(0x0F3A);
        float.setOperator(operator, true);
        float.reduceCap(ShadowFloatMainnet.CapKind.PER_SPEND, 1 * USDC);
        float.proposeCapIncrease(ShadowFloatMainnet.CapKind.PER_SPEND, 2 * USDC);
        (bool early,) = address(float)
            .call(
                abi.encodeWithSelector(
                    ShadowFloatMainnet.activateCapIncrease.selector, ShadowFloatMainnet.CapKind.PER_SPEND
                )
            );
        _assertTrue(!early, "cap increase activated early");

        vm.prank(operator);
        float.cancelCapIncrease(ShadowFloatMainnet.CapKind.PER_SPEND);
        vm.prank(operator);
        (bool unpauseOk,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.setSpendsPaused.selector, false));
        _assertTrue(!unpauseOk, "operator unpaused spends");

        float.proposeCapIncrease(ShadowFloatMainnet.CapKind.PER_SPEND, 2 * USDC);
        vm.warp(block.timestamp + 2 days);
        float.activateCapIncrease(ShadowFloatMainnet.CapKind.PER_SPEND);
        (,,, uint256 perSpend,) = float.effectiveLimits();
        _assertEq(perSpend, 2 * USDC, "delayed cap did not activate");
    }

    function testImmutableMaximaAndOpeningCapsAreEnforced() public {
        _assertEq(float.maximumProtocolReserve(), 100 * USDC, "wrong protocol maximum");
        _assertEq(float.maximumLineReserve(), 10 * USDC, "wrong line maximum");
        _assertEq(float.maximumLineSpend(), 20 * USDC, "wrong line-spend maximum");
        _assertEq(float.maximumPerSpend(), 5 * USDC, "wrong per-spend maximum");
        _assertEq(float.maximumDailySpend(), 10 * USDC, "wrong daily maximum");

        ShadowFloatMainnet.OpenLineParams memory aboveLine = _params(agent, 5 * USDC + 1, 10 * USDC);
        vm.prank(sponsor);
        (bool aboveLineOk,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.openLine.selector, aboveLine));
        _assertTrue(!aboveLineOk, "line reserve above effective cap opened");

        float.reduceCap(ShadowFloatMainnet.CapKind.PROTOCOL_RESERVE, 5 * USDC);
        bytes32 exactLine = _open(sponsor, agent);
        _assertTrue(exactLine != bytes32(0), "line at exact protocol cap failed");
        ShadowFloatMainnet.OpenLineParams memory overProtocol = _params(otherAgent, 1, 1);
        vm.prank(otherSponsor);
        (bool overProtocolOk,) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.openLine.selector, overProtocol));
        _assertTrue(!overProtocolOk, "aggregate protocol cap exceeded");

        (bool aboveMaximumOk,) = address(float)
            .call(
                abi.encodeWithSelector(
                    ShadowFloatMainnet.proposeCapIncrease.selector,
                    ShadowFloatMainnet.CapKind.PROTOCOL_RESERVE,
                    100 * USDC + 1
                )
            );
        _assertTrue(!aboveMaximumOk, "immutable maximum exceeded");
    }

    function testConstructorRejectsWrongTokenDecimalsAndChain() public {
        ShadowFloatMainnet.Limits memory limits = ShadowFloatMainnet.Limits({
            protocolReserve: 5 * USDC,
            lineReserve: 5 * USDC,
            lineSpend: 5 * USDC,
            perSpend: 1 * USDC,
            dailySpend: 2 * USDC
        });
        MockAsset wrongDecimals = new MockAsset("Wrong", "WRONG", 18);

        try new ShadowFloatMainnet(
            address(wrongDecimals), block.chainid, limits, limits, uint64(1 hours), uint64(7 days), uint64(2 days)
        ) returns (
            ShadowFloatMainnet
        ) {
            revert("wrong decimals accepted");
        } catch {}
        try new ShadowFloatMainnet(
            address(usdc), block.chainid + 1, limits, limits, uint64(1 hours), uint64(7 days), uint64(2 days)
        ) returns (
            ShadowFloatMainnet
        ) {
            revert("wrong chain accepted");
        } catch {}
        try new ShadowFloatMainnet(
            address(0x1234), block.chainid, limits, limits, uint64(1 hours), uint64(7 days), uint64(2 days)
        ) returns (
            ShadowFloatMainnet
        ) {
            revert("non-contract token accepted");
        } catch {}
    }

    function testERC1271RejectsBadResponsesAndAllowsCaughtReentryOnce() public {
        Mainnet1271Wallet wallet = new Mainnet1271Wallet();
        bytes32 lineId = _open(sponsor, address(wallet));
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, sponsor, address(wallet), 1 * USDC, 50);
        bytes32 digest = float.hashSpendIntent(intent);
        bytes memory arbitrarySignature = hex"01";

        wallet.configure(1, digest, address(0), "");
        _assertSpendReverts(intent, arbitrarySignature, "wrong magic accepted");
        _assertTrue(!float.nonceUsed(lineId, intent.nonce), "wrong magic consumed nonce");

        wallet.configure(2, digest, address(0), "");
        _assertSpendReverts(intent, arbitrarySignature, "validation revert accepted");
        wallet.configure(3, digest, address(0), "");
        _assertSpendReverts(intent, arbitrarySignature, "malformed response accepted");

        bytes memory nested =
            abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, intent, arbitrarySignature);
        wallet.configure(4, digest, address(float), nested);
        uint256 providerBefore = usdc.balanceOf(PROVIDER);
        (bool paid,) = float.executeSpend(intent, arbitrarySignature);
        _assertTrue(paid, "valid outer ERC1271 authorization failed");
        _assertEq(usdc.balanceOf(PROVIDER), providerBefore + 1 * USDC, "outer payment was not exactly once");
    }

    function testRuntimeSizeAndZeroChargeSurface() public view {
        _assertTrue(address(float).code.length <= 18_432, "runtime exceeds Packet C ceiling");
        (bool readExists,) = address(float).staticcall(abi.encodeWithSignature("feeBps()"));
        _assertTrue(!readExists, "charge getter exists");
        (bool withdrawalExists,) =
            address(float).staticcall(abi.encodeWithSignature("withdrawFees(address,uint256)", address(this), 1));
        _assertTrue(!withdrawalExists, "charge withdrawal exists");
    }

    function testAggregateAccountingTracksSponsorObligations() public {
        bytes32 lineId = _open(sponsor, agent);
        _assertEq(float.totalCommittedCapital(), 5 * USDC, "wrong committed capital");
        _assertEq(float.totalSponsorObligations(), 5 * USDC, "wrong sponsor obligation");
        _draw(lineId, 1 * USDC, 60);
        _assertEq(float.totalCommittedCapital(), 5 * USDC, "spend changed committed capital");
        _assertEq(float.totalSponsorObligations(), 4 * USDC, "spend did not reduce liquid obligation");
        _assertEq(usdc.balanceOf(address(float)), 4 * USDC, "balance and obligation diverged");
        vm.prank(agent);
        float.repay(lineId, 1 * USDC);
        _assertEq(float.totalSponsorObligations(), 5 * USDC, "repayment did not restore obligation");
        _assertEq(usdc.balanceOf(address(float)), 5 * USDC, "repayment balance diverged");
    }

    function _assertSpendReverts(
        ShadowFloatMainnet.SpendIntent memory intent,
        bytes memory signature,
        string memory message
    ) private {
        (bool ok,) = address(float)
            .call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, intent, signature));
        _assertTrue(!ok, message);
    }

    function _assertTerminalBlock(
        ShadowFloatMainnet.SpendIntent memory intent,
        bytes memory signature,
        ShadowFloatMainnet.BlockReason expected,
        string memory message
    ) private {
        (bool paid, ShadowFloatMainnet.BlockReason reason) = float.executeSpend(intent, signature);
        _assertTrue(!paid, message);
        _assertEq(uint256(reason), uint256(expected), "wrong terminal block reason");
        _assertTrue(float.nonceUsed(intent.lineId, intent.nonce), "terminal block did not consume nonce");
        _assertEq(float.receiptStatus(float.hashSpendIntent(intent)), 1, "terminal block receipt missing");
        _assertSpendReverts(intent, signature, "terminal block became payable");
    }

    function _assertActiveLineCapital(bytes32 lineId, uint256 expected) private view {
        ShadowFloatMainnet.Line memory line = float.getLine(lineId);
        _assertEq(line.availableReserve + line.principalOutstanding, expected, "isolated line capital diverged");
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }
}
