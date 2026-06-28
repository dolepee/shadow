import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";

const env = {
  ...readEnv(new URL("../../.env", import.meta.url)),
  ...readEnv(new URL("../../.vercel/.env.production.local", import.meta.url)),
  ...process.env,
};

const CHAIN_ID = 5_042_002;
const DEFAULT_RPC = "https://rpc.testnet.arc.network";
const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";

const DEFAULT_PROOF = {
  float: "0x20dca96b0c487d94de885c726c956ffaf38b12c2",
  usdc: DEFAULT_USDC,
  owner: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8",
  sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8",
  agent: "0x5773dd87b1A2b57697f773F0dcdFa65f405662a0",
  provider: "0x8ddf06fE8985988d3e0883F945E891BD57084937",
  endpointHash: "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160",
  deployTx: "0xa4fb8e563082f64fcb8e03c7d98f1f6b3343a06efecbeda763189195342cf606",
  openLineTx: "0x490cabe47290d6a18d374c39e8f5d889e2883094b48ba2f873944eca34431a3e",
  directSpendTx: "0xf2615a12b11d42d6509bc2baaafbc81fd31e4d5b54751c3686c55458252d9b03",
  blockedSpendTx: "0x81d02cba62577eaff7f6b4bbf6233111d3372ee7cc6bc074d04030d0b41f0314",
  repayTx: "0x854380129df5c5ca590a5d5a06a4120aa8b5190cc3053901b83da5c83963f126",
  directRequestHash: "0xd53dbce76814360802c36fb03e5165759c1b383e5dfbdfb7e3f02d2426b6ccff",
  blockedRequestHash: "0x03c1655ba18fd886d6b4bcaa2b190fb47dfb5df79528bad58490da93a892e0f5",
  directReceiptHash: "0x67ec81c70701e14c704e98ba80b1d13000485675536ac761b2baff420171252f",
  blockedReceiptHash: "0x1b3a5f439f2e4faf8896d7c466fa9255784fe6dfe5ec9cedb3f90da25bf2abcd",
  reserveUSDC: 50_000n,
  directAmountUSDC: 10_000n,
  blockedAmountUSDC: 100_000n,
};

const rpcUrl = clean(env.ARC_RPC_URL || env.VITE_ARC_RPC_URL) || DEFAULT_RPC;
const proof = {
  float: addressEnv("FLOAT_V2_VERIFY_FLOAT", DEFAULT_PROOF.float),
  usdc: addressEnv("FLOAT_V2_VERIFY_USDC", clean(env.ARC_USDC || env.VITE_ARC_USDC) || DEFAULT_PROOF.usdc),
  owner: addressEnv("FLOAT_V2_VERIFY_OWNER", DEFAULT_PROOF.owner),
  sponsor: addressEnv("FLOAT_V2_VERIFY_SPONSOR", DEFAULT_PROOF.sponsor),
  agent: addressEnv("FLOAT_V2_VERIFY_AGENT", DEFAULT_PROOF.agent),
  provider: addressEnv("FLOAT_V2_VERIFY_PROVIDER", DEFAULT_PROOF.provider),
  endpointHash: hashEnv("FLOAT_V2_VERIFY_ENDPOINT_HASH", DEFAULT_PROOF.endpointHash),
  deployTx: hashEnv("FLOAT_V2_VERIFY_DEPLOY_TX", DEFAULT_PROOF.deployTx),
  openLineTx: hashEnv("FLOAT_V2_VERIFY_OPEN_LINE_TX", DEFAULT_PROOF.openLineTx),
  directSpendTx: hashEnv("FLOAT_V2_VERIFY_DIRECT_TX", DEFAULT_PROOF.directSpendTx),
  blockedSpendTx: hashEnv("FLOAT_V2_VERIFY_BLOCKED_TX", DEFAULT_PROOF.blockedSpendTx),
  repayTx: hashEnv("FLOAT_V2_VERIFY_REPAY_TX", DEFAULT_PROOF.repayTx),
  directRequestHash: hashEnv("FLOAT_V2_VERIFY_DIRECT_REQUEST_HASH", DEFAULT_PROOF.directRequestHash),
  blockedRequestHash: hashEnv("FLOAT_V2_VERIFY_BLOCKED_REQUEST_HASH", DEFAULT_PROOF.blockedRequestHash),
  directReceiptHash: hashEnv("FLOAT_V2_VERIFY_DIRECT_RECEIPT_HASH", DEFAULT_PROOF.directReceiptHash),
  blockedReceiptHash: hashEnv("FLOAT_V2_VERIFY_BLOCKED_RECEIPT_HASH", DEFAULT_PROOF.blockedReceiptHash),
  reserveUSDC: bigintEnv("FLOAT_V2_VERIFY_RESERVE_ATOMIC", DEFAULT_PROOF.reserveUSDC),
  directAmountUSDC: bigintEnv("FLOAT_V2_VERIFY_DIRECT_AMOUNT_ATOMIC", DEFAULT_PROOF.directAmountUSDC),
  blockedAmountUSDC: bigintEnv("FLOAT_V2_VERIFY_BLOCKED_AMOUNT_ATOMIC", DEFAULT_PROOF.blockedAmountUSDC),
};

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "Arc", symbol: "ARC" },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000, retryCount: 3 }) });

