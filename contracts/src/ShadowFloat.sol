// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/// @notice Behavior-backed USDC spending lines for autonomous agents.
/// @dev Intentionally compact for Lepton: registry, treasury, and receipts in
/// one contract so the proof path is small and auditable.
contract ShadowFloat {
    enum AgentStatus {
        UNKNOWN,
        ELIGIBLE,
        LIMITED,
        DENIED,
        REVOKED,
        REPAID
    }

    enum ReceiptType {
        UNKNOWN,
        FLOAT_GRANTED,
        SPEND_ALLOWED,
        SPEND_BLOCKED,
        PROVIDER_PAID,
        DEBT_OPENED,
        REPAID,
        LIMIT_REDUCED,
        LIMIT_REVOKED,
        CREDIT_DENIED
    }

    enum BlockReason {
        NONE,
        NOT_AUTHORIZED,
        NOT_ELIGIBLE,
        CREDIT_DENIED,
        REVOKED,
        PROVIDER_NOT_ALLOWED,
        ENDPOINT_NOT_ALLOWED,
        AMOUNT_TOO_HIGH,
        DAILY_LIMIT_EXCEEDED,
        EXPIRED,
        INSUFFICIENT_TREASURY,
        DUPLICATE_REQUEST,
        ZERO_AMOUNT,
        NO_DEBT,
        REPAY_TOO_HIGH
    }

    struct AgentLine {
        address wallet;
        uint16 score;
        uint256 creditLimitUSDC;
        uint256 availableCreditUSDC;
        uint256 activeDebtUSDC;
        AgentStatus status;
        uint64 lastReview;
        bytes32 mandateId;
        uint64 day;
        uint256 spentTodayUSDC;
    }

    struct ProviderMandate {
        bytes32 endpointHash;
        uint256 maxPerRequestUSDC;
        uint256 dailyLimitUSDC;
        uint64 expiry;
        bool active;
    }

    struct SpendContext {
        address agent;
        address provider;
        bytes32 endpointHash;
        uint256 amountUSDC;
        bytes32 requestHash;
        uint256 creditBeforeUSDC;
        uint256 debtBeforeUSDC;
        bytes32 mandateId;
    }

    IERC20 public immutable usdc;
    address public owner;
    uint256 public nextReceiptId = 1;
    bytes32 public lastChecksum;
    uint256 public totalProviderPaidUSDC;
    uint256 public totalDebtOpenedUSDC;
    uint256 public totalRepaidUSDC;
    uint256 public totalBlockedUSDC;
    uint256 public totalDeniedUSDC;

    mapping(address => bool) public operators;
    mapping(address => AgentLine) public lines;
    mapping(address => ProviderMandate) public providerMandates;
    mapping(bytes32 => bytes32) public receiptByRequestHash;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OperatorSet(address indexed operator, bool allowed);
    event TreasuryFunded(address indexed funder, uint256 amountUSDC);
    event TreasuryWithdrawn(address indexed recipient, uint256 amountUSDC);
    event ProviderMandateSet(
        address indexed provider,
        bytes32 indexed endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC,
        uint64 expiry,
        bool active
    );
    event FloatReceipt(
        uint256 indexed receiptId,
        bytes32 indexed receiptHash,
        ReceiptType indexed receiptType,
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        uint256 creditBeforeUSDC,
        uint256 creditAfterUSDC,
        uint256 debtBeforeUSDC,
        uint256 debtAfterUSDC,
        BlockReason reason,
        bytes32 mandateId,
        bytes32 requestHash,
        bytes32 prevChecksum,
        bytes32 checksum
    );
    event X402PaymentBound(
        uint256 indexed receiptId,
        bytes32 indexed requestHash,
        bytes32 x402Hash,
        address indexed provider,
        uint256 amountUSDC,
        address facilitator
    );

    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error ZeroAmount();
    error LimitIncreaseNotAllowed();
    error TransferFailed();
    error NoDebt();
    error RepayTooHigh();
    error MissingX402Payment();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        owner = msg.sender;
        operators[msg.sender] = true;
        emit OwnerChanged(address(0), msg.sender);
        emit OperatorSet(msg.sender, true);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnerChanged(previous, newOwner);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function fund(uint256 amountUSDC) external {
        if (amountUSDC == 0) revert ZeroAmount();
        if (!usdc.transferFrom(msg.sender, address(this), amountUSDC)) revert TransferFailed();
        emit TreasuryFunded(msg.sender, amountUSDC);
    }

    function withdraw(address recipient, uint256 amountUSDC) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountUSDC == 0) revert ZeroAmount();
        if (!usdc.transfer(recipient, amountUSDC)) revert TransferFailed();
        emit TreasuryWithdrawn(recipient, amountUSDC);
    }

    function setProviderMandate(
        address provider,
        bytes32 endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC,
        uint64 expiry,
        bool active
    ) external onlyOwner {
        if (provider == address(0)) revert ZeroAddress();
        providerMandates[provider] = ProviderMandate({
            endpointHash: endpointHash,
            maxPerRequestUSDC: maxPerRequestUSDC,
            dailyLimitUSDC: dailyLimitUSDC,
            expiry: expiry,
            active: active
        });
        emit ProviderMandateSet(provider, endpointHash, maxPerRequestUSDC, dailyLimitUSDC, expiry, active);
    }

    function grantFloat(address agent, address wallet, uint256 creditLimitUSDC, uint16 score, bytes32 mandateId)
        external
        onlyOwner
        returns (bytes32 receiptHash)
    {
        if (agent == address(0) || wallet == address(0)) revert ZeroAddress();
        AgentLine storage line = lines[agent];
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.wallet = wallet;
        line.score = score;
        line.creditLimitUSDC = creditLimitUSDC;
        line.availableCreditUSDC = creditLimitUSDC > line.activeDebtUSDC ? creditLimitUSDC - line.activeDebtUSDC : 0;
        line.status = AgentStatus.ELIGIBLE;
        line.lastReview = uint64(block.timestamp);
        line.mandateId = mandateId;
        _refreshDay(line);
        receiptHash = _writeReceipt(
            ReceiptType.FLOAT_GRANTED,
            agent,
            address(0),
            bytes32(0),
            creditLimitUSDC,
            creditBefore,
            line.availableCreditUSDC,
            debtBefore,
            line.activeDebtUSDC,
            BlockReason.NONE,
            line.mandateId,
            bytes32(0)
        );
    }

    function denyAgent(address agent, address wallet, uint16 score, bytes32 mandateId, bytes32 requestHash)
        external
        onlyOwner
        returns (bytes32 receiptHash)
    {
        if (agent == address(0) || wallet == address(0)) revert ZeroAddress();
        AgentLine storage line = lines[agent];
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.wallet = wallet;
        line.score = score;
        line.creditLimitUSDC = 0;
        line.availableCreditUSDC = 0;
        line.status = AgentStatus.DENIED;
        line.lastReview = uint64(block.timestamp);
        line.mandateId = mandateId;
        receiptHash = _writeReceipt(
            ReceiptType.CREDIT_DENIED,
            agent,
            address(0),
            bytes32(0),
            0,
            creditBefore,
            0,
            debtBefore,
            debtBefore,
            BlockReason.CREDIT_DENIED,
            line.mandateId,
            requestHash
        );
    }

    function reduceLimit(address agent, uint256 newLimitUSDC, bytes32 requestHash) external onlyOwner returns (bytes32) {
        AgentLine storage line = lines[agent];
        if (newLimitUSDC > line.creditLimitUSDC) revert LimitIncreaseNotAllowed();
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.creditLimitUSDC = newLimitUSDC;
        line.availableCreditUSDC = newLimitUSDC > line.activeDebtUSDC ? newLimitUSDC - line.activeDebtUSDC : 0;
        line.status = AgentStatus.LIMITED;
        line.lastReview = uint64(block.timestamp);
        return _writeReceipt(
            ReceiptType.LIMIT_REDUCED,
            agent,
            address(0),
            bytes32(0),
            newLimitUSDC,
            creditBefore,
            line.availableCreditUSDC,
            debtBefore,
            line.activeDebtUSDC,
            BlockReason.NONE,
            line.mandateId,
            requestHash
        );
    }

    function revoke(address agent, bytes32 requestHash) external onlyOwner returns (bytes32) {
        AgentLine storage line = lines[agent];
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.creditLimitUSDC = 0;
        line.availableCreditUSDC = 0;
        line.status = AgentStatus.REVOKED;
        line.lastReview = uint64(block.timestamp);
        return _writeReceipt(
            ReceiptType.LIMIT_REVOKED,
            agent,
            address(0),
            bytes32(0),
            0,
            creditBefore,
            0,
            debtBefore,
            debtBefore,
            BlockReason.REVOKED,
            line.mandateId,
            requestHash
        );
    }

    function requestSpend(
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash
    ) external returns (bytes32 receiptHash, bool allowed, BlockReason reason) {
        AgentLine storage line = lines[agent];
        if (!_isAuthorized(line, agent)) revert NotAuthorized();
        _refreshDay(line);

        SpendContext memory ctx = SpendContext({
            agent: agent,
            provider: provider,
            endpointHash: endpointHash,
            amountUSDC: amountUSDC,
            requestHash: requestHash,
            creditBeforeUSDC: line.availableCreditUSDC,
            debtBeforeUSDC: line.activeDebtUSDC,
            mandateId: line.mandateId
        });
        (allowed, reason) = _evaluateSpend(line, provider, endpointHash, amountUSDC, requestHash);

        if (!allowed) {
            receiptHash = _recordBlockedSpend(ctx, reason);
            return (receiptHash, false, reason);
        }

        receiptHash = _executeAllowedSpend(line, ctx);
        return (receiptHash, true, BlockReason.NONE);
    }

    function recordX402Spend(
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash,
        bytes32 x402Hash,
        address facilitator
    ) external onlyOperator returns (bytes32 receiptHash, bool allowed, BlockReason reason) {
        AgentLine storage line = lines[agent];
        _refreshDay(line);

        SpendContext memory ctx = SpendContext({
            agent: agent,
            provider: provider,
            endpointHash: endpointHash,
            amountUSDC: amountUSDC,
            requestHash: requestHash,
            creditBeforeUSDC: line.availableCreditUSDC,
            debtBeforeUSDC: line.activeDebtUSDC,
            mandateId: line.mandateId
        });
        (allowed, reason) = _evaluateSpend(line, provider, endpointHash, amountUSDC, requestHash);

        if (!allowed) {
            receiptHash = _recordBlockedSpend(ctx, reason);
            return (receiptHash, false, reason);
        }
        if (x402Hash == bytes32(0)) revert MissingX402Payment();
        if (facilitator == address(0)) revert ZeroAddress();

        receiptHash = _executeAllowedX402Spend(line, ctx, x402Hash, facilitator);
        return (receiptHash, true, BlockReason.NONE);
    }

    function _recordBlockedSpend(SpendContext memory ctx, BlockReason reason) internal returns (bytes32 receiptHash) {
        if (ctx.amountUSDC > 0) {
            if (reason == BlockReason.CREDIT_DENIED || reason == BlockReason.REVOKED || reason == BlockReason.NOT_ELIGIBLE) {
                totalDeniedUSDC += ctx.amountUSDC;
            } else {
                totalBlockedUSDC += ctx.amountUSDC;
            }
        }
        receiptHash = _writeReceipt(
            reason == BlockReason.CREDIT_DENIED ? ReceiptType.CREDIT_DENIED : ReceiptType.SPEND_BLOCKED,
            ctx.agent,
            ctx.provider,
            ctx.endpointHash,
            ctx.amountUSDC,
            ctx.creditBeforeUSDC,
            ctx.creditBeforeUSDC,
            ctx.debtBeforeUSDC,
            ctx.debtBeforeUSDC,
            reason,
            ctx.mandateId,
            ctx.requestHash
        );
    }

    function _executeAllowedSpend(AgentLine storage line, SpendContext memory ctx) internal returns (bytes32 receiptHash) {
        line.availableCreditUSDC = ctx.creditBeforeUSDC - ctx.amountUSDC;
        line.activeDebtUSDC = ctx.debtBeforeUSDC + ctx.amountUSDC;
        line.spentTodayUSDC += ctx.amountUSDC;
        receiptByRequestHash[ctx.requestHash] = _writeReceipt(
            ReceiptType.SPEND_ALLOWED,
            ctx.agent,
            ctx.provider,
            ctx.endpointHash,
            ctx.amountUSDC,
            ctx.creditBeforeUSDC,
            line.availableCreditUSDC,
            ctx.debtBeforeUSDC,
            line.activeDebtUSDC,
            BlockReason.NONE,
            ctx.mandateId,
            ctx.requestHash
        );

        if (!usdc.transfer(ctx.provider, ctx.amountUSDC)) revert TransferFailed();
        totalProviderPaidUSDC += ctx.amountUSDC;
        _writeReceipt(
            ReceiptType.PROVIDER_PAID,
            ctx.agent,
            ctx.provider,
            ctx.endpointHash,
            ctx.amountUSDC,
            ctx.creditBeforeUSDC,
            line.availableCreditUSDC,
            ctx.debtBeforeUSDC,
            line.activeDebtUSDC,
            BlockReason.NONE,
            ctx.mandateId,
            ctx.requestHash
        );

        totalDebtOpenedUSDC += ctx.amountUSDC;
        receiptHash = _writeReceipt(
            ReceiptType.DEBT_OPENED,
            ctx.agent,
            ctx.provider,
            ctx.endpointHash,
            ctx.amountUSDC,
            ctx.creditBeforeUSDC,
            line.availableCreditUSDC,
            ctx.debtBeforeUSDC,
            line.activeDebtUSDC,
            BlockReason.NONE,
            ctx.mandateId,
            ctx.requestHash
        );
    }

    function _executeAllowedX402Spend(
        AgentLine storage line,
        SpendContext memory ctx,
        bytes32 x402Hash,
        address facilitator
    ) internal returns (bytes32 receiptHash) {
        line.availableCreditUSDC = ctx.creditBeforeUSDC - ctx.amountUSDC;
        line.activeDebtUSDC = ctx.debtBeforeUSDC + ctx.amountUSDC;
        line.spentTodayUSDC += ctx.amountUSDC;

        uint256 allowedReceiptId = nextReceiptId;
        bytes32 allowedReceiptHash = _writeReceipt(
            ReceiptType.SPEND_ALLOWED,
            ctx.agent,
            ctx.provider,
            ctx.endpointHash,
            ctx.amountUSDC,
            ctx.creditBeforeUSDC,
            line.availableCreditUSDC,
            ctx.debtBeforeUSDC,
            line.activeDebtUSDC,
            BlockReason.NONE,
            ctx.mandateId,
            ctx.requestHash
        );
        receiptByRequestHash[ctx.requestHash] = allowedReceiptHash;

        if (!usdc.transfer(facilitator, ctx.amountUSDC)) revert TransferFailed();
        totalProviderPaidUSDC += ctx.amountUSDC;
        emit X402PaymentBound(allowedReceiptId, ctx.requestHash, x402Hash, ctx.provider, ctx.amountUSDC, facilitator);
        _writeReceipt(
            ReceiptType.PROVIDER_PAID,
            ctx.agent,
            ctx.provider,
            ctx.endpointHash,
            ctx.amountUSDC,
            ctx.creditBeforeUSDC,
            line.availableCreditUSDC,
            ctx.debtBeforeUSDC,
            line.activeDebtUSDC,
            BlockReason.NONE,
            ctx.mandateId,
            ctx.requestHash
        );

        totalDebtOpenedUSDC += ctx.amountUSDC;
        receiptHash = _writeReceipt(
            ReceiptType.DEBT_OPENED,
            ctx.agent,
            ctx.provider,
            ctx.endpointHash,
            ctx.amountUSDC,
            ctx.creditBeforeUSDC,
            line.availableCreditUSDC,
            ctx.debtBeforeUSDC,
            line.activeDebtUSDC,
            BlockReason.NONE,
            ctx.mandateId,
            ctx.requestHash
        );
    }

    function repay(address agent, uint256 amountUSDC, bytes32 requestHash) external returns (bytes32 receiptHash) {
        if (amountUSDC == 0) revert ZeroAmount();
        AgentLine storage line = lines[agent];
        if (line.activeDebtUSDC == 0) revert NoDebt();
        if (amountUSDC > line.activeDebtUSDC) revert RepayTooHigh();

        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        if (!usdc.transferFrom(msg.sender, address(this), amountUSDC)) revert TransferFailed();

        line.activeDebtUSDC = debtBefore - amountUSDC;
        uint256 refreshed = line.availableCreditUSDC + amountUSDC;
        line.availableCreditUSDC = refreshed > line.creditLimitUSDC ? line.creditLimitUSDC : refreshed;
        line.status = line.activeDebtUSDC == 0 ? AgentStatus.REPAID : AgentStatus.LIMITED;
        line.lastReview = uint64(block.timestamp);
        totalRepaidUSDC += amountUSDC;

        receiptHash = _writeReceipt(
            ReceiptType.REPAID,
            agent,
            address(0),
            bytes32(0),
            amountUSDC,
            creditBefore,
            line.availableCreditUSDC,
            debtBefore,
            line.activeDebtUSDC,
            BlockReason.NONE,
            line.mandateId,
            requestHash
        );
    }

    function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash)
        external
        view
        returns (bool allowed, BlockReason reason)
    {
        AgentLine memory line = lines[agent];
        return _evaluateSpendView(line, provider, endpointHash, amountUSDC, requestHash);
    }

    function receiptCount() external view returns (uint256) {
        return nextReceiptId - 1;
    }

    function treasuryBalanceUSDC() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function _evaluateSpend(
        AgentLine storage line,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash
    ) internal view returns (bool allowed, BlockReason reason) {
        return _evaluateSpendView(line, provider, endpointHash, amountUSDC, requestHash);
    }

    function _evaluateSpendView(
        AgentLine memory line,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash
    ) internal view returns (bool allowed, BlockReason reason) {
        if (amountUSDC == 0) return (false, BlockReason.ZERO_AMOUNT);
        if (requestHash != bytes32(0) && receiptByRequestHash[requestHash] != bytes32(0)) {
            return (false, BlockReason.DUPLICATE_REQUEST);
        }
        if (line.wallet == address(0) || line.status == AgentStatus.UNKNOWN) return (false, BlockReason.NOT_ELIGIBLE);
        if (line.status == AgentStatus.DENIED) return (false, BlockReason.CREDIT_DENIED);
        if (line.status == AgentStatus.REVOKED) return (false, BlockReason.REVOKED);

        ProviderMandate memory mandate = providerMandates[provider];
        if (!mandate.active || provider == address(0)) return (false, BlockReason.PROVIDER_NOT_ALLOWED);
        if (mandate.endpointHash != endpointHash) return (false, BlockReason.ENDPOINT_NOT_ALLOWED);
        if (mandate.expiry != 0 && block.timestamp > mandate.expiry) return (false, BlockReason.EXPIRED);
        if (amountUSDC > mandate.maxPerRequestUSDC || amountUSDC > line.availableCreditUSDC) {
            return (false, BlockReason.AMOUNT_TOO_HIGH);
        }
        uint256 spentToday = line.day == _currentDay() ? line.spentTodayUSDC : 0;
        if (spentToday + amountUSDC > mandate.dailyLimitUSDC) return (false, BlockReason.DAILY_LIMIT_EXCEEDED);
        if (usdc.balanceOf(address(this)) < amountUSDC) return (false, BlockReason.INSUFFICIENT_TREASURY);
        return (true, BlockReason.NONE);
    }

    function _isAuthorized(AgentLine storage line, address agent) internal view returns (bool) {
        return operators[msg.sender] || msg.sender == line.wallet || (line.wallet == address(0) && msg.sender == agent);
    }

    function _refreshDay(AgentLine storage line) internal {
        uint64 day = _currentDay();
        if (line.day != day) {
            line.day = day;
            line.spentTodayUSDC = 0;
        }
    }

    function _currentDay() internal view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _writeReceipt(
        ReceiptType receiptType,
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        uint256 creditBeforeUSDC,
        uint256 creditAfterUSDC,
        uint256 debtBeforeUSDC,
        uint256 debtAfterUSDC,
        BlockReason reason,
        bytes32 mandateId,
        bytes32 requestHash
    ) internal returns (bytes32 receiptHash) {
        uint256 receiptId = nextReceiptId++;
        bytes32 prev = lastChecksum;
        bytes32 checksum = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                receiptId,
                receiptType,
                agent,
                provider,
                endpointHash,
                amountUSDC,
                creditBeforeUSDC,
                creditAfterUSDC,
                debtBeforeUSDC,
                debtAfterUSDC,
                reason,
                mandateId,
                requestHash,
                prev,
                block.timestamp
            )
        );
        receiptHash = checksum;
        lastChecksum = checksum;
        emit FloatReceipt(
            receiptId,
            receiptHash,
            receiptType,
            agent,
            provider,
            endpointHash,
            amountUSDC,
            creditBeforeUSDC,
            creditAfterUSDC,
            debtBeforeUSDC,
            debtAfterUSDC,
            reason,
            mandateId,
            requestHash,
            prev,
            checksum
        );
    }
}
