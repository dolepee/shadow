import { parseAbi, parseAbiItem } from "viem";

export const FLOAT_V2_CONTRACT = "0x20dcA96B0C487D94De885c726c956ffaF38b12C2";
export const FLOAT_V2_DEPLOY_BLOCK = 48_837_320n;
export const FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE = 9_000n;

export const FLOAT_V2_STATUS_NAMES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];

export const FLOAT_V2_TRACKED_EXTERNAL_AGENTS = [
  { label: "Forum", agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770" },
  { label: "CitePay", agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" },
  {
    label: "Crux",
    agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092",
    spendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d",
    repayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368",
  },
  {
    label: "CitePay sponsor",
    agent: "0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f",
    spendTx: "0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae",
    repayTx: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe",
  },
  {
    label: "Forum Tollgate sponsor",
    agent: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C",
    spendTx: "0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f",
    repayTx: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172",
  },
  { label: "Argus Alpha", agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC" },
  { label: "Argus Beta", agent: "0x7d4897489bfc663b90baaf5b0803d18ae0ca817c" },
  { label: "Argus Gamma", agent: "0x43e0630025fd0339be1fa04d3d75daf355F50c89" },
  {
    label: "Obol",
    agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3",
    spendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a",
  },
  { label: "Driplet", agent: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf" },
];

export const floatV2Abi = parseAbi([
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
  "function openSponsoredLine(address agent,uint256 reserveUSDC,bytes32 mandateId,uint64 lineExpiry,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 providerExpiry) returns (bytes32)",
  "function setSponsoredProviderMandate(address agent,address provider,bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function requestSignedSpend((address agent,address provider,bytes32 endpointHash,uint256 amountUSDC,uint256 maxDebtUSDC,uint256 nonce,uint256 expiry,address executor,string reason) intent, bytes signature) returns (bytes32 receiptHash, bool allowed, uint8 reason)",
  "function repay(address agent, uint256 amountUSDC, bytes32 requestHash) returns (bytes32)",
  "function behaviorStats(address agent) view returns (uint16 paidBound,uint16 signedExternalPaid,uint16 repaid,uint16 blocked,uint16 denied,uint16 errorCount)",
  "function autonomousLineScore(address agent) view returns (uint16 score,uint256 recommendedLimitUSDC,uint256 cappedLimitUSDC)",
  "function lineProviderMandates(address agent,address provider) view returns (bytes32 endpointHash,uint256 maxPerRequestUSDC,uint256 dailyLimitUSDC,uint64 expiry,bool active)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function totalSponsoredReserveUSDC() view returns (uint256)",
]);

export const floatV2IntentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);

export const floatV2ReceiptEvent = parseAbiItem(
  "event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)",
);