const floatAbi = parseAbi([
  "function owner() view returns (address)",
  "function usdc() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function totalSponsoredReserveUSDC() view returns (uint256)",
  "function totalSponsoredAvailableCreditUSDC() view returns (uint256)",
  "function totalProviderPaidUSDC() view returns (uint256)",
  "function totalDebtOpenedUSDC() view returns (uint256)",
  "function totalRepaidUSDC() view returns (uint256)",
  "function totalBlockedUSDC() view returns (uint256)",
  "function treasuryBalanceUSDC() view returns (uint256)",
  "function totalAvailableCreditUSDC() view returns (uint256)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
  "function intentNonceUsed(address agent,uint256 nonce) view returns (bool)",
  "function lines(address agent) view returns (address wallet,uint16 score,uint256 creditLimitUSDC,uint256 availableCreditUSDC,uint256 activeDebtUSDC,uint8 status,uint64 lastReview,bytes32 mandateId,uint64 day,uint256 spentTodayUSDC)",
  "function lineSponsors(address agent) view returns (address sponsor,uint256 reserveUSDC)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const sponsoredLineOpenedEvent = parseAbiItem(
  "event SponsoredLineOpened(address indexed sponsor, address indexed agent, address indexed provider, uint256 reserveUSDC, bytes32 endpointHash, uint256 maxPerRequestUSDC, uint256 dailyLimitUSDC)",
);
const intentConsumedEvent = parseAbiItem(
  "event FloatIntentConsumed(address indexed agent, address indexed signer, uint256 indexed nonce, bytes32 requestHash)",
);
const floatReceiptEvent = parseAbiItem(
  "event FloatReceipt(uint256 indexed receiptId, bytes32 indexed receiptHash, uint8 indexed receiptType, address agent, address provider, bytes32 endpointHash, uint256 amountUSDC, uint256 creditBeforeUSDC, uint256 creditAfterUSDC, uint256 debtBeforeUSDC, uint256 debtAfterUSDC, uint8 reason, bytes32 mandateId, bytes32 requestHash, bytes32 prevChecksum, bytes32 checksum)",
);

const checks = [];
const txs = await loadProofTransactions();
const deployedCode = await publicClient.getBytecode({ address: proof.float });
const codeSize = hexByteLength(deployedCode);

const [
  owner,
  usdc,
  feeBps,
  sponsorLine,
  line,
  totalSponsoredReserve,
  totalSponsoredAvailable,
  totalProviderPaid,
  totalDebtOpened,
  totalRepaid,
  totalBlocked,
  treasuryBalance,
  totalAvailable,
  directReceiptHash,
  blockedReceiptHash,
] = await Promise.all([
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "owner" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "usdc" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "feeBps" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "lineSponsors", args: [proof.agent] }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "lines", args: [proof.agent] }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "totalSponsoredReserveUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "totalSponsoredAvailableCreditUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "totalProviderPaidUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "totalDebtOpenedUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "totalRepaidUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "totalBlockedUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "treasuryBalanceUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "totalAvailableCreditUSDC" }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "receiptByRequestHash", args: [proof.directRequestHash] }),
  publicClient.readContract({ address: proof.float, abi: floatAbi, functionName: "receiptByRequestHash", args: [proof.blockedRequestHash] }),
]);

