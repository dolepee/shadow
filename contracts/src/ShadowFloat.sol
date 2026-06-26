// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}

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
        REPAID,
        DEFAULTED
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
        CREDIT_DENIED,
        FEE_ACCRUED,
        DEFAULTED
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
        MISSING_REQUEST_HASH,
        NO_DEBT,
        REPAY_TOO_HIGH,
        DEFAULTED
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

    struct LineSponsor {
        address sponsor;
        uint256 reserveUSDC;
    }

    struct BehaviorStats {
        uint16 paidBound;
        uint16 signedExternalPaid;
        uint16 repaid;
        uint16 blocked;
        uint16 denied;
        uint16 errorCount;
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
        bool signedIntent;
    }

    struct FloatSpendIntent {
        address agent;
        address provider;
        bytes32 endpointHash;
        uint256 amountUSDC;
        uint256 maxDebtUSDC;
        uint256 nonce;
        uint256 expiry;
        address executor;
        string reason;
    }

    struct ProviderDeliveryReceipt {
        bytes32 requestHash;
        address agent;
        address provider;
        bytes32 endpointHash;
        uint256 amountUSDC;
        bytes32 responseHash;
        uint256 deliveredAt;
    }

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant FLOAT_SPEND_INTENT_TYPEHASH = keccak256(
        "FloatSpendIntent(address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,uint256 maxDebtUSDC,uint256 nonce,uint256 expiry,address executor,string reason)"
    );
    bytes32 public constant PROVIDER_DELIVERY_TYPEHASH = keccak256(
        "ProviderDeliveryReceipt(bytes32 requestHash,address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,bytes32 responseHash,uint256 deliveredAt)"
    );
    bytes32 public constant NAME_HASH = keccak256("ShadowFloat");
    bytes32 public constant VERSION_HASH = keccak256("1");
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 internal constant SECP256K1_N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable usdc;
    address public owner;
    uint256 public nextReceiptId = 1;
    bytes32 public lastChecksum;
    uint256 public totalProviderPaidUSDC;
    uint256 public totalDebtOpenedUSDC;
    uint256 public totalRepaidUSDC;
    uint256 public totalBlockedUSDC;
    uint256 public totalDeniedUSDC;
    uint256 public totalAvailableCreditUSDC;
    uint256 public totalFeesAccruedUSDC;
    uint256 public totalDefaultedUSDC;
    uint256 public totalSponsoredReserveUSDC;
    uint256 public totalSponsoredAvailableCreditUSDC;
    uint16 public feeBps;
    uint8 public constant SPONSORED_BASE_LABEL = 2;
    uint256 private _reentrancyLock = 1;

    mapping(address => bool) public operators;
    mapping(address => AgentLine) public lines;
    mapping(address => uint64) public lineExpiries;
    mapping(address => uint256) public defaultedDebtUSDC;
    mapping(address => ProviderMandate) public providerMandates;
    mapping(address => LineSponsor) public lineSponsors;
    mapping(address => uint8) public lineLabels;
    mapping(address => BehaviorStats) public behaviorStats;
    mapping(address => mapping(address => ProviderMandate)) public lineProviderMandates;
    mapping(address => uint256) public lineSponsorEpoch;
    mapping(address => mapping(address => uint256)) public lineProviderMandateEpoch;
    mapping(bytes32 => bytes32) public receiptByRequestHash;
    mapping(bytes32 => bytes32) public paidSpendCommitments;
    mapping(bytes32 => bytes32) public providerDeliveryByRequestHash;
    mapping(address => mapping(uint256 => bool)) public intentNonceUsed;
    mapping(address => mapping(uint256 => bool)) public intentNonceCancelled;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event OperatorSet(address indexed operator, bool allowed);
    event TreasuryFunded(address indexed funder, uint256 amountUSDC);
    event TreasuryWithdrawn(address indexed recipient, uint256 amountUSDC);
    event FeeBpsSet(uint16 previousFeeBps, uint16 newFeeBps);
    event LineExpirySet(address indexed agent, uint64 expiry);
    event DeterministicFloatScored(
        address indexed agent,
        uint8 label,
        uint16 score,
        uint256 recommendedLimitUSDC,
        uint16 paidBound,
        uint16 signedExternalPaid,
        uint16 repaid,
        uint16 blocked,
        uint16 denied,
        uint16 errorCount
    );
    event ProviderMandateSet(
        address indexed provider,
        bytes32 indexed endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC,
        uint64 expiry,
        bool active
    );
    event SponsoredLineOpened(
        address indexed sponsor,
        address indexed agent,
        address indexed provider,
        uint256 reserveUSDC,
        bytes32 endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC
    );
    event SponsoredLineClosed(address indexed sponsor, address indexed agent, address indexed recipient, uint256 amountUSDC);
    event SponsoredLineDefaulted(
        address indexed sponsor,
        address indexed agent,
        address indexed recipient,
        uint256 defaultedDebtUSDC,
        uint256 returnedReserveUSDC
    );
    event LineProviderMandateSet(
        address indexed agent,
        address indexed sponsor,
        address indexed provider,
        bytes32 endpointHash,
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
    event FloatIntentCancelled(address indexed agent, address indexed signer, uint256 indexed nonce);
    event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash);
    event AutonomousLineReviewed(
        address indexed agent,
        uint8 label,
        uint16 score,
        uint256 previousLimitUSDC,
        uint256 newLimitUSDC,
        bytes32 indexed requestHash
    );
    event ProviderDeliveryConfirmed(
        bytes32 indexed requestHash,
        address indexed agent,
        address indexed provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 responseHash,
        uint256 deliveredAt,
        bytes32 deliveryHash
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
    error MissingRequestHash();
    error DuplicateRequest();
    error InsolventTreasury();
    error FeeTooHigh();
    error AlreadyDefaulted();
    error InvalidSignature();
    error IntentExpired();
    error IntentNonceUsed();
    error IntentCancelled();
    error InvalidIntent();
    error AgentWalletMismatch();
    error SignedIntentRequired();
    error LineAlreadyExists();
    error SponsoredLineExists();
    error NotSponsor();
    error ActiveDebt();
    error FeeExceedsIntent();
    error ExceedsMaxDebt();
    error DeliveryAlreadyConfirmed();
    error DeliveryRequestMissing();
    error DeliveryMismatch();
    error ReentrantCall();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 1) revert ReentrantCall();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
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

    function fund(uint256 amountUSDC) external nonReentrant {
        if (amountUSDC == 0) revert ZeroAmount();
        if (!usdc.transferFrom(msg.sender, address(this), amountUSDC)) revert TransferFailed();
        emit TreasuryFunded(msg.sender, amountUSDC);
    }

    function withdraw(address recipient, uint256 amountUSDC) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountUSDC == 0) revert ZeroAmount();
        uint256 balance = usdc.balanceOf(address(this));
        uint256 ownerAvailableCreditUSDC = totalAvailableCreditUSDC - totalSponsoredAvailableCreditUSDC;
        uint256 reserveFloor = ownerAvailableCreditUSDC + totalSponsoredReserveUSDC;
        if (amountUSDC > balance || balance - amountUSDC < reserveFloor) revert InsolventTreasury();
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

    function openSponsoredLine(
        address agent,
        uint256 reserveUSDC,
        bytes32 mandateId,
        uint64 lineExpiry,
        address provider,
        bytes32 endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC,
        uint64 providerExpiry
    ) external nonReentrant returns (bytes32 receiptHash) {
        if (agent == address(0) || provider == address(0)) revert ZeroAddress();
        if (reserveUSDC == 0 || maxPerRequestUSDC == 0 || dailyLimitUSDC == 0) revert ZeroAmount();
        if (lines[agent].wallet != address(0)) revert LineAlreadyExists();
        if (!usdc.transferFrom(msg.sender, address(this), reserveUSDC)) revert TransferFailed();

        uint256 epoch = lineSponsorEpoch[agent] + 1;
        lineSponsorEpoch[agent] = epoch;
        lineProviderMandates[agent][provider] = ProviderMandate({
            endpointHash: endpointHash,
            maxPerRequestUSDC: maxPerRequestUSDC,
            dailyLimitUSDC: dailyLimitUSDC,
            expiry: providerExpiry,
            active: true
        });
        lineProviderMandateEpoch[agent][provider] = epoch;
        uint8 label = SPONSORED_BASE_LABEL;
        uint16 score = _autonomousScore(agent, label);
        uint256 creditLimitUSDC = _minUint(reserveUSDC, recommendedLimitUSDC(score));
        lineLabels[agent] = label;
        receiptHash = _grantFloat(agent, agent, creditLimitUSDC, score, mandateId, lineExpiry);
        lineSponsors[agent] = LineSponsor({sponsor: msg.sender, reserveUSDC: reserveUSDC});
        totalSponsoredReserveUSDC += reserveUSDC;
        totalSponsoredAvailableCreditUSDC += lines[agent].availableCreditUSDC;

        emit SponsoredLineOpened(
            msg.sender, agent, provider, reserveUSDC, endpointHash, maxPerRequestUSDC, dailyLimitUSDC
        );
        emit LineProviderMandateSet(
            agent, msg.sender, provider, endpointHash, maxPerRequestUSDC, dailyLimitUSDC, providerExpiry, true
        );
        emit DeterministicFloatScored(
            agent,
            label,
            score,
            creditLimitUSDC,
            behaviorStats[agent].paidBound,
            behaviorStats[agent].signedExternalPaid,
            behaviorStats[agent].repaid,
            behaviorStats[agent].blocked,
            behaviorStats[agent].denied,
            behaviorStats[agent].errorCount
        );
    }

    function setSponsoredProviderMandate(
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 maxPerRequestUSDC,
        uint256 dailyLimitUSDC,
        uint64 expiry,
        bool active
    ) external {
        if (provider == address(0)) revert ZeroAddress();
        LineSponsor memory sponsor = lineSponsors[agent];
        if (sponsor.sponsor == address(0) || msg.sender != sponsor.sponsor) revert NotSponsor();
        lineProviderMandates[agent][provider] = ProviderMandate({
            endpointHash: endpointHash,
            maxPerRequestUSDC: maxPerRequestUSDC,
            dailyLimitUSDC: dailyLimitUSDC,
            expiry: expiry,
            active: active
        });
        lineProviderMandateEpoch[agent][provider] = lineSponsorEpoch[agent];
        emit LineProviderMandateSet(
            agent, msg.sender, provider, endpointHash, maxPerRequestUSDC, dailyLimitUSDC, expiry, active
        );
    }

    function closeSponsoredLine(address agent, address recipient, bytes32 requestHash)
        external
        nonReentrant
        returns (bytes32 receiptHash)
    {
        if (recipient == address(0)) revert ZeroAddress();
        LineSponsor memory sponsor = lineSponsors[agent];
        if (sponsor.sponsor == address(0) || msg.sender != sponsor.sponsor) revert NotSponsor();
        AgentLine storage line = lines[agent];
        if (line.activeDebtUSDC != 0) revert ActiveDebt();

        uint256 creditBefore = line.availableCreditUSDC;
        bytes32 mandateId = line.mandateId;
        _setLineAvailableCredit(agent, line, 0);
        line.wallet = address(0);
        line.score = 0;
        line.creditLimitUSDC = 0;
        line.status = AgentStatus.REVOKED;
        line.lastReview = uint64(block.timestamp);
        line.mandateId = bytes32(0);
        lineExpiries[agent] = 0;

        delete lineSponsors[agent];
        delete lineLabels[agent];
        delete behaviorStats[agent];
        totalSponsoredReserveUSDC -= sponsor.reserveUSDC;

        receiptHash = _writeReceipt(
            ReceiptType.LIMIT_REVOKED,
            agent,
            address(0),
            bytes32(0),
            sponsor.reserveUSDC,
            creditBefore,
            0,
            0,
            0,
            BlockReason.REVOKED,
            mandateId,
            requestHash
        );

        if (!usdc.transfer(recipient, sponsor.reserveUSDC)) revert TransferFailed();
        emit SponsoredLineClosed(msg.sender, agent, recipient, sponsor.reserveUSDC);
    }

    function defaultSponsoredLine(address agent, address recipient, bytes32 requestHash)
        external
        nonReentrant
        returns (bytes32 receiptHash)
    {
        if (recipient == address(0)) revert ZeroAddress();
        LineSponsor memory sponsor = lineSponsors[agent];
        if (sponsor.sponsor == address(0) || (msg.sender != sponsor.sponsor && msg.sender != owner)) revert NotSponsor();
        if (msg.sender == owner && recipient != sponsor.sponsor) revert NotSponsor();
        AgentLine storage line = lines[agent];
        if (line.activeDebtUSDC == 0) revert NoDebt();

        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        bytes32 mandateId = line.mandateId;
        uint256 returnedReserveUSDC = sponsor.reserveUSDC > debtBefore ? sponsor.reserveUSDC - debtBefore : 0;

        _setLineAvailableCredit(agent, line, 0);
        line.wallet = address(0);
        line.score = 0;
        line.creditLimitUSDC = 0;
        line.activeDebtUSDC = 0;
        line.status = AgentStatus.DEFAULTED;
        line.lastReview = uint64(block.timestamp);
        line.mandateId = bytes32(0);
        lineExpiries[agent] = 0;

        delete lineSponsors[agent];
        delete lineLabels[agent];
        delete behaviorStats[agent];
        totalSponsoredReserveUSDC -= sponsor.reserveUSDC;
        totalDefaultedUSDC += debtBefore;
        defaultedDebtUSDC[agent] += debtBefore;

        receiptHash = _writeReceipt(
            ReceiptType.DEFAULTED,
            agent,
            address(0),
            bytes32(0),
            debtBefore,
            creditBefore,
            0,
            debtBefore,
            0,
            BlockReason.DEFAULTED,
            mandateId,
            requestHash
        );

        if (returnedReserveUSDC > 0 && !usdc.transfer(recipient, returnedReserveUSDC)) revert TransferFailed();
        emit SponsoredLineDefaulted(sponsor.sponsor, agent, recipient, debtBefore, returnedReserveUSDC);
    }

    function refreshSponsoredLineFromBehavior(address agent, bytes32 requestHash)
        external
        returns (bytes32 receiptHash)
    {
        AgentLine storage line = lines[agent];
        if (lineSponsors[agent].sponsor == address(0)) revert NotSponsor();
        receiptHash = _refreshSponsoredLineFromBehavior(agent, line, requestHash);
    }

    function autonomousLineScore(address agent)
        external
        view
        returns (uint16 score, uint256 recommendedLimitUSDC_, uint256 cappedLimitUSDC)
    {
        score = _autonomousScore(agent, lineLabels[agent]);
        recommendedLimitUSDC_ = recommendedLimitUSDC(score);
        LineSponsor memory sponsor = lineSponsors[agent];
        cappedLimitUSDC = sponsor.reserveUSDC == 0 ? recommendedLimitUSDC_ : _minUint(sponsor.reserveUSDC, recommendedLimitUSDC_);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > 1_000) revert FeeTooHigh();
        uint16 previous = feeBps;
        feeBps = newFeeBps;
        emit FeeBpsSet(previous, newFeeBps);
    }

    function grantFloat(address agent, address wallet, uint256 creditLimitUSDC, uint16 score, bytes32 mandateId)
        external
        onlyOwner
        returns (bytes32 receiptHash)
    {
        receiptHash = _grantFloat(agent, wallet, creditLimitUSDC, score, mandateId, 0);
    }

    function grantFloatWithExpiry(
        address agent,
        address wallet,
        uint256 creditLimitUSDC,
        uint16 score,
        bytes32 mandateId,
        uint64 expiry
    ) external onlyOwner returns (bytes32 receiptHash) {
        receiptHash = _grantFloat(agent, wallet, creditLimitUSDC, score, mandateId, expiry);
    }

    function grantFloatFromScore(
        address agent,
        address wallet,
        uint8 label,
        uint16 paidBound,
        uint16 signedExternalPaid,
        uint16 repaid,
        uint16 blocked,
        uint16 denied,
        uint16 errorCount,
        bytes32 mandateId,
        uint64 expiry
    ) external onlyOwner returns (bytes32 receiptHash) {
        uint16 score =
            deterministicScore(label, paidBound, signedExternalPaid, repaid, blocked, denied, errorCount);
        uint256 recommendedLimit = recommendedLimitUSDC(score);
        emit DeterministicFloatScored(
            agent, label, score, recommendedLimit, paidBound, signedExternalPaid, repaid, blocked, denied, errorCount
        );
        receiptHash = _grantFloat(agent, wallet, recommendedLimit, score, mandateId, expiry);
    }

    function setLineExpiry(address agent, uint64 expiry) external onlyOwner {
        lineExpiries[agent] = expiry;
        emit LineExpirySet(agent, expiry);
    }

    function markDefault(address agent, bytes32 requestHash) external onlyOwner returns (bytes32 receiptHash) {
        AgentLine storage line = lines[agent];
        if (lineSponsors[agent].sponsor != address(0)) revert SponsoredLineExists();
        if (line.status == AgentStatus.DEFAULTED) revert AlreadyDefaulted();
        if (line.activeDebtUSDC == 0) revert NoDebt();
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        _setAvailableCredit(line, 0);
        line.creditLimitUSDC = 0;
        line.status = AgentStatus.DEFAULTED;
        line.lastReview = uint64(block.timestamp);
        totalDefaultedUSDC += debtBefore;
        defaultedDebtUSDC[agent] += debtBefore;
        receiptHash = _writeReceipt(
            ReceiptType.DEFAULTED,
            agent,
            address(0),
            bytes32(0),
            debtBefore,
            creditBefore,
            0,
            debtBefore,
            debtBefore,
            BlockReason.DEFAULTED,
            line.mandateId,
            requestHash
        );
    }

    function deterministicScore(
        uint8 label,
        uint16 paidBound,
        uint16 signedExternalPaid,
        uint16 repaid,
        uint16 blocked,
        uint16 denied,
        uint16 errorCount
    ) public pure returns (uint16) {
        uint256 positive = uint256(_baseScore(label));
        positive += uint256(_min(paidBound, 5)) * 150;
        positive += uint256(_min(signedExternalPaid, 3)) * 350;
        positive += uint256(_min(repaid, 3)) * 400;
        uint256 penalty = uint256(_min(blocked, 5)) * 250;
        penalty += uint256(_min(denied, 3)) * 900;
        penalty += uint256(_min(errorCount, 3)) * 300;
        if (penalty >= positive) return 0;
        uint256 score = positive - penalty;
        if (score > 10_000) return 10_000;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(score);
    }

    function recommendedLimitUSDC(uint16 score) public pure returns (uint256) {
        if (score >= 9_000) return 1_000_000;
        if (score >= 8_000) return 50_000;
        if (score >= 7_500) return 25_000;
        return 0;
    }

    function _grantFloat(
        address agent,
        address wallet,
        uint256 creditLimitUSDC,
        uint16 score,
        bytes32 mandateId,
        uint64 expiry
    ) internal returns (bytes32 receiptHash) {
        if (agent == address(0) || wallet == address(0)) revert ZeroAddress();
        if (wallet != agent) revert AgentWalletMismatch();
        AgentLine storage line = lines[agent];
        if (lineSponsors[agent].sponsor != address(0)) revert SponsoredLineExists();
        if (line.status == AgentStatus.DEFAULTED) revert AlreadyDefaulted();
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.wallet = wallet;
        line.score = score;
        line.creditLimitUSDC = creditLimitUSDC;
        _setAvailableCredit(line, creditLimitUSDC > line.activeDebtUSDC ? creditLimitUSDC - line.activeDebtUSDC : 0);
        _assertTreasurySolvent();
        line.status = AgentStatus.ELIGIBLE;
        line.lastReview = uint64(block.timestamp);
        line.mandateId = mandateId;
        lineExpiries[agent] = expiry;
        _refreshDay(line);
        emit LineExpirySet(agent, expiry);
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
        if (lineSponsors[agent].sponsor != address(0)) revert SponsoredLineExists();
        if (line.status == AgentStatus.DEFAULTED) revert AlreadyDefaulted();
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.wallet = wallet;
        line.score = score;
        line.creditLimitUSDC = 0;
        _setAvailableCredit(line, 0);
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
        if (lineSponsors[agent].sponsor != address(0)) revert SponsoredLineExists();
        if (line.status == AgentStatus.DEFAULTED) revert AlreadyDefaulted();
        if (newLimitUSDC > line.creditLimitUSDC) revert LimitIncreaseNotAllowed();
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.creditLimitUSDC = newLimitUSDC;
        _setAvailableCredit(line, newLimitUSDC > line.activeDebtUSDC ? newLimitUSDC - line.activeDebtUSDC : 0);
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
        if (lineSponsors[agent].sponsor != address(0)) revert SponsoredLineExists();
        if (line.status == AgentStatus.DEFAULTED) revert AlreadyDefaulted();
        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.creditLimitUSDC = 0;
        _setAvailableCredit(line, 0);
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
    ) external nonReentrant returns (bytes32 receiptHash, bool allowed, BlockReason reason) {
        if (requestHash == bytes32(0)) revert MissingRequestHash();
        if (lineSponsors[agent].sponsor != address(0)) revert SignedIntentRequired();
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
            mandateId: line.mandateId,
            signedIntent: false
        });
        (allowed, reason) = _evaluateSpend(line, agent, provider, endpointHash, amountUSDC, requestHash);

        if (!allowed) {
            if (reason == BlockReason.DUPLICATE_REQUEST && requestHash != bytes32(0)) {
                return (receiptByRequestHash[requestHash], false, reason);
            }
            receiptHash = _recordBlockedSpend(ctx, reason);
            return (receiptHash, false, reason);
        }

        receiptHash = _executeAllowedSpend(line, ctx);
        return (receiptHash, true, BlockReason.NONE);
    }

    function requestSignedSpend(FloatSpendIntent calldata intent, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 receiptHash, bool allowed, BlockReason reason)
    {
        (AgentLine storage line, SpendContext memory ctx,) = _consumeSignedIntent(intent, signature);
        _refreshDay(line);
        (allowed, reason) =
            _evaluateSpend(line, intent.agent, intent.provider, intent.endpointHash, intent.amountUSDC, ctx.requestHash);

        if (!allowed) {
            receiptHash = _recordBlockedSpend(ctx, reason);
            return (receiptHash, false, reason);
        }

        receiptHash = _executeAllowedSpend(line, ctx);
        return (receiptHash, true, BlockReason.NONE);
    }

    function recordX402Spend(
        address,
        address,
        bytes32,
        uint256,
        bytes32,
        bytes32,
        address
    ) external pure returns (bytes32, bool, BlockReason) {
        revert SignedIntentRequired();
    }

    function recordSignedX402Spend(
        FloatSpendIntent calldata intent,
        bytes32 x402Hash,
        address facilitator,
        bytes calldata signature
    ) external onlyOperator nonReentrant returns (bytes32 receiptHash, bool allowed, BlockReason reason) {
        if (facilitator == address(0)) revert ZeroAddress();
        if (facilitator != msg.sender) revert NotAuthorized();
        if (lineSponsors[intent.agent].sponsor != address(0)) revert SignedIntentRequired();

        (AgentLine storage line, SpendContext memory ctx,) = _consumeSignedIntent(intent, signature);
        _refreshDay(line);
        (allowed, reason) =
            _evaluateSpend(line, intent.agent, intent.provider, intent.endpointHash, intent.amountUSDC, ctx.requestHash);

        if (!allowed) {
            receiptHash = _recordBlockedSpend(ctx, reason);
            return (receiptHash, false, reason);
        }
        if (x402Hash == bytes32(0)) revert MissingX402Payment();

        receiptHash = _executeAllowedX402Spend(line, ctx, x402Hash, facilitator);
        return (receiptHash, true, BlockReason.NONE);
    }

    function cancelIntent(address agent, uint256 nonce) external {
        AgentLine storage line = lines[agent];
        address signer = _intentSigner(line, agent);
        if (msg.sender != signer) revert NotAuthorized();
        if (intentNonceUsed[agent][nonce]) revert IntentNonceUsed();
        intentNonceCancelled[agent][nonce] = true;
        emit FloatIntentCancelled(agent, signer, nonce);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashFloatSpendIntent(FloatSpendIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                FLOAT_SPEND_INTENT_TYPEHASH,
                intent.agent,
                intent.provider,
                intent.endpointHash,
                intent.amountUSDC,
                intent.maxDebtUSDC,
                intent.nonce,
                intent.expiry,
                intent.executor,
                keccak256(bytes(intent.reason))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function hashProviderDelivery(ProviderDeliveryReceipt calldata delivery) public view returns (bytes32) {
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
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function recordProviderDelivery(ProviderDeliveryReceipt calldata delivery, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 deliveryHash)
    {
        if (delivery.requestHash == bytes32(0) || delivery.responseHash == bytes32(0)) revert InvalidIntent();
        if (delivery.agent == address(0) || delivery.provider == address(0)) revert ZeroAddress();
        if (delivery.amountUSDC == 0 || delivery.deliveredAt == 0) revert ZeroAmount();
        if (delivery.deliveredAt > block.timestamp) revert InvalidIntent();
        if (providerDeliveryByRequestHash[delivery.requestHash] != bytes32(0)) revert DeliveryAlreadyConfirmed();

        bytes32 paidCommitment = paidSpendCommitments[delivery.requestHash];
        if (paidCommitment == bytes32(0)) revert DeliveryRequestMissing();
        bytes32 deliveryCommitment =
            keccak256(abi.encode(delivery.agent, delivery.provider, delivery.endpointHash, delivery.amountUSDC));
        if (deliveryCommitment != paidCommitment) revert DeliveryMismatch();

        deliveryHash = hashProviderDelivery(delivery);
        providerDeliveryByRequestHash[delivery.requestHash] = deliveryHash;
        if (!_isValidIntentSignature(delivery.provider, deliveryHash, signature)) revert InvalidSignature();

        emit ProviderDeliveryConfirmed(
            delivery.requestHash,
            delivery.agent,
            delivery.provider,
            delivery.endpointHash,
            delivery.amountUSDC,
            delivery.responseHash,
            delivery.deliveredAt,
            deliveryHash
        );
    }

    function _consumeSignedIntent(FloatSpendIntent calldata intent, bytes calldata signature)
        internal
        returns (AgentLine storage line, SpendContext memory ctx, bytes32 requestHash)
    {
        if (intent.agent == address(0) || intent.provider == address(0)) revert ZeroAddress();
        if (intent.amountUSDC == 0) revert ZeroAmount();
        if (intent.maxDebtUSDC < intent.amountUSDC + _feeFor(intent.amountUSDC)) revert FeeExceedsIntent();
        if (intent.expiry < block.timestamp) revert IntentExpired();
        if (intent.executor != address(0) && intent.executor != msg.sender) revert NotAuthorized();
        if (intentNonceUsed[intent.agent][intent.nonce]) revert IntentNonceUsed();
        if (intentNonceCancelled[intent.agent][intent.nonce]) revert IntentCancelled();

        line = lines[intent.agent];
        if (line.activeDebtUSDC + intent.amountUSDC + _feeFor(intent.amountUSDC) > intent.maxDebtUSDC) revert ExceedsMaxDebt();
        address signer = _intentSigner(line, intent.agent);
        requestHash = hashFloatSpendIntent(intent);
        if (receiptByRequestHash[requestHash] != bytes32(0)) revert DuplicateRequest();

        intentNonceUsed[intent.agent][intent.nonce] = true;
        if (!_isValidIntentSignature(signer, requestHash, signature)) revert InvalidSignature();
        emit FloatIntentConsumed(intent.agent, signer, intent.nonce, requestHash);

        ctx = SpendContext({
            agent: intent.agent,
            provider: intent.provider,
            endpointHash: intent.endpointHash,
            amountUSDC: intent.amountUSDC,
            requestHash: requestHash,
            creditBeforeUSDC: line.availableCreditUSDC,
            debtBeforeUSDC: line.activeDebtUSDC,
            mandateId: line.mandateId,
            signedIntent: true
        });
    }

    function _intentSigner(AgentLine storage line, address agent) internal view returns (address) {
        if (line.wallet != address(0)) return line.wallet;
        return agent;
    }

    function _isValidIntentSignature(address signer, bytes32 digest, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            try IERC1271(signer).isValidSignature(digest, signature) returns (bytes4 magicValue) {
                return magicValue == ERC1271_MAGIC_VALUE;
            } catch {
                return false;
            }
        }
        return _recover(digest, signature) == signer;
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (uint256(s) > SECP256K1_N_DIV_2) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
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
        if (ctx.requestHash != bytes32(0)) {
            receiptByRequestHash[ctx.requestHash] = receiptHash;
        }
        _recordBlockedBehavior(ctx.agent, lineSponsors[ctx.agent].sponsor != address(0), ctx.requestHash);
    }

    function _executeAllowedSpend(AgentLine storage line, SpendContext memory ctx) internal returns (bytes32 receiptHash) {
        uint256 feeUSDC = _feeFor(ctx.amountUSDC);
        uint256 debitUSDC = ctx.amountUSDC + feeUSDC;
        _setLineAvailableCredit(ctx.agent, line, ctx.creditBeforeUSDC - debitUSDC);
        line.activeDebtUSDC = ctx.debtBeforeUSDC + debitUSDC;
        line.spentTodayUSDC += ctx.amountUSDC;
        _markDebtActive(line);
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
        paidSpendCommitments[ctx.requestHash] = _spendCommitment(ctx);
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

        if (feeUSDC > 0) {
            totalFeesAccruedUSDC += feeUSDC;
            _writeReceipt(
                ReceiptType.FEE_ACCRUED,
                ctx.agent,
                address(0),
                ctx.endpointHash,
                feeUSDC,
                ctx.creditBeforeUSDC,
                line.availableCreditUSDC,
                ctx.debtBeforeUSDC,
                line.activeDebtUSDC,
                BlockReason.NONE,
                ctx.mandateId,
                ctx.requestHash
            );
        }

        totalDebtOpenedUSDC += debitUSDC;
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
        _recordPaidBehavior(ctx.agent, ctx.signedIntent, ctx.requestHash);
    }

    function _executeAllowedX402Spend(
        AgentLine storage line,
        SpendContext memory ctx,
        bytes32 x402Hash,
        address facilitator
    ) internal returns (bytes32 receiptHash) {
        uint256 feeUSDC = _feeFor(ctx.amountUSDC);
        uint256 debitUSDC = ctx.amountUSDC + feeUSDC;
        _setLineAvailableCredit(ctx.agent, line, ctx.creditBeforeUSDC - debitUSDC);
        line.activeDebtUSDC = ctx.debtBeforeUSDC + debitUSDC;
        line.spentTodayUSDC += ctx.amountUSDC;
        _markDebtActive(line);

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
        paidSpendCommitments[ctx.requestHash] = _spendCommitment(ctx);
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

        if (feeUSDC > 0) {
            totalFeesAccruedUSDC += feeUSDC;
            _writeReceipt(
                ReceiptType.FEE_ACCRUED,
                ctx.agent,
                address(0),
                ctx.endpointHash,
                feeUSDC,
                ctx.creditBeforeUSDC,
                line.availableCreditUSDC,
                ctx.debtBeforeUSDC,
                line.activeDebtUSDC,
                BlockReason.NONE,
                ctx.mandateId,
                ctx.requestHash
            );
        }

        totalDebtOpenedUSDC += debitUSDC;
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
        _recordPaidBehavior(ctx.agent, true, ctx.requestHash);
    }

    function _spendCommitment(SpendContext memory ctx) internal pure returns (bytes32) {
        return keccak256(abi.encode(ctx.agent, ctx.provider, ctx.endpointHash, ctx.amountUSDC));
    }

    function repay(address agent, uint256 amountUSDC, bytes32 requestHash) external nonReentrant returns (bytes32 receiptHash) {
        if (amountUSDC == 0) revert ZeroAmount();
        AgentLine storage line = lines[agent];
        if (line.activeDebtUSDC == 0) revert NoDebt();
        if (amountUSDC > line.activeDebtUSDC) revert RepayTooHigh();

        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        bool wasDefaulted = line.status == AgentStatus.DEFAULTED;
        if (!usdc.transferFrom(msg.sender, address(this), amountUSDC)) revert TransferFailed();

        line.activeDebtUSDC = debtBefore - amountUSDC;
        if (wasDefaulted) {
            _setLineAvailableCredit(agent, line, 0);
        } else {
            uint256 refreshed = line.availableCreditUSDC + amountUSDC;
            _setLineAvailableCredit(agent, line, refreshed > line.creditLimitUSDC ? line.creditLimitUSDC : refreshed);
        }
        _assertTreasurySolvent();
        if (wasDefaulted) {
            line.status = line.activeDebtUSDC == 0 ? AgentStatus.REPAID : AgentStatus.DEFAULTED;
        } else {
            line.status = line.activeDebtUSDC == 0 ? AgentStatus.REPAID : AgentStatus.LIMITED;
        }
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
        _recordRepaidBehavior(agent, requestHash);
    }

    function _recordPaidBehavior(address agent, bool signedIntent, bytes32 requestHash) internal {
        if (lineSponsors[agent].sponsor == address(0)) return;
        BehaviorStats storage stats = behaviorStats[agent];
        if (signedIntent) {
            stats.signedExternalPaid = _inc(stats.signedExternalPaid);
        } else {
            stats.paidBound = _inc(stats.paidBound);
        }
        _refreshSponsoredLineFromBehavior(agent, lines[agent], requestHash);
    }

    function _recordBlockedBehavior(address agent, bool sponsored, bytes32 requestHash) internal {
        if (!sponsored) return;
        BehaviorStats storage stats = behaviorStats[agent];
        stats.blocked = _inc(stats.blocked);
        _refreshSponsoredLineFromBehavior(agent, lines[agent], requestHash);
    }

    function _recordRepaidBehavior(address agent, bytes32 requestHash) internal {
        if (lineSponsors[agent].sponsor == address(0)) return;
        BehaviorStats storage stats = behaviorStats[agent];
        stats.repaid = _inc(stats.repaid);
        _refreshSponsoredLineFromBehavior(agent, lines[agent], requestHash);
    }

    function _refreshSponsoredLineFromBehavior(address agent, AgentLine storage line, bytes32 requestHash)
        internal
        returns (bytes32 receiptHash)
    {
        LineSponsor memory sponsor = lineSponsors[agent];
        if (sponsor.sponsor == address(0)) return bytes32(0);
        uint8 label = lineLabels[agent];
        uint16 score = _autonomousScore(agent, label);
        uint256 previousLimit = line.creditLimitUSDC;
        uint256 newLimit = _minUint(sponsor.reserveUSDC, recommendedLimitUSDC(score));

        emit DeterministicFloatScored(
            agent,
            label,
            score,
            newLimit,
            behaviorStats[agent].paidBound,
            behaviorStats[agent].signedExternalPaid,
            behaviorStats[agent].repaid,
            behaviorStats[agent].blocked,
            behaviorStats[agent].denied,
            behaviorStats[agent].errorCount
        );
        emit AutonomousLineReviewed(agent, label, score, previousLimit, newLimit, requestHash);

        line.score = score;
        if (newLimit == previousLimit) {
            line.lastReview = uint64(block.timestamp);
            return bytes32(0);
        }

        uint256 creditBefore = line.availableCreditUSDC;
        uint256 debtBefore = line.activeDebtUSDC;
        line.creditLimitUSDC = newLimit;
        _setLineAvailableCredit(agent, line, newLimit > line.activeDebtUSDC ? newLimit - line.activeDebtUSDC : 0);
        _assertTreasurySolvent();
        line.status = line.activeDebtUSDC > 0 ? AgentStatus.LIMITED : (newLimit == 0 ? AgentStatus.LIMITED : AgentStatus.REPAID);
        line.lastReview = uint64(block.timestamp);

        receiptHash = _writeReceipt(
            newLimit > previousLimit ? ReceiptType.FLOAT_GRANTED : ReceiptType.LIMIT_REDUCED,
            agent,
            address(0),
            bytes32(0),
            newLimit,
            creditBefore,
            line.availableCreditUSDC,
            debtBefore,
            line.activeDebtUSDC,
            BlockReason.NONE,
            line.mandateId,
            requestHash
        );
    }

    function _autonomousScore(address agent, uint8 label) internal view returns (uint16) {
        BehaviorStats memory stats = behaviorStats[agent];
        return deterministicScore(
            label,
            stats.paidBound,
            stats.signedExternalPaid,
            stats.repaid,
            stats.blocked,
            stats.denied,
            stats.errorCount
        );
    }

    function previewSpend(address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, bytes32 requestHash)
        external
        view
        returns (bool allowed, BlockReason reason)
    {
        AgentLine memory line = lines[agent];
        return _evaluateSpendView(line, agent, provider, endpointHash, amountUSDC, requestHash);
    }

    function receiptCount() external view returns (uint256) {
        return nextReceiptId - 1;
    }

    function treasuryBalanceUSDC() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function _evaluateSpend(
        AgentLine storage line,
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash
    ) internal view returns (bool allowed, BlockReason reason) {
        return _evaluateSpendView(line, agent, provider, endpointHash, amountUSDC, requestHash);
    }

    function _evaluateSpendView(
        AgentLine memory line,
        address agent,
        address provider,
        bytes32 endpointHash,
        uint256 amountUSDC,
        bytes32 requestHash
    ) internal view returns (bool allowed, BlockReason reason) {
        if (amountUSDC == 0) return (false, BlockReason.ZERO_AMOUNT);
        if (requestHash == bytes32(0)) return (false, BlockReason.MISSING_REQUEST_HASH);
        if (receiptByRequestHash[requestHash] != bytes32(0)) {
            return (false, BlockReason.DUPLICATE_REQUEST);
        }
        if (line.wallet == address(0) || line.status == AgentStatus.UNKNOWN) return (false, BlockReason.NOT_ELIGIBLE);
        if (line.status == AgentStatus.DENIED) return (false, BlockReason.CREDIT_DENIED);
        if (line.status == AgentStatus.REVOKED) return (false, BlockReason.REVOKED);
        if (line.status == AgentStatus.DEFAULTED) return (false, BlockReason.DEFAULTED);
        uint64 expiry = lineExpiries[agent];
        if (expiry != 0 && block.timestamp > expiry) return (false, BlockReason.EXPIRED);

        ProviderMandate memory mandate = _providerMandateFor(agent, provider);
        if (!mandate.active || provider == address(0)) return (false, BlockReason.PROVIDER_NOT_ALLOWED);
        if (mandate.endpointHash != endpointHash) return (false, BlockReason.ENDPOINT_NOT_ALLOWED);
        if (mandate.expiry != 0 && block.timestamp > mandate.expiry) return (false, BlockReason.EXPIRED);
        uint256 debitUSDC = amountUSDC + _feeFor(amountUSDC);
        if (amountUSDC > mandate.maxPerRequestUSDC || debitUSDC > line.availableCreditUSDC) {
            return (false, BlockReason.AMOUNT_TOO_HIGH);
        }
        uint256 spentToday = line.day == _currentDay() ? line.spentTodayUSDC : 0;
        if (spentToday + amountUSDC > mandate.dailyLimitUSDC) return (false, BlockReason.DAILY_LIMIT_EXCEEDED);
        if (usdc.balanceOf(address(this)) < amountUSDC) return (false, BlockReason.INSUFFICIENT_TREASURY);
        return (true, BlockReason.NONE);
    }

    function _isAuthorized(AgentLine storage line, address agent) internal view returns (bool) {
        return msg.sender == line.wallet || (line.wallet == address(0) && msg.sender == agent);
    }

    function _providerMandateFor(address agent, address provider)
        internal
        view
        returns (ProviderMandate memory mandate)
    {
        if (lineSponsors[agent].sponsor != address(0)) {
            if (lineProviderMandateEpoch[agent][provider] != lineSponsorEpoch[agent]) {
                return mandate;
            }
            return lineProviderMandates[agent][provider];
        }
        return providerMandates[provider];
    }

    function _markDebtActive(AgentLine storage line) internal {
        if (line.activeDebtUSDC > 0 && (line.status == AgentStatus.ELIGIBLE || line.status == AgentStatus.REPAID)) {
            line.status = AgentStatus.LIMITED;
        }
    }

    function _feeFor(uint256 amountUSDC) internal view returns (uint256) {
        if (feeBps == 0) return 0;
        return (amountUSDC * feeBps) / 10_000;
    }

    function _setLineAvailableCredit(address agent, AgentLine storage line, uint256 newAvailableCreditUSDC) internal {
        uint256 previous = line.availableCreditUSDC;
        _setAvailableCredit(line, newAvailableCreditUSDC);
        if (lineSponsors[agent].sponsor == address(0)) return;
        if (newAvailableCreditUSDC > previous) {
            totalSponsoredAvailableCreditUSDC += newAvailableCreditUSDC - previous;
        } else if (previous > newAvailableCreditUSDC) {
            totalSponsoredAvailableCreditUSDC -= previous - newAvailableCreditUSDC;
        }
    }

    function _setAvailableCredit(AgentLine storage line, uint256 newAvailableCreditUSDC) internal {
        uint256 previous = line.availableCreditUSDC;
        if (newAvailableCreditUSDC > previous) {
            totalAvailableCreditUSDC += newAvailableCreditUSDC - previous;
        } else if (previous > newAvailableCreditUSDC) {
            totalAvailableCreditUSDC -= previous - newAvailableCreditUSDC;
        }
        line.availableCreditUSDC = newAvailableCreditUSDC;
    }

    function _assertTreasurySolvent() internal view {
        if (usdc.balanceOf(address(this)) < totalAvailableCreditUSDC) revert InsolventTreasury();
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

    function _baseScore(uint8 label) internal pure returns (uint16) {
        if (label == 3) return 8_500; // lab
        if (label == 2) return 7_500; // invited
        if (label == 1) return 6_500; // self-test
        return 5_000; // demo / unknown
    }

    function _min(uint16 value, uint16 maxValue) internal pure returns (uint16) {
        return value < maxValue ? value : maxValue;
    }

    function _minUint(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        return value < maxValue ? value : maxValue;
    }

    function _inc(uint16 value) internal pure returns (uint16) {
        return value == type(uint16).max ? value : value + 1;
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
