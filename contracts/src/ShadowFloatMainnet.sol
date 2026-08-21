// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/// @notice Sponsored-only, reserve-backed USDC spending lines.
/// @dev Immutable Mainnet V1 candidate. It deliberately contains no legacy
/// owner credit, shared treasury, scoring, adapter, pooling, token, proxy, or
/// protocol charge surface.
contract ShadowFloatMainnet {
    enum LineState {
        NONE,
        OPEN,
        DRAWN,
        DEFAULTED,
        CLOSED
    }

    enum BlockReason {
        NONE,
        SPENDS_PAUSED,
        SPONSOR_NOT_ALLOWED,
        LINE_EXPIRED,
        PROVIDER_NOT_ALLOWED,
        ENDPOINT_NOT_ALLOWED,
        PROTOCOL_CAP,
        LINE_RESERVE_CAP,
        LINE_SPEND_CAP,
        PER_SPEND_CAP,
        DAILY_SPEND_CAP
    }

    enum CapKind {
        PROTOCOL_RESERVE,
        LINE_RESERVE,
        LINE_SPEND,
        PER_SPEND,
        DAILY_SPEND
    }

    struct Limits {
        uint256 protocolReserve;
        uint256 lineReserve;
        uint256 lineSpend;
        uint256 perSpend;
        uint256 dailySpend;
    }

    struct PendingCap {
        uint256 value;
        uint64 activateAt;
    }

    struct OpenLineParams {
        address agent;
        uint256 reserve;
        uint256 lineSpendCap;
        uint256 dailySpendCap;
        uint64 lineExpiry;
        uint64 maximumRepaymentWindow;
        address provider;
        bytes32 endpointHash;
        uint256 providerPerSpendCap;
        uint256 providerDailyCap;
        uint64 providerExpiry;
    }

    struct Line {
        address sponsor;
        address agent;
        uint64 epoch;
        uint64 expiry;
        uint64 maximumRepaymentWindow;
        uint64 day;
        uint64 termsVersion;
        LineState state;
        uint256 reserveCap;
        uint256 availableReserve;
        uint256 principalOutstanding;
        uint256 recoveryAvailable;
        uint256 lineSpendCap;
        uint256 dailySpendCap;
        uint256 cumulativePrincipalPaid;
        uint256 spentToday;
        uint256 dueAt;
    }

    struct ProviderPolicy {
        bytes32 endpointHash;
        uint64 expiry;
        uint64 day;
        bool active;
        uint256 perSpendCap;
        uint256 dailySpendCap;
        uint256 spentToday;
    }

    struct SpendIntent {
        address agent;
        address sponsor;
        bytes32 lineId;
        uint64 lineEpoch;
        bytes32 termsHash;
        address provider;
        bytes32 endpointHash;
        uint256 principal;
        uint256 maximumTotalDebt;
        uint256 dueAt;
        uint256 nonce;
        uint256 signatureExpiry;
        address executor;
    }

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SPEND_INTENT_TYPEHASH = keccak256(
        "SpendIntent(address agent,address sponsor,bytes32 lineId,uint64 lineEpoch,bytes32 termsHash,address provider,bytes32 endpointHash,uint256 principal,uint256 maximumTotalDebt,uint256 dueAt,uint256 nonce,uint256 signatureExpiry,address executor)"
    );
    bytes32 public constant NAME_HASH = keccak256("ShadowFloatMainnet");
    bytes32 public constant VERSION_HASH = keccak256("1");
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable usdc;
    uint256 public immutable deploymentChainId;
    uint64 public immutable minimumRepaymentWindow;
    uint64 public immutable maximumRepaymentWindow;
    uint64 public immutable governanceDelay;
    uint256 public immutable maximumProtocolReserve;
    uint256 public immutable maximumLineReserve;
    uint256 public immutable maximumLineSpend;
    uint256 public immutable maximumPerSpend;
    uint256 public immutable maximumDailySpend;
    Limits public effectiveLimits;

    address public owner;
    address public pendingOwner;
    bool public openingsPaused;
    bool public spendsPaused;
    uint256 public totalCommittedCapital;
    uint256 public totalSponsorObligations;

    mapping(address => bool) public operators;
    mapping(address => bool) public sponsorAllowed;
    mapping(address => mapping(address => uint64)) public nextLineEpoch;
    mapping(address => mapping(address => bytes32)) public activeLineId;
    mapping(bytes32 => Line) public lines;
    mapping(bytes32 => mapping(address => ProviderPolicy)) public providerPolicies;
    mapping(bytes32 => mapping(uint256 => bool)) public nonceUsed;
    mapping(bytes32 => mapping(uint256 => bool)) public nonceCancelled;
    mapping(bytes32 => uint8) public receiptStatus;
    mapping(uint8 => PendingCap) public pendingCaps;

    uint256 private _locked = 1;

    error Unauthorized();
    error InvalidAddress();
    error InvalidToken();
    error WrongChain();
    error InvalidConfiguration();
    error InvalidState();
    error InvalidAmount();
    error InvalidWindow();
    error InvalidSignature();
    error InvalidIntent();
    error StaleTerms();
    error NonceUnavailable();
    error TransferFailed();
    error NonExactTransfer();
    error TooEarly();
    error CapIncreaseRequired();
    error CapNotReady();
    error Reentrancy();

    event OwnershipProposed(address indexed owner, address indexed pendingOwner);
    event OwnershipAccepted(address indexed previousOwner, address indexed owner);
    event OperatorSet(address indexed operator, bool allowed);
    event SponsorAllowed(address indexed sponsor, bool allowed);
    event OpeningsPauseSet(bool paused, address indexed actor);
    event SpendsPauseSet(bool paused, address indexed actor);
    event CapReduced(CapKind indexed kind, uint256 oldValue, uint256 newValue);
    event CapIncreaseProposed(CapKind indexed kind, uint256 oldValue, uint256 newValue, uint64 activateAt);
    event CapIncreaseCancelled(CapKind indexed kind, uint256 proposedValue, address indexed actor);
    event CapIncreaseActivated(CapKind indexed kind, uint256 oldValue, uint256 newValue);
    event LineOpened(
        bytes32 indexed lineId,
        address indexed sponsor,
        address indexed agent,
        uint64 epoch,
        uint256 reserve,
        uint64 termsVersion
    );
    event LineTermsUpdated(bytes32 indexed lineId, uint64 indexed termsVersion);
    event ProviderPolicySet(
        bytes32 indexed lineId,
        address indexed provider,
        bytes32 endpointHash,
        uint256 perSpendCap,
        uint256 dailySpendCap,
        uint64 expiry,
        bool active,
        uint64 termsVersion
    );
    event SpendBlocked(bytes32 indexed digest, bytes32 indexed lineId, uint256 indexed nonce, BlockReason reason);
    event ProviderPaid(
        bytes32 indexed digest, bytes32 indexed lineId, address indexed provider, uint256 principal, uint256 dueAt
    );
    event NonceCancelled(bytes32 indexed lineId, address indexed agent, uint256 indexed nonce);
    event Repaid(bytes32 indexed lineId, address indexed payer, uint256 amount, uint256 principalRemaining);
    event LineDefaulted(bytes32 indexed lineId, uint256 principalOutstanding, uint256 dueAt);
    event SponsorClaimed(bytes32 indexed lineId, address indexed sponsor, uint256 amount);
    event LineClosed(bytes32 indexed lineId, address indexed sponsor, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address usdc_,
        uint256 expectedChainId_,
        Limits memory maxima_,
        Limits memory initial_,
        uint64 minimumRepaymentWindow_,
        uint64 maximumRepaymentWindow_,
        uint64 governanceDelay_
    ) {
        if (usdc_ == address(0) || usdc_.code.length == 0) revert InvalidToken();
        if (expectedChainId_ != block.chainid) revert WrongChain();
        if (IERC20(usdc_).decimals() != 6) revert InvalidToken();
        _validateLimits(maxima_, maxima_);
        _validateLimits(initial_, maxima_);
        if (
            minimumRepaymentWindow_ == 0 || maximumRepaymentWindow_ < minimumRepaymentWindow_ || governanceDelay_ == 0
                || block.timestamp > type(uint64).max - governanceDelay_
        ) revert InvalidConfiguration();

        usdc = IERC20(usdc_);
        deploymentChainId = expectedChainId_;
        maximumProtocolReserve = maxima_.protocolReserve;
        maximumLineReserve = maxima_.lineReserve;
        maximumLineSpend = maxima_.lineSpend;
        maximumPerSpend = maxima_.perSpend;
        maximumDailySpend = maxima_.dailySpend;
        effectiveLimits = initial_;
        minimumRepaymentWindow = minimumRepaymentWindow_;
        maximumRepaymentWindow = maximumRepaymentWindow_;
        governanceDelay = governanceDelay_;
        owner = msg.sender;
    }

    function proposeOwner(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidAddress();
        pendingOwner = nextOwner;
        emit OwnershipProposed(owner, nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipAccepted(previous, msg.sender);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert InvalidAddress();
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setSponsorAllowed(address sponsor, bool allowed) external onlyOwner {
        if (sponsor == address(0)) revert InvalidAddress();
        sponsorAllowed[sponsor] = allowed;
        emit SponsorAllowed(sponsor, allowed);
    }

    function setOpeningsPaused(bool paused) external {
        if (msg.sender != owner && !(operators[msg.sender] && paused)) revert Unauthorized();
        openingsPaused = paused;
        emit OpeningsPauseSet(paused, msg.sender);
    }

    function setSpendsPaused(bool paused) external {
        if (msg.sender != owner && !(operators[msg.sender] && paused)) revert Unauthorized();
        spendsPaused = paused;
        emit SpendsPauseSet(paused, msg.sender);
    }

    function reduceCap(CapKind kind, uint256 newValue) external onlyOwner {
        uint256 oldValue = _effectiveCap(kind);
        if (newValue == 0 || newValue > oldValue) revert CapIncreaseRequired();
        _setEffectiveCap(kind, newValue);
        delete pendingCaps[uint8(kind)];
        emit CapReduced(kind, oldValue, newValue);
    }

    function proposeCapIncrease(CapKind kind, uint256 newValue) external onlyOwner {
        uint256 oldValue = _effectiveCap(kind);
        if (newValue <= oldValue || newValue > _maximumCap(kind)) revert InvalidConfiguration();
        uint256 activationTimestamp = block.timestamp + governanceDelay;
        if (activationTimestamp > type(uint64).max) revert InvalidConfiguration();
        uint64 activateAt = uint64(activationTimestamp);
        pendingCaps[uint8(kind)] = PendingCap({value: newValue, activateAt: activateAt});
        emit CapIncreaseProposed(kind, oldValue, newValue, activateAt);
    }

    function cancelCapIncrease(CapKind kind) external {
        if (msg.sender != owner && !operators[msg.sender]) revert Unauthorized();
        PendingCap memory pending = pendingCaps[uint8(kind)];
        if (pending.activateAt == 0) revert InvalidState();
        delete pendingCaps[uint8(kind)];
        emit CapIncreaseCancelled(kind, pending.value, msg.sender);
    }

    function activateCapIncrease(CapKind kind) external onlyOwner {
        PendingCap memory pending = pendingCaps[uint8(kind)];
        if (pending.activateAt == 0 || block.timestamp < pending.activateAt) revert CapNotReady();
        uint256 oldValue = _effectiveCap(kind);
        _setEffectiveCap(kind, pending.value);
        delete pendingCaps[uint8(kind)];
        emit CapIncreaseActivated(kind, oldValue, pending.value);
    }

    function openLine(OpenLineParams calldata params) external nonReentrant returns (bytes32 lineId) {
        if (openingsPaused) revert InvalidState();
        if (!sponsorAllowed[msg.sender]) revert Unauthorized();
        _validateOpenParams(params);

        bytes32 previousId = activeLineId[msg.sender][params.agent];
        if (previousId != bytes32(0)) {
            LineState priorState = lines[previousId].state;
            if (priorState != LineState.CLOSED && priorState != LineState.DEFAULTED) revert InvalidState();
        }

        uint64 epoch = nextLineEpoch[msg.sender][params.agent] + 1;
        nextLineEpoch[msg.sender][params.agent] = epoch;
        lineId = keccak256(abi.encode(block.chainid, address(this), msg.sender, params.agent, epoch));
        activeLineId[msg.sender][params.agent] = lineId;

        Line storage line = lines[lineId];
        line.sponsor = msg.sender;
        line.agent = params.agent;
        line.epoch = epoch;
        line.expiry = params.lineExpiry;
        line.maximumRepaymentWindow = params.maximumRepaymentWindow;
        line.termsVersion = 1;
        line.state = LineState.OPEN;
        line.reserveCap = params.reserve;
        line.availableReserve = params.reserve;
        line.lineSpendCap = params.lineSpendCap;
        line.dailySpendCap = params.dailySpendCap;

        ProviderPolicy storage policy = providerPolicies[lineId][params.provider];
        policy.endpointHash = params.endpointHash;
        policy.expiry = params.providerExpiry;
        policy.active = true;
        policy.perSpendCap = params.providerPerSpendCap;
        policy.dailySpendCap = params.providerDailyCap;

        totalCommittedCapital += params.reserve;
        totalSponsorObligations += params.reserve;
        _transferFromExact(msg.sender, params.reserve);

        emit LineOpened(lineId, msg.sender, params.agent, epoch, params.reserve, 1);
        emit ProviderPolicySet(
            lineId,
            params.provider,
            params.endpointHash,
            params.providerPerSpendCap,
            params.providerDailyCap,
            params.providerExpiry,
            true,
            1
        );
    }

    function updateLineTerms(
        bytes32 lineId,
        uint256 lineSpendCap,
        uint256 dailySpendCap,
        uint64 lineExpiry,
        uint64 lineMaximumRepaymentWindow
    ) external {
        Line storage line = _sponsorLine(lineId);
        if (line.state != LineState.OPEN && line.state != LineState.DRAWN) revert InvalidState();
        if (
            lineSpendCap == 0 || lineSpendCap > effectiveLimits.lineSpend || dailySpendCap == 0
                || dailySpendCap > effectiveLimits.dailySpend || lineExpiry <= block.timestamp
                || lineMaximumRepaymentWindow < minimumRepaymentWindow
                || lineMaximumRepaymentWindow > maximumRepaymentWindow
        ) revert InvalidConfiguration();
        line.lineSpendCap = lineSpendCap;
        line.dailySpendCap = dailySpendCap;
        line.expiry = lineExpiry;
        line.maximumRepaymentWindow = lineMaximumRepaymentWindow;
        unchecked {
            ++line.termsVersion;
        }
        emit LineTermsUpdated(lineId, line.termsVersion);
    }

    function setProviderPolicy(
        bytes32 lineId,
        address provider,
        bytes32 endpointHash,
        uint256 perSpendCap,
        uint256 dailySpendCap,
        uint64 expiry,
        bool active
    ) external {
        Line storage line = _sponsorLine(lineId);
        if (line.state != LineState.OPEN && line.state != LineState.DRAWN) revert InvalidState();
        if (provider == address(0) || provider == address(this)) revert InvalidAddress();
        if (
            active
                && (endpointHash == bytes32(0)
                    || perSpendCap == 0
                    || perSpendCap > effectiveLimits.perSpend
                    || dailySpendCap == 0
                    || dailySpendCap > effectiveLimits.dailySpend
                    || expiry <= block.timestamp)
        ) revert InvalidConfiguration();

        ProviderPolicy storage policy = providerPolicies[lineId][provider];
        policy.endpointHash = endpointHash;
        policy.expiry = expiry;
        policy.active = active;
        policy.perSpendCap = perSpendCap;
        policy.dailySpendCap = dailySpendCap;
        unchecked {
            ++line.termsVersion;
        }
        emit ProviderPolicySet(
            lineId, provider, endpointHash, perSpendCap, dailySpendCap, expiry, active, line.termsVersion
        );
    }

    function currentTermsHash(bytes32 lineId, address provider) public view returns (bytes32) {
        Line storage line = lines[lineId];
        ProviderPolicy storage policy = providerPolicies[lineId][provider];
        bytes32 providerPolicyHash = keccak256(
            abi.encode(
                provider, policy.endpointHash, policy.perSpendCap, policy.dailySpendCap, policy.expiry, policy.active
            )
        );
        return keccak256(
            abi.encode(
                lineId,
                line.sponsor,
                line.agent,
                line.reserveCap,
                line.lineSpendCap,
                line.dailySpendCap,
                line.expiry,
                line.maximumRepaymentWindow,
                line.termsVersion,
                providerPolicyHash
            )
        );
    }

    function hashSpendIntent(SpendIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SPEND_INTENT_TYPEHASH,
                intent.agent,
                intent.sponsor,
                intent.lineId,
                intent.lineEpoch,
                intent.termsHash,
                intent.provider,
                intent.endpointHash,
                intent.principal,
                intent.maximumTotalDebt,
                intent.dueAt,
                intent.nonce,
                intent.signatureExpiry,
                intent.executor
            )
        );
        bytes32 domain =
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function executeSpend(SpendIntent calldata intent, bytes calldata signature)
        external
        nonReentrant
        returns (bool paid, BlockReason reason)
    {
        Line storage line = lines[intent.lineId];
        if (
            line.sponsor != intent.sponsor || line.agent != intent.agent || line.epoch != intent.lineEpoch
                || activeLineId[intent.sponsor][intent.agent] != intent.lineId
                || (line.state != LineState.OPEN && line.state != LineState.DRAWN)
        ) revert InvalidIntent();
        if (intent.termsHash != currentTermsHash(intent.lineId, intent.provider)) revert StaleTerms();
        if (
            intent.principal == 0 || intent.principal > intent.maximumTotalDebt
                || block.timestamp > intent.signatureExpiry
                || (intent.executor != address(0) && msg.sender != intent.executor)
                || intent.dueAt < block.timestamp + minimumRepaymentWindow
                || intent.dueAt > block.timestamp + line.maximumRepaymentWindow || intent.dueAt > line.expiry
        ) revert InvalidIntent();
        if (nonceUsed[intent.lineId][intent.nonce] || nonceCancelled[intent.lineId][intent.nonce]) {
            revert NonceUnavailable();
        }
        if (line.state == LineState.DRAWN) revert InvalidState();

        bytes32 digest = hashSpendIntent(intent);
        if (receiptStatus[digest] != 0) revert NonceUnavailable();
        _validateSignature(intent.agent, digest, signature);

        reason = _blockReason(line, providerPolicies[intent.lineId][intent.provider], intent);
        if (reason != BlockReason.NONE) {
            nonceUsed[intent.lineId][intent.nonce] = true;
            receiptStatus[digest] = 1;
            emit SpendBlocked(digest, intent.lineId, intent.nonce, reason);
            return (false, reason);
        }

        uint64 today = uint64(block.timestamp / 1 days);
        if (line.day != today) {
            line.day = today;
            line.spentToday = 0;
        }
        ProviderPolicy storage policy = providerPolicies[intent.lineId][intent.provider];
        if (policy.day != today) {
            policy.day = today;
            policy.spentToday = 0;
        }

        nonceUsed[intent.lineId][intent.nonce] = true;
        receiptStatus[digest] = 2;
        line.availableReserve -= intent.principal;
        line.principalOutstanding = intent.principal;
        line.cumulativePrincipalPaid += intent.principal;
        line.spentToday += intent.principal;
        line.dueAt = intent.dueAt;
        line.state = LineState.DRAWN;
        policy.spentToday += intent.principal;
        totalSponsorObligations -= intent.principal;

        _transferExact(intent.provider, intent.principal);
        emit ProviderPaid(digest, intent.lineId, intent.provider, intent.principal, intent.dueAt);
        return (true, BlockReason.NONE);
    }

    function cancelNonce(bytes32 lineId, uint256 nonce) external {
        Line storage line = lines[lineId];
        if (msg.sender != line.agent) revert Unauthorized();
        if (nonceUsed[lineId][nonce] || nonceCancelled[lineId][nonce]) revert NonceUnavailable();
        nonceCancelled[lineId][nonce] = true;
        emit NonceCancelled(lineId, msg.sender, nonce);
    }

    function repay(bytes32 lineId, uint256 amount) external nonReentrant {
        Line storage line = lines[lineId];
        if (line.state != LineState.DRAWN && line.state != LineState.DEFAULTED) revert InvalidState();
        if (amount == 0 || amount > line.principalOutstanding) revert InvalidAmount();

        _transferFromExact(msg.sender, amount);
        line.principalOutstanding -= amount;
        totalSponsorObligations += amount;
        if (line.state == LineState.DEFAULTED) {
            line.recoveryAvailable += amount;
        } else {
            line.availableReserve += amount;
            if (line.principalOutstanding == 0) {
                line.state = LineState.OPEN;
                line.dueAt = 0;
            }
        }
        emit Repaid(lineId, msg.sender, amount, line.principalOutstanding);
    }

    function declareDefault(bytes32 lineId) external {
        Line storage line = _sponsorLine(lineId);
        if (line.state != LineState.DRAWN) revert InvalidState();
        if (block.timestamp < line.dueAt) revert TooEarly();
        line.state = LineState.DEFAULTED;
        emit LineDefaulted(lineId, line.principalOutstanding, line.dueAt);
    }

    function closeLine(bytes32 lineId) external nonReentrant {
        Line storage line = _sponsorLine(lineId);
        if (line.state != LineState.OPEN || line.principalOutstanding != 0) revert InvalidState();
        uint256 amount = line.availableReserve;
        line.availableReserve = 0;
        line.state = LineState.CLOSED;
        totalCommittedCapital -= amount;
        totalSponsorObligations -= amount;
        _transferExact(line.sponsor, amount);
        emit LineClosed(lineId, line.sponsor, amount);
    }

    function claimDefaulted(bytes32 lineId) external nonReentrant {
        Line storage line = _sponsorLine(lineId);
        if (line.state != LineState.DEFAULTED) revert InvalidState();
        uint256 amount = line.availableReserve + line.recoveryAvailable;
        if (amount == 0) revert InvalidAmount();
        line.availableReserve = 0;
        line.recoveryAvailable = 0;
        totalCommittedCapital -= amount;
        totalSponsorObligations -= amount;
        _transferExact(line.sponsor, amount);
        emit SponsorClaimed(lineId, line.sponsor, amount);
    }

    function isMatured(bytes32 lineId) external view returns (bool) {
        Line storage line = lines[lineId];
        return line.state == LineState.DRAWN && block.timestamp >= line.dueAt;
    }

    function getLine(bytes32 lineId) external view returns (Line memory) {
        return lines[lineId];
    }

    function _blockReason(Line storage line, ProviderPolicy storage policy, SpendIntent calldata intent)
        private
        view
        returns (BlockReason)
    {
        if (spendsPaused) return BlockReason.SPENDS_PAUSED;
        if (!sponsorAllowed[line.sponsor]) return BlockReason.SPONSOR_NOT_ALLOWED;
        if (block.timestamp > line.expiry) return BlockReason.LINE_EXPIRED;
        if (!policy.active || block.timestamp > policy.expiry) return BlockReason.PROVIDER_NOT_ALLOWED;
        if (intent.endpointHash != policy.endpointHash) return BlockReason.ENDPOINT_NOT_ALLOWED;
        if (totalCommittedCapital > effectiveLimits.protocolReserve) return BlockReason.PROTOCOL_CAP;
        if (line.reserveCap > effectiveLimits.lineReserve || intent.principal > line.availableReserve) {
            return BlockReason.LINE_RESERVE_CAP;
        }
        if (
            intent.principal > effectiveLimits.lineSpend
                || line.cumulativePrincipalPaid + intent.principal > line.lineSpendCap
                || line.cumulativePrincipalPaid + intent.principal > effectiveLimits.lineSpend
        ) return BlockReason.LINE_SPEND_CAP;
        if (intent.principal > policy.perSpendCap || intent.principal > effectiveLimits.perSpend) {
            return BlockReason.PER_SPEND_CAP;
        }

        uint64 today = uint64(block.timestamp / 1 days);
        uint256 lineSpent = line.day == today ? line.spentToday : 0;
        uint256 providerSpent = policy.day == today ? policy.spentToday : 0;
        if (
            lineSpent + intent.principal > line.dailySpendCap
                || lineSpent + intent.principal > effectiveLimits.dailySpend
                || providerSpent + intent.principal > policy.dailySpendCap
        ) return BlockReason.DAILY_SPEND_CAP;
        return BlockReason.NONE;
    }

    function _validateSignature(address signer, bytes32 digest, bytes calldata signature) private view {
        if (signer.code.length != 0) {
            (bool ok, bytes memory data) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
            if (!ok || data.length != 32 || abi.decode(data, (bytes4)) != ERC1271_MAGIC) {
                revert InvalidSignature();
            }
            return;
        }
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) == 0 || uint256(s) > SECP256K1_HALF_ORDER) revert InvalidSignature();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();
    }

    function _validateOpenParams(OpenLineParams calldata params) private view {
        if (
            params.agent == address(0) || params.provider == address(0) || params.provider == address(this)
                || params.endpointHash == bytes32(0)
        ) revert InvalidAddress();
        if (
            params.reserve == 0 || params.reserve > effectiveLimits.lineReserve
                || totalCommittedCapital + params.reserve > effectiveLimits.protocolReserve || params.lineSpendCap == 0
                || params.lineSpendCap > effectiveLimits.lineSpend || params.dailySpendCap == 0
                || params.dailySpendCap > effectiveLimits.dailySpend || params.providerPerSpendCap == 0
                || params.providerPerSpendCap > effectiveLimits.perSpend || params.providerDailyCap == 0
                || params.providerDailyCap > effectiveLimits.dailySpend
        ) revert InvalidConfiguration();
        if (
            params.lineExpiry <= block.timestamp || params.providerExpiry <= block.timestamp
                || params.maximumRepaymentWindow < minimumRepaymentWindow
                || params.maximumRepaymentWindow > maximumRepaymentWindow
        ) revert InvalidWindow();
    }

    function _sponsorLine(bytes32 lineId) private view returns (Line storage line) {
        line = lines[lineId];
        if (line.sponsor != msg.sender) revert Unauthorized();
    }

    function _transferFromExact(address from, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TransferFailed();
        }
        if (usdc.balanceOf(address(this)) != beforeBalance + amount) revert NonExactTransfer();
    }

    function _transferExact(address recipient, uint256 amount) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        uint256 beforeContract = usdc.balanceOf(address(this));
        uint256 beforeRecipient = usdc.balanceOf(recipient);
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transfer.selector, recipient, amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TransferFailed();
        }
        if (
            usdc.balanceOf(address(this)) + amount != beforeContract
                || usdc.balanceOf(recipient) != beforeRecipient + amount
        ) revert NonExactTransfer();
    }

    function _validateLimits(Limits memory value, Limits memory maxima) private pure {
        if (
            value.protocolReserve == 0 || value.lineReserve == 0 || value.lineSpend == 0 || value.perSpend == 0
                || value.dailySpend == 0 || value.protocolReserve > maxima.protocolReserve
                || value.lineReserve > maxima.lineReserve || value.lineSpend > maxima.lineSpend
                || value.perSpend > maxima.perSpend || value.dailySpend > maxima.dailySpend
                || value.lineReserve > value.protocolReserve || value.perSpend > value.lineReserve
        ) revert InvalidConfiguration();
    }

    function _effectiveCap(CapKind kind) private view returns (uint256) {
        if (kind == CapKind.PROTOCOL_RESERVE) return effectiveLimits.protocolReserve;
        if (kind == CapKind.LINE_RESERVE) return effectiveLimits.lineReserve;
        if (kind == CapKind.LINE_SPEND) return effectiveLimits.lineSpend;
        if (kind == CapKind.PER_SPEND) return effectiveLimits.perSpend;
        return effectiveLimits.dailySpend;
    }

    function _maximumCap(CapKind kind) private view returns (uint256) {
        if (kind == CapKind.PROTOCOL_RESERVE) return maximumProtocolReserve;
        if (kind == CapKind.LINE_RESERVE) return maximumLineReserve;
        if (kind == CapKind.LINE_SPEND) return maximumLineSpend;
        if (kind == CapKind.PER_SPEND) return maximumPerSpend;
        return maximumDailySpend;
    }

    function _setEffectiveCap(CapKind kind, uint256 value) private {
        if (kind == CapKind.PROTOCOL_RESERVE) effectiveLimits.protocolReserve = value;
        else if (kind == CapKind.LINE_RESERVE) effectiveLimits.lineReserve = value;
        else if (kind == CapKind.LINE_SPEND) effectiveLimits.lineSpend = value;
        else if (kind == CapKind.PER_SPEND) effectiveLimits.perSpend = value;
        else effectiveLimits.dailySpend = value;
    }
}
