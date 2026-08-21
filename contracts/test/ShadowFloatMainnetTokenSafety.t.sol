// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShadowFloatMainnet} from "../src/ShadowFloatMainnet.sol";
import {AdversarialUSDC} from "./mocks/AdversarialUSDC.sol";

interface VmMainnetToken {
    function addr(uint256 privateKey) external returns (address);
    function prank(address caller) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract ShadowFloatMainnetTokenSafetyTest {
    VmMainnetToken private constant vm = VmMainnetToken(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USDC = 1e6;
    uint256 private constant SPONSOR_PK = 0x5100;
    uint256 private constant AGENT_PK = 0xA11CE;
    address private constant PROVIDER = address(0xBEEF);
    bytes32 private constant ENDPOINT = keccak256("x402://adversarial-token");

    AdversarialUSDC private token;
    ShadowFloatMainnet private float;
    address private sponsor;
    address private agent;

    function setUp() public {
        sponsor = vm.addr(SPONSOR_PK);
        agent = vm.addr(AGENT_PK);
        token = new AdversarialUSDC();
        ShadowFloatMainnet.Limits memory limits = ShadowFloatMainnet.Limits({
            protocolReserve: 10 * USDC,
            lineReserve: 5 * USDC,
            lineSpend: 5 * USDC,
            perSpend: 2 * USDC,
            dailySpend: 5 * USDC
        });
        float = new ShadowFloatMainnet(
            address(token), block.chainid, limits, limits, uint64(1 hours), uint64(7 days), uint64(1 days)
        );
        float.setSponsorAllowed(sponsor, true);
        token.mint(sponsor, 10 * USDC);
        token.mint(agent, 10 * USDC);
        vm.prank(sponsor);
        token.approve(address(float), type(uint256).max);
        vm.prank(agent);
        token.approve(address(float), type(uint256).max);
    }

    function _open() private returns (bytes32 lineId) {
        ShadowFloatMainnet.OpenLineParams memory params = ShadowFloatMainnet.OpenLineParams({
            agent: agent,
            reserve: 5 * USDC,
            lineSpendCap: 5 * USDC,
            dailySpendCap: 5 * USDC,
            lineExpiry: uint64(block.timestamp + 30 days),
            maximumRepaymentWindow: uint64(7 days),
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            providerPerSpendCap: 2 * USDC,
            providerDailyCap: 5 * USDC,
            providerExpiry: uint64(block.timestamp + 30 days)
        });
        vm.prank(sponsor);
        lineId = float.openLine(params);
    }

    function _intent(bytes32 lineId, uint256 nonce) private view returns (ShadowFloatMainnet.SpendIntent memory) {
        ShadowFloatMainnet.Line memory line = float.getLine(lineId);
        return ShadowFloatMainnet.SpendIntent({
            agent: agent,
            sponsor: sponsor,
            lineId: lineId,
            lineEpoch: line.epoch,
            termsHash: float.currentTermsHash(lineId, PROVIDER),
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            principal: 1 * USDC,
            maximumTotalDebt: 1 * USDC,
            dueAt: block.timestamp + 1 days,
            nonce: nonce,
            signatureExpiry: block.timestamp + 1 hours,
            executor: address(0)
        });
    }

    function _sign(ShadowFloatMainnet.SpendIntent memory intent) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, float.hashSpendIntent(intent));
        return bytes.concat(r, s, bytes1(v));
    }

    function testInboundFalseMalformedRevertAndNonExactAreAtomic() public {
        uint8[4] memory modes = [token.FALSE_RETURN(), token.MALFORMED_RETURN(), token.REVERT_CALL(), token.NON_EXACT()];
        for (uint256 i; i < modes.length; ++i) {
            token.configure(modes[i], address(0), "");
            ShadowFloatMainnet.OpenLineParams memory params = ShadowFloatMainnet.OpenLineParams({
                agent: agent,
                reserve: 5 * USDC,
                lineSpendCap: 5 * USDC,
                dailySpendCap: 5 * USDC,
                lineExpiry: uint64(block.timestamp + 30 days),
                maximumRepaymentWindow: uint64(7 days),
                provider: PROVIDER,
                endpointHash: ENDPOINT,
                providerPerSpendCap: 2 * USDC,
                providerDailyCap: 5 * USDC,
                providerExpiry: uint64(block.timestamp + 30 days)
            });
            vm.prank(sponsor);
            (bool ok,) = address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.openLine.selector, params));
            require(!ok, "unsafe inbound token behavior accepted");
            require(float.totalCommittedCapital() == 0, "failed funding committed capital");
            require(float.totalSponsorObligations() == 0, "failed funding created obligation");
        }
    }

    function testOutgoingFailuresLeaveNonceDebtAndFundsUnchanged() public {
        bytes32 lineId = _open();
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, 1);
        bytes memory signature = _sign(intent);
        uint8[4] memory modes = [token.FALSE_RETURN(), token.MALFORMED_RETURN(), token.REVERT_CALL(), token.NON_EXACT()];
        for (uint256 i; i < modes.length; ++i) {
            token.configure(modes[i], address(0), "");
            (bool ok,) =
                address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, intent, signature));
            require(!ok, "unsafe outgoing token behavior accepted");
            require(!float.nonceUsed(lineId, intent.nonce), "failed transfer consumed nonce");
            ShadowFloatMainnet.Line memory line = float.getLine(lineId);
            require(line.principalOutstanding == 0, "failed transfer created debt");
            require(line.availableReserve == 5 * USDC, "failed transfer reduced reserve");
            require(token.balanceOf(PROVIDER) == 0, "failed transfer paid provider");
        }
    }

    function testTokenCallbackCannotReenterButOuterPaymentCompletesOnce() public {
        bytes32 lineId = _open();
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, 2);
        bytes memory signature = _sign(intent);
        bytes memory nested = abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, intent, signature);
        token.configure(token.REENTER(), address(float), nested);
        (bool paid,) = float.executeSpend(intent, signature);
        require(paid, "outer payment failed");
        require(token.balanceOf(PROVIDER) == 1 * USDC, "provider paid more than once");
        require(float.getLine(lineId).principalOutstanding == 1 * USDC, "debt not exact");
    }

    function testNonExactRepaymentIsAtomicEvenAfterMaturity() public {
        bytes32 lineId = _open();
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, 3);
        float.executeSpend(intent, _sign(intent));
        token.configure(token.NON_EXACT(), address(0), "");
        vm.prank(agent);
        (bool ok,) = address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.repay.selector, lineId, 1 * USDC));
        require(!ok, "non-exact repayment accepted");
        require(float.getLine(lineId).principalOutstanding == 1 * USDC, "failed repayment changed debt");
    }
}