check("V2 deploy tx succeeded at expected address", txs.deploy.status === "success" && sameAddress(txs.deploy.contractAddress, proof.float), txDetail(txs.deploy));
check("V2 bytecode is deployed and EIP-170-sized", codeSize > 0 && codeSize <= 24_576, `${codeSize} bytes`);
check("V2 owner is expected sponsor/deployer", sameAddress(owner, proof.owner), owner);
check("V2 USDC immutable is Arc USDC", sameAddress(usdc, proof.usdc), usdc);
check("fee is zero on fresh V2 proof", Number(feeBps) === 0, String(feeBps));

const openEvent = findDecoded(txs.openLine, proof.float, sponsoredLineOpenedEvent, (args) => {
  return (
    sameAddress(args.sponsor, proof.sponsor) &&
    sameAddress(args.agent, proof.agent) &&
    sameAddress(args.provider, proof.provider) &&
    sameHash(args.endpointHash, proof.endpointHash) &&
    args.reserveUSDC === proof.reserveUSDC
  );
});
check("sponsor opened a permissionless line", Boolean(openEvent), openEvent ? txDetail(txs.openLine) : "missing SponsoredLineOpened");
check(
  "line sponsor reserve is still locked to the sponsor",
  sameAddress(sponsorLine[0], proof.sponsor) && sponsorLine[1] === proof.reserveUSDC && totalSponsoredReserve >= proof.reserveUSDC,
  `${fmt(sponsorLine[1])} reserve by ${sponsorLine[0]}`,
);
check("treasury backs all available credit", treasuryBalance >= totalAvailable, `${fmt(treasuryBalance)} treasury / ${fmt(totalAvailable)} available`);
check(
  "line is repaid and fully available after proof",
  sameAddress(line[0], proof.agent) && line[2] === proof.reserveUSDC && line[3] === proof.reserveUSDC && line[4] === 0n,
  `limit=${fmt(line[2])} available=${fmt(line[3])} debt=${fmt(line[4])}`,
);
check("behavior lifted the line to the sponsor reserve cap", Number(line[1]) >= 8000, `score=${line[1]}`);

const directIntent = findIntent(txs.directSpend, proof.directRequestHash);
check("direct spend consumed the agent's signed intent", Boolean(directIntent), directIntent?.detail || "missing FloatIntentConsumed");
if (directIntent) {
  const used = await publicClient.readContract({
    address: proof.float,
    abi: floatAbi,
    functionName: "intentNonceUsed",
    args: [proof.agent, directIntent.nonce],
  });
  check("direct intent nonce is used on-chain", Boolean(used), directIntent.nonce.toString());
}

const directTransfer = hasTransfer(txs.directSpend, {
  from: proof.float,
  to: proof.provider,
  amount: proof.directAmountUSDC,
});
check("direct V2 spend paid provider from contract custody", directTransfer, `${fmt(proof.directAmountUSDC)} ${short(proof.float)} -> ${short(proof.provider)}`);
check("direct request hash is anchored", sameHash(directReceiptHash, proof.directReceiptHash), directReceiptHash);
check(
  "direct spend wrote paid/debt receipts",
  hasReceipt(txs.directSpend, { requestHash: proof.directRequestHash, receiptType: 2, amount: proof.directAmountUSDC }) &&
    hasReceipt(txs.directSpend, { requestHash: proof.directRequestHash, receiptType: 4, amount: proof.directAmountUSDC }) &&
    hasReceipt(txs.directSpend, { requestHash: proof.directRequestHash, receiptType: 5, amount: proof.directAmountUSDC }),
  "SPEND_ALLOWED + PROVIDER_PAID + DEBT_OPENED",
);

