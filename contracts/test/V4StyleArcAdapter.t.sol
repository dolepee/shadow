// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BondedMandateEnforcer} from "../src/BondedMandateEnforcer.sol";
import {MandateAttestor} from "../src/MandateAttestor.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MandateVaultSink} from "../src/MandateVaultSink.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {RiskPolicy} from "../src/RiskPolicy.sol";
import {V4StyleArcAdapter} from "../src/V4StyleArcAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract AdapterActor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function postBond(V4StyleArcAdapter adapter, uint256 amountUSDC) external {
        adapter.postBond(amountUSDC);
    }

    function run(V4StyleArcAdapter adapter, MandateRegistry.Action calldata action)
        external
        returns (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason)
    {
        return adapter.beforeSwapStyleAction(action);
    }
}

contract V4StyleArcAdapterTest {
    uint256 constant USDC = 1e6;
    uint256 constant MIN_BOND = 10 * USDC;

    MockAsset usdc;
    MockAsset fakeUsdc;
    MandateRegistry registry;
    MandateAttestor attestor;
    BondedMandateEnforcer enforcer;
    MandateVaultSink vaultSink;
    V4StyleArcAdapter adapter;

    AdapterActor circleWallet;
    AdapterActor bondFunder;
    AdapterActor caller;

    uint256 mandateId;

    function setUp() public {
        usdc = new MockAsset("Arc Test USDC", "USDC", 6);
        fakeUsdc = new MockAsset("Not USDC", "nUSDC", 6);
        registry = new MandateRegistry(address(usdc));
        attestor = new MandateAttestor();
        enforcer = new BondedMandateEnforcer(address(usdc), address(registry), address(attestor), MIN_BOND);
        vaultSink = new MandateVaultSink(address(usdc));
        adapter = new V4StyleArcAdapter(address(usdc), address(enforcer), address(vaultSink));
        vaultSink.setAdapter(address(adapter));

        registry.setRecorder(address(enforcer), true);
        attestor.setRecorder(address(enforcer), true);

        circleWallet = new AdapterActor();
        bondFunder = new AdapterActor();
        caller = new AdapterActor();

        usdc.mint(address(circleWallet), 25 * USDC);
        usdc.mint(address(bondFunder), 20 * USDC);
        circleWallet.approveToken(address(usdc), address(adapter), type(uint256).max);
        bondFunder.approveToken(address(usdc), address(adapter), type(uint256).max);
        bondFunder.postBond(adapter, MIN_BOND);

        mandateId = registry.createMandate(
            address(circleWallet),
            address(usdc),
            address(adapter),
            MandateRegistry.ActionType.SWAP,
            5 * USDC,
            8 * USDC,
            3,
            9_500,
            keccak256("arc-v4-style-usdc-swap-gate")
        );
    }

    function testAllowedActionWritesReceiptBeforeMovingUSDC() public {
        MandateRegistry.Action memory action = _action(2 * USDC, address(usdc), 2, 9_800, "adapter-allow");
        uint256 circleBefore = usdc.balanceOf(address(circleWallet));
        uint256 sinkBefore = usdc.balanceOf(address(vaultSink));

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = circleWallet.run(adapter, action);

        require(allowed, "adapter action should allow");
        require(reason == RiskPolicy.BlockReason.NONE, "allow reason");
        require(attestor.receiptCount() == 1, "receipt first");
        require(adapter.executedUSDC() == 2 * USDC, "executed notional");
        require(usdc.balanceOf(address(circleWallet)) == circleBefore - (2 * USDC), "Circle wallet debited");
        require(usdc.balanceOf(address(vaultSink)) == sinkBefore + (2 * USDC), "sink credited");
        require(vaultSink.totalDepositedUSDC() == 2 * USDC, "vault recorded total");
        require(vaultSink.depositsByAccountUSDC(address(circleWallet)) == 2 * USDC, "vault recorded account");
        (address vaultAccount, uint256 vaultAmount, bytes32 vaultActionHash,, bool exists) =
            vaultSink.depositsByReceipt(receiptHash);
        require(exists, "vault receipt exists");
        require(vaultAccount == address(circleWallet), "vault account");
        require(vaultAmount == 2 * USDC, "vault amount");

        _assertAllowReceipt(receiptHash, vaultActionHash);
    }

    function testBlockedActionWritesReceiptAndDoesNotMoveUSDC() public {
        MandateRegistry.Action memory action = _action(2 * USDC, address(fakeUsdc), 2, 9_800, "adapter-block");
        uint256 circleBefore = usdc.balanceOf(address(circleWallet));
        uint256 sinkBefore = usdc.balanceOf(address(vaultSink));

        (bytes32 receiptHash, bool allowed, RiskPolicy.BlockReason reason) = circleWallet.run(adapter, action);

        require(!allowed, "adapter action should block");
        require(reason == RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, "block reason");
        require(attestor.receiptCount() == 1, "block receipt");
        require(adapter.blockedUSDC() == 2 * USDC, "blocked notional");
        require(usdc.balanceOf(address(circleWallet)) == circleBefore, "Circle wallet must not move");
        require(usdc.balanceOf(address(vaultSink)) == sinkBefore, "sink unchanged");
        require(vaultSink.totalDepositedUSDC() == 0, "blocked action not recorded by vault");

        (,, MandateAttestor.Decision decision, RiskPolicy.BlockReason receiptReason,) =
            attestor.getReceiptDecision(receiptHash);
        require(decision == MandateAttestor.Decision.BLOCK, "receipt block");
        require(receiptReason == RiskPolicy.BlockReason.ASSET_NOT_ALLOWED, "receipt reason");
    }

    function testAdapterCannotRunWithoutBond() public {
        V4StyleArcAdapter unbondedAdapter = new V4StyleArcAdapter(address(usdc), address(enforcer), address(vaultSink));
        uint256 unbondedMandateId = registry.createMandate(
            address(circleWallet),
            address(usdc),
            address(unbondedAdapter),
            MandateRegistry.ActionType.SWAP,
            5 * USDC,
            8 * USDC,
            3,
            9_500,
            keccak256("unbonded-adapter")
        );
        MandateRegistry.Action memory action = MandateRegistry.Action({
            mandateId: unbondedMandateId,
            actor: address(circleWallet),
            circleAccount: address(circleWallet),
            settlementAsset: address(usdc),
            target: address(unbondedAdapter),
            actionType: MandateRegistry.ActionType.SWAP,
            amountUSDC: 1 * USDC,
            riskLevel: 2,
            minBpsOut: 9_800,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("unbonded-run"),
            executionRef: bytes32(0)
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
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), 2, 9_800, "wrong-adapter-target");
        action.target = address(0xCAFE);

        bool reverted = false;
        try circleWallet.run(adapter, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "wrong adapter target should revert");
        require(attestor.receiptCount() == 0, "no receipt for wrong adapter surface");
    }

    function testNonSwapActionRevertsBeforeReceipt() public {
        MandateRegistry.Action memory action = _action(1 * USDC, address(usdc), 2, 9_800, "wrong-action-type");
        action.actionType = MandateRegistry.ActionType.DEPOSIT;

        bool reverted = false;
        try circleWallet.run(adapter, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "v4 adapter only accepts swap-shaped actions");
        require(attestor.receiptCount() == 0, "no receipt for wrong adapter action type");
    }

    function testPoolExecutionRefBindsUniswapV4Fields() public view {
        V4StyleArcAdapter.V4PoolKey memory usdcAssetPool = V4StyleArcAdapter.V4PoolKey({
            currency0: address(usdc),
            currency1: address(0xA11CE),
            fee: 3_000,
            tickSpacing: 60,
            hooks: address(adapter)
        });
        V4StyleArcAdapter.V4PoolKey memory lowerFeePool = V4StyleArcAdapter.V4PoolKey({
            currency0: address(usdc),
            currency1: address(0xA11CE),
            fee: 500,
            tickSpacing: 10,
            hooks: address(adapter)
        });

        bytes32 refA = adapter.poolExecutionRef(usdcAssetPool, keccak256("route-a"));
        bytes32 refB = adapter.poolExecutionRef(usdcAssetPool, keccak256("route-b"));
        bytes32 refDifferentPool = adapter.poolExecutionRef(lowerFeePool, keccak256("route-a"));

        require(adapter.surfaceHash() != bytes32(0), "surface hash");
        require(adapter.poolKeyHash(usdcAssetPool) != bytes32(0), "pool key hash");
        require(refA != bytes32(0), "execution ref");
        require(refA != refB, "route salt bound");
        require(refA != refDifferentPool, "pool key bound");
    }

    function testCallerCannotForceActionFromApprovedCircleAccount() public {
        MandateRegistry.Action memory action = _action(2 * USDC, address(usdc), 2, 9_800, "forced-v4-action");
        uint256 circleBefore = usdc.balanceOf(address(circleWallet));
        uint256 sinkBefore = usdc.balanceOf(address(vaultSink));

        bool reverted = false;
        try caller.run(adapter, action) {
            reverted = false;
        } catch {
            reverted = true;
        }

        require(reverted, "non-account caller must not force action");
        require(attestor.receiptCount() == 0, "forced attempt should not receipt");
        require(adapter.executedUSDC() == 0, "no executed notional");
        require(adapter.blockedUSDC() == 0, "no blocked notional");
        require(usdc.balanceOf(address(circleWallet)) == circleBefore, "circle wallet unchanged");
        require(usdc.balanceOf(address(vaultSink)) == sinkBefore, "sink unchanged");
        require(vaultSink.totalDepositedUSDC() == 0, "vault ledger unchanged");
    }

    function testAdapterCanStillSendToPlainAddressSink() public {
        address plainSink = address(0xA11CE);
        V4StyleArcAdapter plainAdapter = new V4StyleArcAdapter(address(usdc), address(enforcer), plainSink);
        usdc.mint(address(bondFunder), MIN_BOND);
        bondFunder.approveToken(address(usdc), address(plainAdapter), type(uint256).max);
        bondFunder.postBond(plainAdapter, MIN_BOND);
        circleWallet.approveToken(address(usdc), address(plainAdapter), type(uint256).max);
        uint256 plainMandateId = registry.createMandate(
            address(circleWallet),
            address(usdc),
            address(plainAdapter),
            MandateRegistry.ActionType.SWAP,
            5 * USDC,
            8 * USDC,
            3,
            9_500,
            keccak256("plain-sink")
        );
        MandateRegistry.Action memory action = MandateRegistry.Action({
            mandateId: plainMandateId,
            actor: address(circleWallet),
            circleAccount: address(circleWallet),
            settlementAsset: address(usdc),
            target: address(plainAdapter),
            actionType: MandateRegistry.ActionType.SWAP,
            amountUSDC: 1 * USDC,
            riskLevel: 2,
            minBpsOut: 9_800,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256("plain-sink-run"),
            executionRef: bytes32(0)
        });
        uint256 sinkBefore = usdc.balanceOf(plainSink);

        (, bool allowed,) = circleWallet.run(plainAdapter, action);

        require(allowed, "plain sink action should allow");
        require(usdc.balanceOf(plainSink) == sinkBefore + 1 * USDC, "plain sink credited");
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
            actionType: MandateRegistry.ActionType.SWAP,
            amountUSDC: amountUSDC,
            riskLevel: riskLevel,
            minBpsOut: minBpsOut,
            expiry: block.timestamp + 1 hours,
            intentHash: keccak256(bytes(label)),
            executionRef: keccak256(abi.encodePacked("v4-style:", label))
        });
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
