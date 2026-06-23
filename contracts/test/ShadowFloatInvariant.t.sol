// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloat} from "../src/ShadowFloat.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface Vm {
    function prank(address) external;
}

contract FloatInvariantActor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
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

    function repay(ShadowFloat shadowFloat, address agent, uint256 amountUSDC, bytes32 requestHash)
        external
        returns (bytes32 receiptHash)
    {
        return shadowFloat.repay(agent, amountUSDC, requestHash);
    }
}

contract ShadowFloatHandler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant OWNER = address(0xA11CE);
    uint256 constant USDC = 1e6;

    MockAsset public usdc;
    ShadowFloat public shadowFloat;

    FloatInvariantActor[] internal agents;
    address[] internal providers;
    bytes32[] internal endpoints;
    bytes32[] internal touchedRequestHashes;
    uint256 public nextRequestNonce = 1;

    constructor() {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        shadowFloat = new ShadowFloat(address(usdc));

        agents.push(new FloatInvariantActor());
        agents.push(new FloatInvariantActor());
        agents.push(new FloatInvariantActor());
        agents.push(new FloatInvariantActor());

        providers.push(address(0xBEEF));
        providers.push(address(0xCAFE));
        endpoints.push(keccak256("x402://provider.market-signal.v1"));
        endpoints.push(keccak256("x402://provider.security-scan.v1"));

        usdc.mint(address(this), 2_000 * USDC);
        usdc.approve(address(shadowFloat), type(uint256).max);
        shadowFloat.fund(500 * USDC);

        for (uint256 i = 0; i < agents.length; i++) {
            usdc.mint(address(agents[i]), 200 * USDC);
            agents[i].approveToken(address(usdc), address(shadowFloat), type(uint256).max);
        }

        shadowFloat.setProviderMandate(providers[0], endpoints[0], 5 * USDC, 20 * USDC, uint64(block.timestamp + 30 days), true);
        shadowFloat.setProviderMandate(providers[1], endpoints[1], 5 * USDC, 20 * USDC, uint64(block.timestamp + 30 days), true);
        shadowFloat.grantFloat(agentAddress(0), agentAddress(0), 10 * USDC, 9_300, keccak256("agent-0-line"));
        shadowFloat.grantFloat(agentAddress(1), agentAddress(1), 5 * USDC, 8_100, keccak256("agent-1-line"));
        shadowFloat.denyAgent(agentAddress(2), agentAddress(2), 2_100, keccak256("agent-2-denied"), nextHash("seed-deny"));
        shadowFloat.transferOwnership(OWNER);
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    function agentAddress(uint256 index) public view returns (address) {
        return address(agents[index % agents.length]);
    }

    function touchedRequestHashCount() external view returns (uint256) {
        return touchedRequestHashes.length;
    }

    function touchedRequestHash(uint256 index) external view returns (bytes32) {
        return touchedRequestHashes[index];
    }

    function setFeeBps(uint16 rawBps) external {
        vm.prank(OWNER);
        shadowFloat.setFeeBps(rawBps % 1001);
    }

    function setProvider(uint8 providerSeed, uint8 endpointSeed, uint32 maxSeed, uint32 dailySeed, bool active) external {
        uint256 maxPerRequest = 1 + (uint256(maxSeed) % (10 * USDC));
        uint256 dailyLimit = maxPerRequest + (uint256(dailySeed) % (30 * USDC));
        vm.prank(OWNER);
        shadowFloat.setProviderMandate(
            providers[providerSeed % providers.length],
            endpoints[endpointSeed % endpoints.length],
            maxPerRequest,
            dailyLimit,
            uint64(block.timestamp + 30 days),
            active
        );
    }

    function fund(uint32 amountSeed) external {
        uint256 amount = 1 + (uint256(amountSeed) % (50 * USDC));
        if (usdc.balanceOf(address(this)) < amount) return;
        try shadowFloat.fund(amount) {} catch {}
    }

    function withdraw(uint32 amountSeed) external {
        uint256 amount = 1 + (uint256(amountSeed) % (50 * USDC));
        vm.prank(OWNER);
        try shadowFloat.withdraw(address(this), amount) {} catch {}
    }

    function grantFromScore(
        uint8 agentSeed,
        uint8 label,
        uint16 paidBound,
        uint16 signedExternalPaid,
        uint16 repaid,
        uint16 blocked,
        uint16 denied,
        uint16 errorCount,
        bool expiring
    ) external {
        address agent = agentAddress(agentSeed);
        uint64 expiry = expiring ? uint64(block.timestamp + 1 days) : 0;
        vm.prank(OWNER);
        try shadowFloat.grantFloatFromScore(
            agent,
            agent,
            label % 4,
            paidBound,
            signedExternalPaid,
            repaid,
            blocked,
            denied,
            errorCount,
            keccak256(abi.encode("score-line", agent, nextRequestNonce)),
            expiry
        ) {} catch {}
    }

    function deny(uint8 agentSeed) external {
        address agent = agentAddress(agentSeed);
        vm.prank(OWNER);
        try shadowFloat.denyAgent(agent, agent, 2_000, keccak256(abi.encode("deny", agent)), nextHash("deny")) {} catch {}
    }

    function reduce(uint8 agentSeed, uint32 newLimitSeed) external {
        address agent = agentAddress(agentSeed);
        uint256 newLimit = uint256(newLimitSeed) % (10 * USDC);
        vm.prank(OWNER);
        try shadowFloat.reduceLimit(agent, newLimit, nextHash("reduce")) {} catch {}
    }

    function revoke(uint8 agentSeed) external {
        vm.prank(OWNER);
        try shadowFloat.revoke(agentAddress(agentSeed), nextHash("revoke")) {} catch {}
    }

    function setLineExpiry(uint8 agentSeed, uint32 secondsFromNow) external {
        vm.prank(OWNER);
        try shadowFloat.setLineExpiry(agentAddress(agentSeed), uint64(block.timestamp + (uint256(secondsFromNow) % 30 days))) {} catch {}
    }

    function markDefault(uint8 agentSeed) external {
        vm.prank(OWNER);
        try shadowFloat.markDefault(agentAddress(agentSeed), nextHash("default")) {} catch {}
    }

    function requestSpend(uint8 agentSeed, uint8 providerSeed, uint8 endpointSeed, uint32 amountSeed) external {
        FloatInvariantActor actor = agents[agentSeed % agents.length];
        address provider = providers[providerSeed % providers.length];
        bytes32 endpoint = endpoints[endpointSeed % endpoints.length];
        uint256 amount = uint256(amountSeed) % (10 * USDC);
        bytes32 requestHash = nextHash("request");
        try actor.requestSpend(shadowFloat, address(actor), provider, endpoint, amount, requestHash) returns (
            bytes32 receiptHash,
            bool,
            ShadowFloat.BlockReason
        ) {
            if (receiptHash != bytes32(0)) touchedRequestHashes.push(requestHash);
        } catch {}
    }

    function recordX402Spend(uint8 agentSeed, uint8 providerSeed, uint8 endpointSeed, uint32 amountSeed, bool validX402) external {
        address agent = agentAddress(agentSeed);
        address provider = providers[providerSeed % providers.length];
        bytes32 endpoint = endpoints[endpointSeed % endpoints.length];
        uint256 amount = uint256(amountSeed) % (10 * USDC);
        bytes32 requestHash = nextHash("x402");
        bytes32 x402Hash = validX402 ? keccak256(abi.encode("x402", requestHash)) : bytes32(0);
        try shadowFloat.recordX402Spend(agent, provider, endpoint, amount, requestHash, x402Hash, address(this)) returns (
            bytes32 receiptHash,
            bool,
            ShadowFloat.BlockReason
        ) {
            if (receiptHash != bytes32(0)) touchedRequestHashes.push(requestHash);
        } catch {}
    }

    function repay(uint8 agentSeed, uint32 amountSeed) external {
        FloatInvariantActor actor = agents[agentSeed % agents.length];
        uint256 amount = 1 + (uint256(amountSeed) % (10 * USDC));
        try actor.repay(shadowFloat, address(actor), amount, nextHash("repay")) {} catch {}
    }

    function nextHash(string memory label) internal returns (bytes32 requestHash) {
        requestHash = keccak256(abi.encode(label, nextRequestNonce++));
    }
}