const blockedIntent = findIntent(txs.blockedSpend, proof.blockedRequestHash);
check("blocked overrun consumed the agent's signed intent", Boolean(blockedIntent), blockedIntent?.detail || "missing FloatIntentConsumed");
if (blockedIntent) {
  const used = await publicClient.readContract({
    address: proof.float,
    abi: floatAbi,
    functionName: "intentNonceUsed",
    args: [proof.agent, blockedIntent.nonce],
  });
  check("blocked intent nonce is used on-chain", Boolean(used), blockedIntent.nonce.toString());
}

const blockedPaidProvider = hasAnyTransfer(txs.blockedSpend, { from: proof.float, to: proof.provider });
check("blocked overrun moved no provider funds", !blockedPaidProvider, "no USDC Transfer from Float to provider");
check("blocked request hash is anchored", sameHash(blockedReceiptHash, proof.blockedReceiptHash), blockedReceiptHash);
check(
  "blocked spend wrote an amount-too-high receipt",
  hasReceipt(txs.blockedSpend, { requestHash: proof.blockedRequestHash, receiptType: 3, amount: proof.blockedAmountUSDC, reason: 7 }),
  "SPEND_BLOCKED / AMOUNT_TOO_HIGH",
);

check("repay tx succeeded", txs.repay.status === "success", txDetail(txs.repay));
const openExternalDebt = totalDebtOpened >= totalRepaid ? totalDebtOpened - totalRepaid : null;
check("provider paid total includes direct proof spend", totalProviderPaid >= proof.directAmountUSDC, fmt(totalProviderPaid));
check(
  "global debt accounting is non-negative",
  openExternalDebt !== null,
  openExternalDebt === null
    ? `${fmt(totalDebtOpened)} opened / ${fmt(totalRepaid)} repaid`
    : `${fmt(totalDebtOpened)} opened / ${fmt(totalRepaid)} repaid / ${fmt(openExternalDebt)} open external debt`,
);
check("blocked total includes overrun amount", totalBlocked >= proof.blockedAmountUSDC, fmt(totalBlocked));
check("sponsored available accounting tracks restored line", totalSponsoredAvailable >= proof.reserveUSDC, fmt(totalSponsoredAvailable));

