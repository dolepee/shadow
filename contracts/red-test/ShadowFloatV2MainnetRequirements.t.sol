// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloat} from "../src/ShadowFloat.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function prank(address caller) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// @dev Isolated model of the unsafe global-pause pattern. Testnet V2 has no
/// pause mechanism; this fixture makes Packet B's exit-liveness requirement
/// executable without adding production code or changing V2.
contract LegacyGlobalPauseModel {
    bool public paused;
    uint256 public debt = 1;
    uint256 public reclaimable = 1;

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    function pause() external {
        paused = true;
    }

    function repay() external whenNotPaused {
        debt = 0;
    }

    function reclaim() external whenNotPaused {
        reclaimable = 0;
    }
}

/// @notice Deliberately failing Packet B requirements tests.
/// @dev Run only with `FOUNDRY_PROFILE=mainnet-red forge test -vv`. Exactly five
/// tests must fail until the requirements are ported to ShadowFloatMainnet.
contract ShadowFloatV2MainnetRequirementsTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USDC = 1e6;
    uint256 private constant AGENT_PK = 0xA11CE;
    uint256 private constant LEGACY_AGENT_PK = 0xB0B;
    address private constant SPONSOR = address(0x5100);
    address private constant PROVIDER = address(0xBEEF);
    bytes32 private constant ENDPOINT = keccak256("x402://mainnet-requirements");

    MockAsset private usdc;
    ShadowFloat private float;
    address private agent;

    function setUp() public {
        usdc = new MockAsset("Mock USDC", "USDC", 6);
        float = new ShadowFloat(address(usdc));
        agent = vm.addr(AGENT_PK);

        usdc.mint(SPONSOR, 10 * USDC);
        vm.prank(SPONSOR);
        usdc.approve(address(float), type(uint256).max);
    }

    function _open(address lineAgent) private {
        vm.prank(SPONSOR);
        float.openSponsoredLine(
            lineAgent,
            1 * USDC,
            keccak256("packet-b-sponsored-line"),
            uint64(block.timestamp + 7 days),
            PROVIDER,
            ENDPOINT,
            1 * USDC,
            1 * USDC,
            uint64(block.timestamp + 7 days)
        );
    }

    function _intent(uint256 nonce) private view returns (ShadowFloat.FloatSpendIntent memory) {
        return ShadowFloat.FloatSpendIntent({
            agent: agent,
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            amountUSDC: 10_000,
            maxDebtUSDC: 20_000,
            nonce: nonce,
            expiry: block.timestamp + 1 hours,
            executor: address(0),
            reason: "Packet B stale-intent reproduction"
        });
    }

    function _sign(ShadowFloat.FloatSpendIntent memory intent) private returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, float.hashFloatSpendIntent(intent));
        return bytes.concat(r, s, bytes1(v));
    }

    function test_RED_01_legacyOwnerCreditCannotConsumeSponsoredReserve() public {
        _open(agent);

        address legacyAgent = vm.addr(LEGACY_AGENT_PK);
        float.setProviderMandate(PROVIDER, ENDPOINT, 975_000, 975_000, uint64(block.timestamp + 7 days), true);
        float.grantFloat(legacyAgent, legacyAgent, 975_000, 9_300, keccak256("legacy-owner-credit"));

        vm.prank(legacyAgent);
        float.requestSpend(legacyAgent, PROVIDER, ENDPOINT, 975_000, keccak256("legacy-owner-spends-sponsored-reserve"));

        // Mainnet requirement: a debt-free sponsor must always reclaim its full
        // reserve. V2 reverts here because only 25,000 atomic USDC remains.
        vm.prank(SPONSOR);
        float.closeSponsoredLine(agent, SPONSOR, keccak256("full-sponsor-reclaim"));
    }

    function test_RED_02_oldSignatureCannotExecuteAfterCloseAndReopen() public {
        _open(agent);
        ShadowFloat.FloatSpendIntent memory stale = _intent(2);
        bytes memory staleSignature = _sign(stale);

        vm.prank(SPONSOR);
        float.closeSponsoredLine(agent, SPONSOR, keccak256("close-epoch-one"));
        _open(agent);

        (, bool allowed,) = float.requestSignedSpend(stale, staleSignature);
        require(!allowed, "RED-02: stale epoch signature paid after reopen");
    }

    function test_RED_03_defaultCannotExecuteBeforeMaturity() public {
        _open(agent);
        ShadowFloat.FloatSpendIntent memory intent = _intent(3);
        float.requestSignedSpend(intent, _sign(intent));

        vm.prank(SPONSOR);
        (bool defaultSucceeded,) = address(float)
            .call(
                abi.encodeWithSelector(
                    ShadowFloat.defaultSponsoredLine.selector, agent, SPONSOR, keccak256("immediate-default")
                )
            );
        require(!defaultSucceeded, "RED-03: sponsor defaulted before maturity");
    }

    function test_RED_04_feeOrTermsChangeInvalidatesPriorSignature() public {
        _open(agent);
        ShadowFloat.FloatSpendIntent memory stale = _intent(4);
        bytes memory staleSignature = _sign(stale);

        float.setFeeBps(100);
        vm.prank(SPONSOR);
        float.setSponsoredProviderMandate(
            agent, PROVIDER, ENDPOINT, 900_000, 900_000, uint64(block.timestamp + 6 days), true
        );

        (, bool allowed,) = float.requestSignedSpend(stale, staleSignature);
        require(!allowed, "RED-04: pre-change signature executed under new fee/terms");
    }

    function test_RED_05_pauseCannotBlockRepaymentOrReclaim() public {
        LegacyGlobalPauseModel model = new LegacyGlobalPauseModel();
        model.pause();

        (bool repaySucceeded,) = address(model).call(abi.encodeWithSelector(model.repay.selector));
        (bool reclaimSucceeded,) = address(model).call(abi.encodeWithSelector(model.reclaim.selector));

        require(repaySucceeded && reclaimSucceeded, "RED-05: global pause trapped repayment/reclaim");
    }
}
