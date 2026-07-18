import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";

const clean = (value) => String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
const required = (name) => {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const asAddress = (name, fallback) => getAddress(clean(process.env[name]) || fallback);
const asHash = (name) => {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a transaction hash`);
  return value;
};
const asBigInt = (value) => BigInt(value);
const json = (value) => JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const MODE = clean(process.env.MODE) || "snapshot";
const RPC = required("RPC");
const SPLITTER = asAddress("SPLITTER");
const ROUTER = asAddress("ROUTER");
const PROTOCOL = asAddress("PROTOCOL");
const FEE_ROUTER = asAddress("FEE_ROUTER", "0xeff9bc359e8f2a5eabce55af3f1bb24f98eabf59");
const FORUM_SOURCE = asAddress("FORUM_SOURCE", "0x13585c6004fbA9D7D49219a6435B68348fD30770");
const FORUM_PAYOUT = asAddress("FORUM_PAYOUT", "0x13585c6004fbA9D7D49219a6435B68348fD30770");
const USDC = asAddress("USDC", "0x3600000000000000000000000000000000000000");
const STATE_FILE = clean(process.env.STATE_FILE) || "/tmp/shadow-forum-canary-state.json";
const RPC_READ_DELAY_MS = Number(clean(process.env.RPC_READ_DELAY_MS) || "2500");
assert(
  Number.isFinite(RPC_READ_DELAY_MS) && RPC_READ_DELAY_MS >= 0 && RPC_READ_DELAY_MS <= 5_000,
  "RPC_READ_DELAY_MS must be between 0 and 5000",
);

const arc = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain: arc, transport: http(RPC, { timeout: 60_000, retryCount: 3 }) });

const splitterAbi = parseAbi([
  "function splitIdOf(address sourceAgent) view returns (bool exists,uint256 splitId)",
  "function externalRoutingEnabled() view returns (bool)",
  "function sourceKickbackUSDC(address sourceAgent) view returns (uint256)",
  "function protocolFeesUSDC() view returns (uint256)",
  "function SOURCE_FEE_SHARE_BPS() view returns (uint16)",
  "function authorizedRouter() view returns (address)",
]);
const routerAbi = parseAbi([
  "function followerCount(address sourceAgent) view returns (uint256)",
]);
const feeRouterAbi = parseAbi([
  "function claimableOf(uint256 splitId,address recipient) view returns (uint256)",
  "function totalClaimableOf(address recipient) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);
const mirrorFeeRoutedEvent = parseAbiItem(
  "event MirrorFeeRouted(address indexed sourceAgent,uint256 splitId,uint256 sourceShareUSDC,uint256 protocolShareUSDC)",
);
const mirrorReceiptEvent = parseAbiItem(
  "event MirrorReceipt(uint256 indexed intentId,address indexed follower,address indexed sourceAgent,uint8 status,uint8 reason,uint256 usdcAmount,uint256 mirrorFeeUSDC,uint256 assetAmountOut)",
);
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const throttled = async (request) => {
  const result = await request();
  if (RPC_READ_DELAY_MS > 0) await wait(RPC_READ_DELAY_MS);
  return result;
};
const read = (address, abi, functionName, args = [], blockNumber) =>
  throttled(() => client.readContract({ address, abi, functionName, args, blockNumber }));
const loadState = () => {
  if (!existsSync(STATE_FILE)) throw new Error(`state file not found: ${STATE_FILE}`);
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
};
const writeState = (state) => {
  writeFileSync(STATE_FILE, `${json(state)}\n`, { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
  console.log(`state=${STATE_FILE}`);
};

async function capture() {
  const chainId = await throttled(() => client.getChainId());
  const blockNumber = await throttled(() => client.getBlockNumber());
  const atSnapshot = (address, abi, functionName, args = []) => read(address, abi, functionName, args, blockNumber);

  const [exists, splitId] = await atSnapshot(SPLITTER, splitterAbi, "splitIdOf", [FORUM_SOURCE]);
  assert(exists, "Forum split is not preconfigured");

  const shareBps = await atSnapshot(SPLITTER, splitterAbi, "SOURCE_FEE_SHARE_BPS");
  const routingEnabled = await atSnapshot(SPLITTER, splitterAbi, "externalRoutingEnabled");
  const authorizedRouter = await atSnapshot(SPLITTER, splitterAbi, "authorizedRouter");
  const followerCount = await atSnapshot(ROUTER, routerAbi, "followerCount", [FORUM_SOURCE]);
  const payoutHistorical = await atSnapshot(FEE_ROUTER, feeRouterAbi, "claimableOf", [splitId, FORUM_PAYOUT]);
  const protocolHistorical = await atSnapshot(FEE_ROUTER, feeRouterAbi, "claimableOf", [splitId, PROTOCOL]);
  const payoutOutstanding = await atSnapshot(FEE_ROUTER, feeRouterAbi, "totalClaimableOf", [FORUM_PAYOUT]);
  const protocolOutstanding = await atSnapshot(FEE_ROUTER, feeRouterAbi, "totalClaimableOf", [PROTOCOL]);
  const sourceFallback = await atSnapshot(SPLITTER, splitterAbi, "sourceKickbackUSDC", [FORUM_SOURCE]);
  const protocolFallback = await atSnapshot(SPLITTER, splitterAbi, "protocolFeesUSDC");
  const splitterToFeeRouterAllowance = await atSnapshot(USDC, erc20Abi, "allowance", [SPLITTER, FEE_ROUTER]);
  const routerToSplitterAllowance = await atSnapshot(USDC, erc20Abi, "allowance", [ROUTER, SPLITTER]);
  const payoutBalance = await atSnapshot(USDC, erc20Abi, "balanceOf", [FORUM_PAYOUT]);
  const protocolBalance = await atSnapshot(USDC, erc20Abi, "balanceOf", [PROTOCOL]);

  assert(chainId === arc.id, `wrong chain: ${chainId}`);
  assert(getAddress(authorizedRouter) === ROUTER, "splitter authorizedRouter does not match ROUTER");
  assert(followerCount === 1n, `expected exactly one Forum follower, found ${followerCount}`);

  return {
    chainId,
    blockNumber,
    splitter: SPLITTER,
    router: ROUTER,
    feeRouter: FEE_ROUTER,
    protocol: PROTOCOL,
    forumSource: FORUM_SOURCE,
    forumPayout: FORUM_PAYOUT,
    usdc: USDC,
    splitId,
    shareBps,
    routingEnabled,
    payoutHistorical,
    protocolHistorical,
    payoutOutstanding,
    protocolOutstanding,
    sourceFallback,
    protocolFallback,
    splitterToFeeRouterAllowance,
    routerToSplitterAllowance,
    payoutBalance,
    protocolBalance,
  };
}

function assertIdentity(state) {
  for (const key of ["splitter", "router", "feeRouter", "protocol", "forumSource", "forumPayout", "usdc"]) {
    assert(getAddress(state[key]) === { splitter: SPLITTER, router: ROUTER, feeRouter: FEE_ROUTER, protocol: PROTOCOL, forumSource: FORUM_SOURCE, forumPayout: FORUM_PAYOUT, usdc: USDC }[key], `${key} differs from baseline`);
  }
}

function decodeFrom(receipt, address, event) {
  return receipt.logs
    .filter((log) => getAddress(log.address) === address)
    .flatMap((log) => {
      try {
        return [decodeEventLog({ abi: [event], data: log.data, topics: log.topics })];
      } catch {
        return [];
      }
    });
}

if (MODE === "snapshot") {
  const baseline = await capture();
  assert(!baseline.routingEnabled, "snapshot must be taken while external routing is disabled");
  assert(asBigInt(baseline.payoutHistorical) === 0n, "Forum split already has historical allocations");
  assert(asBigInt(baseline.protocolHistorical) === 0n, "protocol split already has historical allocations");
  assert(asBigInt(baseline.payoutOutstanding) === 0n, "Forum payout wallet has pre-existing FeeRouter outstanding");
  assert(asBigInt(baseline.protocolOutstanding) === 0n, "protocol wallet has pre-existing FeeRouter outstanding");
  assert(asBigInt(baseline.splitterToFeeRouterAllowance) === 0n, "splitter -> FeeRouter allowance is not zero");
  assert(asBigInt(baseline.routerToSplitterAllowance) === 0n, "router -> splitter allowance is not zero");
  writeState({ phase: "snapshot", baseline });
  console.log(json({ result: "SNAPSHOT_RECORDED", baseline }));
} else if (MODE === "route") {
  const stored = loadState();
  assert(stored.phase === "snapshot", "state file is not at snapshot phase");
  assertIdentity(stored.baseline);

  const txHash = asHash("MIRROR_TX");
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  assert(receipt.status === "success", "mirror transaction failed");
  assert(getAddress(receipt.from) === FORUM_SOURCE, "mirror transaction was not signed by Forum");
  assert(receipt.blockNumber > asBigInt(stored.baseline.blockNumber), "mirror transaction predates the baseline");

  const routedEvents = decodeFrom(receipt, SPLITTER, mirrorFeeRoutedEvent);
  const copiedEvents = decodeFrom(receipt, ROUTER, mirrorReceiptEvent).filter(
    (event) => Number(event.args.status) === 0 && getAddress(event.args.sourceAgent) === FORUM_SOURCE,
  );
  assert(routedEvents.length === 1, `expected one MirrorFeeRouted event, found ${routedEvents.length}`);
  assert(copiedEvents.length === 1, `expected one copied MirrorReceipt event, found ${copiedEvents.length}`);

  const routed = routedEvents[0].args;
  const copied = copiedEvents[0].args;
  assert(getAddress(routed.sourceAgent) === FORUM_SOURCE, "routed source is not Forum");
  assert(asBigInt(routed.splitId) === asBigInt(stored.baseline.splitId), "routed splitId differs from baseline");
  assert(asBigInt(copied.usdcAmount) === 10_000n, `unexpected copied amount: ${copied.usdcAmount}`);
  assert(asBigInt(copied.mirrorFeeUSDC) === 10n, `unexpected mirror fee: ${copied.mirrorFeeUSDC}`);
  assert(Number(copied.reason) === 0, `copy reason is not NONE: ${copied.reason}`);

  const expectedForum = (asBigInt(copied.mirrorFeeUSDC) * asBigInt(stored.baseline.shareBps)) / 10_000n;
  const expectedProtocol = asBigInt(copied.mirrorFeeUSDC) - expectedForum;
  assert(asBigInt(routed.sourceShareUSDC) === expectedForum, "MirrorFeeRouted Forum share is wrong");
  assert(asBigInt(routed.protocolShareUSDC) === expectedProtocol, "MirrorFeeRouted protocol share is wrong");

  const afterRoute = await capture();
  assert(!afterRoute.routingEnabled, "external routing must be disabled again before route verification");
  assert(asBigInt(afterRoute.payoutHistorical) - asBigInt(stored.baseline.payoutHistorical) === expectedForum, "Forum split delta is not exact");
  assert(asBigInt(afterRoute.protocolHistorical) - asBigInt(stored.baseline.protocolHistorical) === expectedProtocol, "protocol split delta is not exact");
  assert(asBigInt(afterRoute.payoutOutstanding) - asBigInt(stored.baseline.payoutOutstanding) === expectedForum, "Forum outstanding delta is not exact");
  assert(asBigInt(afterRoute.protocolOutstanding) - asBigInt(stored.baseline.protocolOutstanding) === expectedProtocol, "protocol outstanding delta is not exact");
  assert(asBigInt(afterRoute.sourceFallback) === asBigInt(stored.baseline.sourceFallback), "unexpected Forum local fallback accrual");
  assert(asBigInt(afterRoute.protocolFallback) === asBigInt(stored.baseline.protocolFallback), "unexpected protocol local fallback accrual");
  assert(asBigInt(afterRoute.splitterToFeeRouterAllowance) === 0n, "splitter -> FeeRouter allowance is not zero");
  assert(asBigInt(afterRoute.routerToSplitterAllowance) === 0n, "router -> splitter allowance is not zero");

  const route = { txHash, expectedForum, expectedProtocol, afterRoute };
  writeState({ phase: "route", baseline: stored.baseline, route });
  console.log(json({ result: "ROUTE_VERIFIED", route }));
} else if (MODE === "claims") {
  const stored = loadState();
  assert(stored.phase === "route", "state file is not at route phase");
  assertIdentity(stored.baseline);

  const forumClaimTx = asHash("FORUM_CLAIM_TX");
  const protocolClaimTx = asHash("PROTOCOL_CLAIM_TX");
  const [forumReceipt, protocolReceipt] = await Promise.all([
    client.getTransactionReceipt({ hash: forumClaimTx }),
    client.getTransactionReceipt({ hash: protocolClaimTx }),
  ]);
  assert(forumReceipt.status === "success", "Forum claim transaction failed");
  assert(protocolReceipt.status === "success", "protocol claim transaction failed");
  assert(getAddress(forumReceipt.from) === FORUM_PAYOUT, "Forum claim was not sent by the Forum payout wallet");
  assert(getAddress(protocolReceipt.from) === PROTOCOL, "protocol claim was not sent by the protocol recipient");
  assert(
    forumReceipt.blockNumber > asBigInt(stored.route.afterRoute.blockNumber),
    "Forum claim transaction predates the verified route",
  );
  assert(
    protocolReceipt.blockNumber > asBigInt(stored.route.afterRoute.blockNumber),
    "protocol claim transaction predates the verified route",
  );

  const expectedForumClaim = asBigInt(stored.route.expectedForum);
  const expectedProtocolClaim = asBigInt(stored.route.expectedProtocol);
  const forumTransfers = decodeFrom(forumReceipt, USDC, transferEvent).filter(
    (event) => getAddress(event.args.from) === FEE_ROUTER && getAddress(event.args.to) === FORUM_PAYOUT,
  );
  const protocolTransfers = decodeFrom(protocolReceipt, USDC, transferEvent).filter(
    (event) => getAddress(event.args.from) === FEE_ROUTER && getAddress(event.args.to) === PROTOCOL,
  );
  assert(forumTransfers.length === 1, `expected one Forum claim transfer, found ${forumTransfers.length}`);
  assert(protocolTransfers.length === 1, `expected one protocol claim transfer, found ${protocolTransfers.length}`);
  assert(asBigInt(forumTransfers[0].args.value) === expectedForumClaim, "Forum claim transfer is not exact");
  assert(asBigInt(protocolTransfers[0].args.value) === expectedProtocolClaim, "protocol claim transfer is not exact");

  const final = await capture();
  assert(!final.routingEnabled, "external routing is still enabled after the canary");
  assert(
    asBigInt(final.payoutHistorical) === asBigInt(stored.route.afterRoute.payoutHistorical),
    "Forum split allocation changed after the verified route",
  );
  assert(
    asBigInt(final.protocolHistorical) === asBigInt(stored.route.afterRoute.protocolHistorical),
    "protocol split allocation changed after the verified route",
  );
  assert(asBigInt(final.payoutOutstanding) === 0n, "Forum totalClaimableOf is not zero after claim");
  assert(asBigInt(final.protocolOutstanding) === 0n, "protocol totalClaimableOf is not zero after claim");
  assert(asBigInt(final.splitterToFeeRouterAllowance) === 0n, "splitter -> FeeRouter allowance is not zero after claims");
  assert(asBigInt(final.routerToSplitterAllowance) === 0n, "router -> splitter allowance is not zero after claims");

  const claims = {
    forumClaimTx,
    forumClaimBlock: forumReceipt.blockNumber,
    forumClaimAmount: expectedForumClaim,
    protocolClaimTx,
    protocolClaimBlock: protocolReceipt.blockNumber,
    protocolClaimAmount: expectedProtocolClaim,
    final,
  };
  writeState({ ...stored, phase: "complete", claims });
  console.log(json({ result: "CANARY_COMPLETE", claims }));
} else {
  throw new Error(`unsupported MODE: ${MODE}`);
}