const result = {
  ok: checks.every((entry) => entry.ok),
  checkedAt: new Date().toISOString(),
  mode: "shadow-float-v2-proof-loop-verifier",
  chainId: CHAIN_ID,
  rpcUrl: rpcUrl === DEFAULT_RPC ? DEFAULT_RPC : "[custom rpc]",
  contracts: {
    shadowFloatV2: proof.float,
    usdc: proof.usdc,
  },
  actors: {
    owner: proof.owner,
    sponsor: proof.sponsor,
    agent: proof.agent,
    provider: proof.provider,
  },
  requestHashes: {
    directSpend: proof.directRequestHash,
    blockedOverspend: proof.blockedRequestHash,
  },
  txs: {
    deploy: proof.deployTx,
    openSponsoredLine: proof.openLineTx,
    directSpend: proof.directSpendTx,
    blockedOverspend: proof.blockedSpendTx,
    repay: proof.repayTx,
  },
  finalLine: {
    score: Number(line[1]),
    creditLimitUSDC: line[2].toString(),
    availableCreditUSDC: line[3].toString(),
    activeDebtUSDC: line[4].toString(),
    status: Number(line[5]),
  },
  totals: {
    sponsoredReserveUSDC: totalSponsoredReserve.toString(),
    sponsoredAvailableCreditUSDC: totalSponsoredAvailable.toString(),
    providerPaidUSDC: totalProviderPaid.toString(),
    debtOpenedUSDC: totalDebtOpened.toString(),
    repaidUSDC: totalRepaid.toString(),
    openDebtUSDC: openExternalDebt?.toString() ?? "0",
    blockedUSDC: totalBlocked.toString(),
  },
  checks,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

async function loadProofTransactions() {
  const [deploy, openLine, directSpend, blockedSpend, repay] = await Promise.all([
    txReceipt(proof.deployTx),
    txReceipt(proof.openLineTx),
    txReceipt(proof.directSpendTx),
    txReceipt(proof.blockedSpendTx),
    txReceipt(proof.repayTx),
  ]);
  return { deploy, openLine, directSpend, blockedSpend, repay };
}

async function txReceipt(hash) {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  return {
    hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    contractAddress: receipt.contractAddress,
    logs: receipt.logs,
  };
}

function check(name, ok, detail = "") {
  checks.push({ check: name, status: ok ? "PASS" : "FAIL", ok, detail: String(detail) });
}

function findIntent(tx, requestHash) {
  const decoded = findDecoded(tx, proof.float, intentConsumedEvent, (args) => sameHash(args.requestHash, requestHash));
  if (!decoded) return null;
  return {
    nonce: decoded.nonce,
    detail: `nonce=${decoded.nonce.toString()} signer=${decoded.signer}`,
  };
}

function findDecoded(tx, address, event, predicate) {
  for (const log of tx.logs) {
    if (!sameAddress(log.address, address)) continue;
    const decoded = decodeLog(event, log);
    if (decoded && predicate(decoded.args)) return decoded.args;
  }
  return null;
}

function hasReceipt(tx, { requestHash, receiptType, amount, reason }) {
  return tx.logs.some((log) => {
    if (!sameAddress(log.address, proof.float)) return false;
    const decoded = decodeLog(floatReceiptEvent, log);
    if (!decoded) return false;
    return (
      sameHash(decoded.args.requestHash, requestHash) &&
      Number(decoded.args.receiptType) === receiptType &&
      decoded.args.amountUSDC === amount &&
      (reason === undefined || Number(decoded.args.reason) === reason)
    );
  });
}

function hasTransfer(tx, { from, to, amount }) {
  return tx.logs.some((log) => {
    if (!sameAddress(log.address, proof.usdc)) return false;
    const decoded = decodeLog(transferEvent, log);
    return Boolean(
      decoded && sameAddress(decoded.args.from, from) && sameAddress(decoded.args.to, to) && decoded.args.value === amount,
    );
  });
}

function hasAnyTransfer(tx, { from, to }) {
  return tx.logs.some((log) => {
    if (!sameAddress(log.address, proof.usdc)) return false;
    const decoded = decodeLog(transferEvent, log);
    return Boolean(decoded && sameAddress(decoded.args.from, from) && sameAddress(decoded.args.to, to) && decoded.args.value > 0n);
  });
}

function decodeLog(event, log) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

function sameAddress(a, b) {
  if (!a || !b) return false;
  return getAddress(a) === getAddress(b);
}

function sameHash(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function addressEnv(key, fallback) {
  return getAddress(clean(env[key]) || fallback);
}

function hashEnv(key, fallback) {
  const value = clean(env[key]) || fallback;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${key} must be bytes32`);
  return value;
}

function bigintEnv(key, fallback) {
  const value = clean(env[key]);
  return value ? BigInt(value) : fallback;
}

function fmt(value) {
  return `${formatUnits(BigInt(value), 6)} USDC`;
}

function short(value) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function txDetail(tx) {
  return `${tx.hash} block=${tx.blockNumber} status=${tx.status}`;
}

function hexByteLength(hex) {
  if (!hex || hex === "0x") return 0;
  return (hex.length - 2) / 2;
}

function readEnv(path) {
  const pathname = path instanceof URL ? path : new URL(path, import.meta.url);
  if (!existsSync(pathname)) return {};
  return Object.fromEntries(
    readFileSync(pathname, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "").trim()];
      }),
  );
}

function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}