contract ShadowFloatInvariantTest {
    ShadowFloatHandler handler;
    ShadowFloat shadowFloat;
    MockAsset usdc;

    function setUp() public {
        handler = new ShadowFloatHandler();
        shadowFloat = handler.shadowFloat();
        usdc = handler.usdc();
    }

    function testFuzz_randomFloatOperationSequence(uint256 seed) public {
        for (uint256 i = 0; i < 80; i++) {
            bytes32 entropy = keccak256(abi.encode(seed, i));
            uint256 entropyWord = uint256(entropy);
            uint8 a = uint8(entropy[0]);
            uint8 b = uint8(entropy[1]);
            uint8 c = uint8(entropy[2]);
            uint32 d = _u32(entropy, 3);
            uint16 e = _u16(entropy, 7);

            uint256 action = entropyWord % 12;
            if (action == 0) handler.setFeeBps(e);
            else if (action == 1) handler.setProvider(a, b, d, _u32(entropy, 11), entropyWord & 1 == 0);
            else if (action == 2) handler.fund(d);
            else if (action == 3) handler.withdraw(d);
            else if (action == 4) {
                handler.grantFromScore(
                    a,
                    b,
                    e,
                    _u16(entropy, 9),
                    _u16(entropy, 11),
                    _u16(entropy, 13),
                    _u16(entropy, 15),
                    _u16(entropy, 17),
                    entropyWord & 2 == 0
                );
            }
            else if (action == 5) handler.deny(a);
            else if (action == 6) handler.reduce(a, d);
            else if (action == 7) handler.revoke(a);
            else if (action == 8) handler.setLineExpiry(a, d);
            else if (action == 9) handler.markDefault(a);
            else if (action == 10) handler.requestSpend(a, b, c, d);
            else handler.recordX402Spend(a, b, c, d, entropyWord & 4 == 0);

            assertTreasuryAlwaysBacksAvailableCredit();
            assertTotalAvailableCreditMatchesLines();
            assertLineStateIsInternallyConsistent();
            assertGlobalAccountingIsMonotoneSane();
            assertUsedRequestHashesHaveReceipts();
        }
    }

    function _u16(bytes32 entropy, uint256 offset) private pure returns (uint16) {
        return (uint16(uint8(entropy[offset])) << 8) | uint16(uint8(entropy[offset + 1]));
    }

    function _u32(bytes32 entropy, uint256 offset) private pure returns (uint32) {
        return (uint32(uint8(entropy[offset])) << 24) | (uint32(uint8(entropy[offset + 1])) << 16)
            | (uint32(uint8(entropy[offset + 2])) << 8) | uint32(uint8(entropy[offset + 3]));
    }

    function invariant_treasuryAlwaysBacksAvailableCredit() public view {
        assertTreasuryAlwaysBacksAvailableCredit();
    }

    function invariant_totalAvailableCreditMatchesLines() public view {
        assertTotalAvailableCreditMatchesLines();
    }

    function invariant_lineStateIsInternallyConsistent() public view {
        assertLineStateIsInternallyConsistent();
    }

    function invariant_globalAccountingIsMonotoneSane() public view {
        assertGlobalAccountingIsMonotoneSane();
    }

    function invariant_usedRequestHashesHaveReceipts() public view {
        assertUsedRequestHashesHaveReceipts();
    }

    function assertTreasuryAlwaysBacksAvailableCredit() internal view {
        require(usdc.balanceOf(address(shadowFloat)) >= shadowFloat.totalAvailableCreditUSDC(), "available credit insolvent");
    }

    function assertTotalAvailableCreditMatchesLines() internal view {
        uint256 expected;
        uint256 count = handler.agentCount();
        for (uint256 i = 0; i < count; i++) {
            (,,, uint256 availableCreditUSDC,,,,,,) = shadowFloat.lines(handler.agentAddress(i));
            expected += availableCreditUSDC;
        }
        require(expected == shadowFloat.totalAvailableCreditUSDC(), "available total mismatch");
    }

    function assertLineStateIsInternallyConsistent() internal view {
        uint256 count = handler.agentCount();
        for (uint256 i = 0; i < count; i++) {
            (,, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, ShadowFloat.AgentStatus status,,,,) =
                shadowFloat.lines(handler.agentAddress(i));
            require(availableCreditUSDC <= creditLimitUSDC, "available over limit");
            if (status == ShadowFloat.AgentStatus.REPAID) {
                require(activeDebtUSDC == 0, "repaid with active debt");
            }
            if (status == ShadowFloat.AgentStatus.DEFAULTED) {
                require(availableCreditUSDC == 0, "defaulted has capacity");
                require(creditLimitUSDC == 0, "defaulted has limit");
            }
            if (status == ShadowFloat.AgentStatus.DENIED || status == ShadowFloat.AgentStatus.REVOKED) {
                require(availableCreditUSDC == 0, "blocked status has capacity");
            }
        }
    }

    function assertGlobalAccountingIsMonotoneSane() internal view {
        require(shadowFloat.totalProviderPaidUSDC() <= shadowFloat.totalDebtOpenedUSDC(), "paid exceeds opened debt");
        require(shadowFloat.totalFeesAccruedUSDC() <= shadowFloat.totalDebtOpenedUSDC(), "fees exceed opened debt");
        require(shadowFloat.totalRepaidUSDC() <= shadowFloat.totalDebtOpenedUSDC(), "repaid exceeds opened debt");
        require(shadowFloat.totalDefaultedUSDC() <= shadowFloat.totalDebtOpenedUSDC(), "defaulted exceeds opened debt");
    }

    function assertUsedRequestHashesHaveReceipts() internal view {
        uint256 count = handler.touchedRequestHashCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 requestHash = handler.touchedRequestHash(i);
            require(requestHash != bytes32(0), "zero request hash recorded");
            require(shadowFloat.receiptByRequestHash(requestHash) != bytes32(0), "used request hash missing receipt");
        }
    }
}
