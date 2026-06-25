// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BondedMandateEnforcer} from "../src/BondedMandateEnforcer.sol";
import {MandateAttestor} from "../src/MandateAttestor.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MandateVaultSink} from "../src/MandateVaultSink.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {MorphoStyleVaultAdapter} from "../src/MorphoStyleVaultAdapter.sol";
import {RiskPolicy} from "../src/RiskPolicy.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract MorphoAdapterActor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function postBond(MorphoStyleVaultAdapter adapter, uint256 amountUSDC) external {
        adapter.postBond(amountUSDC);
    }

    function run(MorphoStyleVaultAdapter adapter, MandateRegistry.Action calldata action)
        external
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason)
    {
        return adapter.depositWithMandate(action);
    }
}

contract MorphoStyleVaultAdapterTest {
    uint256 constant USDC = 1e6;
    uint256 constant MIN_BOND = 10 * USDC;

    MockAsset usdc;
    MockAsset fakeUsdc;
    MandateRegistry registry;
    MandateAttestor attestor;
    BondedMandateEnforcer enforcer;
    MandateVaultSink vaultSink;
    MorphoStyleVaultAdapter adapter;

    MorphoAdapterActor circleWallet;
    MorphoAdapterActor bondFunder;
    MorphoAdapterActor caller;

    uint256 mandateId;
    bytes32 marketId;

    function setUp() public {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        fakeUsdc = new MockAsset("Not USDC", "nUSDC", 6);
        registry = new MandateRegistry(address(usdc));
        attestor = new MandateAttestor();
        enforcer = new BondedMandateEnforcer(address(usdc), address(registry), address(attestor), MIN_BOND);
        vaultSink = new MandateVaultSink(address(usdc));
        marketId = keccak256("morpho-style-usdc-vault-market");
        adapter = new MorphoStyleVaultAdapter(address(usdc), address(enforcer), address(vaultSink), marketId);
        vaultSink.setAdapter(address(adapter));

        registry.setRecorder(address(enforcer), true);
        attestor.setRecorder(address(enforcer), true);

        circleWallet = new MorphoAdapterActor();
        bondFunder = new MorphoAdapterActor();
        caller = new MorphoAdapterActor();

        usdc.mint(address(circleWallet), 25 * USDC);
        usdc.mint(address(bondFunder), 20 * USDC);
        circleWallet.approveToken(address(usdc), address(adapter), type(uint256).max);
        bondFunder.approveToken(address(usdc), address(adapter), type(uint256).max);
        bondFunder.postBond(adapter, MIN_BOND);

        mandateId = registry.createMandate(
            address(circleWallet),
            address(usdc),
            address(adapter),
            MandateRegistry.ActionType.DEPOSIT,
            5 * USDC,
            8 * USDC,
            3,
            9_900,
            keccak256("morpho-style-usdc-vault-gate")
        );
    }

    function testAllowedDepositWritesReceiptBeforeMovingUSDC() public {
        MandateRegistry.Action memory action = _action(2 * USDC, address(usdc), 2, 9_950, "morpho-allow");
        uint256 circleBefore = usdc.balanceOf(address(circleWallet));
        uint256 vaultBefore = usdc.balanceOf(address(vaultSink));

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = circleWallet.run(adapter, action);

        require(allowed, "deposit should allow");
        require(reason == RiskPolicy.BlockReason.NONE, "allow reason");
        require(attestor.receiptCount() == 1, "receipt first");
        require(adapter.depositedUSDC() == 2 * USDC, "deposited notional");
        require(adapter.blockedUSDC() == 0, "no blocked notional");
        require(usdc.balanceOf(address(circleWallet)) == circleBefore - (2 * USDC), "Circle wallet debited");
        require(usdc.balanceOf(address(vaultSink)) == vaultBefore + (2 * USDC), "vault credited");
        require(vaultSink.totalDepositedUSDC() == 2 * USDC, "vault recorded total");
        require(vaultSink.depositsByAccountUSDC(address(circleWallet)) == 2 * USDC, "vault recorded account");

        (address vaultAccount, uint256 vaultAmount, bytes32 vaultActionHash,, bool exists) =
            vaultSink.depositsByReceipt(receiptHash);
        require(exists, "vault receipt exists");
        require(vaultAccount == address(circleWallet), "vault account");
        require(vaultAmount == 2 * USDC, "vault amount");
        _assertAllowReceipt(receiptHash, vaultActionHash);
    }

    function testBlockedDepositWritesReceiptAndDoesNotMoveUSDC() public {
        MandateRegistry.Action memory action = _action(2 * USDC, address(fakeUsdc), 2, 9_950, "morpho-block");
        uint256 circleBefore = usdc.balanceOf(address(circleWallet));
        uint256 vaultBefore = usdc.balanceOf(address(vaultSink));

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = circleWallet.run(adapter, action);

        require(!allowed, "deposit should block");
        require(reason == RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, "block reason");
        require(attestor.receiptCount() == 1, "block receipt");
        require(adapter.blockedUSDC() == 2 * USDC, "blocked notional");
        require(usdc.balanceOf(address(circleWallet)) == circleBefore, "Circle wallet must not move");
        require(usdc.balanceOf(address(vaultSink)) == vaultBefore, "vault unchanged");
        require(vaultSink.totalDepositedUSDC() == 0, "blocked action not recorded by vault");

        (,, MandateAttestor.Decision decision, RiskPolicy.BlockReason receiptReason,) =
            attestor.getReceiptDecision(receiptHash);
        require(decision == MandateAttestor.Decision.BLOCK, "receipt block");
        require(receiptReason == RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, "receipt reason");
    }

    function testSwapMandateCannotAuthorizeDepositButStillReceiptsBlock() public {
        uint256 swapMandateId = registry.createMandate(
            address(circleWallet),
            address(usdc),
            address(adapter),
            MandateRegistry.ActionType.SWAP,
            5 * USDC,
            8 * USDC,
            3,
            9_900,
            keccak256("morpho-swap-mismatch")
        );
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), 2, 9_950, "morpho-mismatch");
        action.mandateId = swapMandateId;

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = circleWallet.run(adapter, action);

        require(!allowed, "mismatched mandate should block");
        require(reason == RiskPolicy.BlockReason.NOT_FOLLOWING, "mismatch reason");
        require(attestor.receiptCount() == 1, "mismatch receipt");
        require(adapter.blockedUSDC() == 1 * USDC, "blocked notional");

        (,, MandateAttestor.Decision decision,,) = attestor.getReceiptDecision(receiptHash);
        require(decision == MandateAttestor.Decision.BLOCK, "receipt block");
    }

    function testAdapterCannotRunWithoutBond() public {
        MorphoStyleVaultAdapter unbondedAdapter =
            new MorphoStyleVaultAdapter(address(usdc), address(enforcer), address(vaultSink), marketId);
        uint256 unbondedMandateId = registry.createMandate(
            address(circleWallet),
            address(usdc),
            address(unbondedAdapter),
            MandateRegistry.ActionType.DEPOSIT,
            5 * USDC,
            8 * USDC,
            3,
            9_900,
            keccak256("unbonded-morpho-style-adapter")
        );
        MandateRegistry.Action memory action = MandateRegistry.Action({
            mandateId: unbondedMandateId,
            actor: address(circleWallet),
            circleAccount: address(circleWallet),
            settlementAsset: address(usdc),
            target: address(unbondedAdapter),
            actionType: MandateRegistry.ActionType.DEPOSIT,
            amountUSDC: 1 * USDC,
            riskLevel: 2,
            minBpsOut: 9_950,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("unbonded-morpho-run"),
            executionRef: _marketExecutionRef("unbonded")
        });

        bool reverted = false;
        try circleWallet.run(unbondedAdapter, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "unbonded adapter must not enforce");
    }

    function testWrongAdapterTargetRevertsBeforeReceipt() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), 2, 9_950, "wrong-target");
        action.target = address(0xCAFE);

        bool reverted = false;
        try circleWallet.run(adapter, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "wrong target should revert");
        require(attestor.receiptCount() == 0, "no receipt for wrong adapter surface");
    }

    function testNonDepositActionRevertsBeforeReceipt() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), 2, 9_950, "wrong-action-type");
        action.actionType = MandateRegistry.ActionType.SWAP;

        bool reverted = false;
        try circleWallet.run(adapter, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "morpho adapter only accepts deposit-shaped actions");
        require(attestor.receiptCount() == 0, "no receipt for wrong adapter action type");
    }

    function testMarketExecutionRefBindsMorphoFields() public view {
        bytes32 refA = adapter.morphoMarketExecutionRef(
            address(usdc), address(0xC011A7), address(0x0A0C1E), address(0x0123), 8600, keccak256("deposit-a")
        );
        bytes32 refB = adapter.morphoMarketExecutionRef(
            address(usdc), address(0xC011A7), address(0x0A0C1E), address(0x0123), 8600, keccak256("deposit-b")
        );
        bytes32 refDifferentMarket = adapter.morphoMarketExecutionRef(
            address(usdc), address(0xBEEF), address(0x0A0C1E), address(0x0123), 8600, keccak256("deposit-a")
        );

        require(adapter.surfaceHash() != bytes32(0), "surface hash");
        require(refA != bytes32(0), "execution ref");
        require(refA != refB, "salt bound");
        require(refA != refDifferentMarket, "market fields bound");
    }

    function testCallerCannotForceDepositFromApprovedCircleAccount() public {
        MandateRegistry.Action memory action = _action(2 * USDC, address(usdc), 2, 9_950, "forced-deposit");
        uint256 circleBefore = usdc.balanceOf(address(circleWallet));
        uint256 vaultBefore = usdc.balanceOf(address(vaultSink));

        bool reverted = false;
        try caller.run(adapter, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "non-account caller must not force deposit");
        require(attestor.receiptCount() == 0, "forced attempt should not receipt");
        require(adapter.depositedUSDC() == 0, "no deposited notional");
        require(adapter.blockedUSDC() == 0, "no blocked notional");
        require(usdc.balanceOf(address(circleWallet)) == circleBefore, "circle wallet unchanged");
        require(usdc.balanceOf(address(vaultSink)) == vaultBefore, "vault unchanged");
        require(vaultSink.totalDepositedUSDC() == 0, "vault ledger unchanged");
    }

    function _action(
        uint256 amountUSDC,
        address settlementAsset,
        uint8 riskLevel,
        uint16 minBpsOut,
        string memory label
    ) internal view returns (MandateRegistry.Action memory) {
        return MandateRegistry.Action({
            mandateId: mandateId,
            actor: address(circleWallet),
            circleAccount: address(circleWallet),
            settlementAsset: settlementAsset,
            target: address(adapter),
            actionType: MandateRegistry.ActionType.DEPOSIT,
            amountUSDC: amountUSDC,
            riskLevel: riskLevel,
            minBpsOut: minBpsOut,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256(bytes(label)),
            executionRef: _marketExecutionRef(label)
        });
    }

    function _marketExecutionRef(string memory label) internal view returns (bytes32) {
        return adapter.morphoMarketExecutionRef(
            address(usdc),
            address(0xC011A7),
            address(0x0A0C1E),
            address(0x0123),
            8600,
            keccak256(bytes(label))
        );
    }

    function _assertAllowReceipt(bytes32 receiptHash, bytes32 vaultActionHash) internal view {
        (, uint256 amountUSDC, MandateAttestor.Decision decision, RiskPolicy.BlockReason receiptReason,) =
            attestor.getReceiptDecision(receiptHash);
        (,, bytes32 receiptActionHash,,) = attestor.getReceiptHashes(receiptHash);
        (address actor, address circleAccount, address receiptEnforcer, address settlementAsset, address target) =
            attestor.getReceiptParties(receiptHash);
        require(vaultActionHash == receiptActionHash, "vault action hash");
        require(amountUSDC == 2 * USDC, "receipt amount");
        require(decision == MandateAttestor.Decision.ALLOW, "receipt allow");
        require(receiptReason == RiskPolicy.BlockReason.NONE, "receipt reason");
        require(actor == address(circleWallet), "actor");
        require(circleAccount == address(circleWallet), "circle account");
        require(receiptEnforcer == address(adapter), "adapter is bonded enforcer");
        require(settlementAsset == address(usdc), "USDC receipt");
        require(target == address(adapter), "adapter target");
    }
}
