// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BondedMandateEnforcer} from "../src/BondedMandateEnforcer.sol";
import {MandateAttestor} from "../src/MandateAttestor.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {RiskPolicy} from "../src/RiskPolicy.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface Vm {
    function warp(uint256) external;
}

contract MandateActor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function bond(BondedMandateEnforcer enforcer, uint256 amountUSDC) external {
        enforcer.bond(amountUSDC);
    }

    function unbond(BondedMandateEnforcer enforcer, uint256 amountUSDC) external {
        enforcer.unbond(amountUSDC);
    }

    function enforce(BondedMandateEnforcer enforcer, MandateRegistry.Action calldata action)
        external
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason)
    {
        return enforcer.enforce(action);
    }

    function commit(BondedMandateEnforcer enforcer, MandateRegistry.Action calldata action, uint64 deadline)
        external
        returns (bytes32 actionHash)
    {
        return enforcer.commitAction(action, deadline);
    }

    function challengeMissing(BondedMandateEnforcer enforcer, bytes32 actionHash, address recipient)
        external
        returns (uint256 slashedUSDC)
    {
        return enforcer.challengeMissingReceipt(actionHash, recipient);
    }
}

contract MandateEnforcerTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant USDC = 1e6;
    uint256 constant MIN_BOND = 10 * USDC;

    MockAsset usdc;
    MockAsset fakeUsdc;
    MandateRegistry registry;
    MandateAttestor attestor;
    BondedMandateEnforcer enforcer;

    MandateActor circleWallet;
    MandateActor bondedOperator;
    MandateActor unbondedOperator;

    address target = address(0xBEEF);
    uint256 mandateId;

    function setUp() public {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        fakeUsdc = new MockAsset("Not USDC", "nUSDC", 6);
        registry = new MandateRegistry(address(usdc));
        attestor = new MandateAttestor();
        enforcer = new BondedMandateEnforcer(address(usdc), address(registry), address(attestor), MIN_BOND);

        registry.setRecorder(address(enforcer), true);
        attestor.setRecorder(address(enforcer), true);

        circleWallet = new MandateActor();
        bondedOperator = new MandateActor();
        unbondedOperator = new MandateActor();

        usdc.mint(address(circleWallet), 25 * USDC);
        usdc.mint(address(bondedOperator), 20 * USDC);
        bondedOperator.approveToken(address(usdc), address(enforcer), type(uint256).max);
        bondedOperator.bond(enforcer, MIN_BOND);

        mandateId = registry.createMandate(
            address(circleWallet),
            address(usdc),
            target,
            MandateRegistry.ActionType.SWAP,
            5 * USDC,
            8 * USDC,
            3,
            9_500,
            keccak256("circle-wallet-usdc-v4-style-swap")
        );
    }

    function testAllowPathRecordsReceiptAndSpend() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), target, 2, 9_800, "allow-1");

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = bondedOperator.enforce(enforcer, action);

        require(allowed, "USDC mandate should allow valid action");
        require(reason == RiskPolicy.BlockReason.NONE, "allow reason should be NONE");
        require(attestor.receiptCount() == 1, "receipt count");

        (, uint256 amountUSDC, MandateAttestor.Decision decision, RiskPolicy.BlockReason receiptReason,) =
            attestor.getReceiptDecision(receiptHash);
        (
            address actor,
            address circleAccount,
            address receiptEnforcer,
            address settlementAsset,
            address receiptTarget
        ) = attestor.getReceiptParties(receiptHash);
        require(decision == MandateAttestor.Decision.ALLOW, "receipt decision");
        require(receiptReason == RiskPolicy.BlockReason.NONE, "receipt reason");
        require(actor == address(circleWallet), "actor should be Circle wallet");
        require(circleAccount == address(circleWallet), "circle account should be recorded");
        require(receiptEnforcer == address(bondedOperator), "bonded enforcer recorded");
        require(settlementAsset == address(usdc), "USDC settlement recorded");
        require(receiptTarget == target, "target recorded");
        require(amountUSDC == 1 * USDC, "amount recorded");

        (uint256 spentToday,) = registry.getMandateSpend(mandateId);
        require(spentToday == 1 * USDC, "allowed action should consume daily cap");
    }

    function testBlockPathForNonUSDCAssetStillRecordsReceipt() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(fakeUsdc), target, 2, 9_800, "block-nonusdc");

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = bondedOperator.enforce(enforcer, action);

        require(!allowed, "non-USDC action must block");
        require(reason == RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, "non-USDC reason");
        require(attestor.receiptCount() == 1, "block receipt count");

        (,, MandateAttestor.Decision decision, RiskPolicy.BlockReason receiptReason,) =
            attestor.getReceiptDecision(receiptHash);
        (, address circleAccount,,,) = attestor.getReceiptParties(receiptHash);
        require(decision == MandateAttestor.Decision.BLOCK, "receipt decision");
        require(receiptReason == RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, "receipt reason");
        require(circleAccount == address(circleWallet), "circle account included on block");

        (uint256 spentToday,) = registry.getMandateSpend(mandateId);
        require(spentToday == 0, "blocked action must not consume daily cap");
    }

    function testBlockPathForAmountTooHigh() public {
        MandateRegistry.Action memory action = _action(6 * USDC, address(usdc), target, 2, 9_800, "block-size");

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = bondedOperator.enforce(enforcer, action);

        require(!allowed, "oversized action must block");
        require(reason == RiskPolicy.BlockReason.AMOUNT_TOO_HIGH, "amount reason");
        (, uint256 amountUSDC, MandateAttestor.Decision decision,,) = attestor.getReceiptDecision(receiptHash);
        require(decision == MandateAttestor.Decision.BLOCK, "block receipt");
        require(amountUSDC == 6 * USDC, "blocked amount recorded");
    }

    function testSlippageFloorBlocksWeakExecutionBound() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), target, 2, 9_000, "block-slippage");

        (, bool allowed, RiskPolicy.BlockReason reason) = bondedOperator.enforce(enforcer, action);

        require(!allowed, "weak minBpsOut must block");
        require(reason == RiskPolicy.BlockReason.SLIPPAGE_TOO_TIGHT, "slippage reason");
    }

    function testDailyCapBlocksAfterAllowedSpend() public {
        MandateRegistry.Action memory first = _action(5 * USDC, address(usdc), target, 2, 9_800, "allow-5");
        MandateRegistry.Action memory second = _action(4 * USDC, address(usdc), target, 2, 9_800, "block-daily");

        (, bool firstAllowed,) = bondedOperator.enforce(enforcer, first);
        (bytes32 secondReceiptHash, bool secondAllowed, RiskPolicy.BlockReason secondReason) =
            bondedOperator.enforce(enforcer, second);

        require(firstAllowed, "first action should allow");
        require(!secondAllowed, "second action should exceed daily cap");
        require(secondReason == RiskPolicy.BlockReason.DAILY_CAP_EXCEEDED, "daily cap reason");
        (,, MandateAttestor.Decision decision,,) = attestor.getReceiptDecision(secondReceiptHash);
        require(decision == MandateAttestor.Decision.BLOCK, "second receipt blocks");
    }

    function testUnbondedEnforcerCannotRecordReceipt() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), target, 2, 9_800, "unbonded");

        bool reverted = false;
        try unbondedOperator.enforce(enforcer, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "unbonded enforcer should revert");
        require(attestor.receiptCount() == 0, "no receipt from unbonded enforcer");
    }

    function testDuplicateActionCannotCreateSecondReceipt() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), target, 2, 9_800, "duplicate");

        bondedOperator.enforce(enforcer, action);

        bool reverted = false;
        try bondedOperator.enforce(enforcer, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "same action hash should not write a second receipt");
        require(attestor.receiptCount() == 1, "only one receipt");
    }

    function testCommittedMissingReceiptCanBeSlashedObjectively() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), target, 2, 9_800, "missing-receipt");
        uint256 bondBefore = enforcer.bondUSDC(address(bondedOperator));
        uint256 challengerBefore = usdc.balanceOf(address(unbondedOperator));

        bytes32 actionHash = bondedOperator.commit(enforcer, action, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 2);
        uint256 slashedUSDC = unbondedOperator.challengeMissing(enforcer, actionHash, address(unbondedOperator));

        require(slashedUSDC == MIN_BOND, "slash amount");
        require(enforcer.bondUSDC(address(bondedOperator)) == bondBefore - MIN_BOND, "bond debited");
        require(usdc.balanceOf(address(unbondedOperator)) == challengerBefore + MIN_BOND, "challenger paid");
    }

    function testCommittedActionClearsAfterReceiptAndCannotBeSlashed() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), target, 2, 9_800, "committed-then-receipt");

        bytes32 actionHash = bondedOperator.commit(enforcer, action, uint64(block.timestamp + 1));
        bondedOperator.enforce(enforcer, action);
        vm.warp(block.timestamp + 2);

        bool reverted = false;
        try unbondedOperator.challengeMissing(enforcer, actionHash, address(unbondedOperator)) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "receipt should clear pending missing-receipt challenge");
    }

    function testCreateMandateRejectsNonUSDCSettlementAsset() public {
        bool reverted = false;
        try registry.createMandate(
            address(circleWallet),
            address(fakeUsdc),
            target,
            MandateRegistry.ActionType.SWAP,
            5 * USDC,
            8 * USDC,
            3,
            9_500,
            keccak256("bad-settlement")
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "mandate settlement asset must be USDC");
    }

    function testWrongTargetBlocksBeforeCapitalMoves() public {
        MandateRegistry.Action memory action =
            _action(1 * USDC, address(usdc), address(0xCAFE), 2, 9_800, "wrong-target");

        (, bool allowed, RiskPolicy.BlockReason reason) = bondedOperator.enforce(enforcer, action);

        require(!allowed, "wrong target should block");
        require(reason == RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, "target reason");
    }

    function _action(
        uint256 amountUSDC,
        address settlementAsset,
        address actionTarget,
        uint8 riskLevel,
        uint16 minBpsOut,
        string memory label
    ) internal view returns (MandateRegistry.Action memory) {
        return MandateRegistry.Action({
            mandateId: mandateId,
            actor: address(circleWallet),
            circleAccount: address(circleWallet),
            settlementAsset: settlementAsset,
            target: actionTarget,
            actionType: MandateRegistry.ActionType.SWAP,
            amountUSDC: amountUSDC,
            riskLevel: riskLevel,
            minBpsOut: minBpsOut,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256(bytes(label)),
            executionRef: keccak256(abi.encodePacked("userop-or-tx:", label))
        });
    }
}
