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

const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
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
  const [exists, splitId] = await read(SPLITTER, splitterAbi, "splitIdOf", [FORUM_SOURCE]);
  assert(exists, "Forum split is not preconfigured");

  const [
    chainId,
    blockNumber,
    shareBps,
    routingEnabled,
    authorizedRouter,
    followerCount,
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
  ] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    read(SPLITTER, splitterAbi, "SOURCE_FEE_SHARE_BPS"),
    read(SPLITTER, splitterAbi, "externalRoutingEnabled"),
    read(SPLITTER, splitterAbi, "authorizedRouter"),
    read(ROUTER, routerAbi, "followerCount", [FORUM_SOURCE]),
    read(FEE_ROUTER, feeRouterAbi, "claimableOf", [splitId, FORUM_PAYOUT]),
    read(FEE_ROUTER, feeRouterAbi, "claimableOf", [splitId, PROTOCOL]),
    read(FEE_ROUTER, feeRouterAbi, "totalClaimableOf", [FORUM_PAYOUT]),
    read(FEE_ROUTER, feeRouterAbi, "totalClaimableOf", [PROTOCOL]),
    read(SPLITTER, splitterAbi, "sourceKickbackUSDC", [FORUM_SOURCE]),
    read(SPLITTER, splitterAbi, "protocolFeesUSDC"),
    read(USDC, erc20Abi, "allowance", [SPLITTER, FEE_ROUTER]),
    read(USDC, erc20Abi, "allowance", [ROUTER, SPLITTER]),
    read(USDC, erc20Abi, "balanceOf", [FORUM_PAYOUT]),
    read(USDC, erc20Abi, "balanceOf", [PROTOCOL]),
  ]);

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

  const expectedForumClaim = asBigInt(stored.route.afterRoute.payoutOutstanding);
  const expectedProtocolClaim = asBigInt(stored.route.afterRoute.protocolOutstanding);
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
  assert(asBigInt(final.payoutOutstanding) === 0n, "Forum totalClaimableOf is not zero after claim");
  assert(asBigInt(final.protocolOutstanding) === 0n, "protocol totalClaimableOf is not zero after claim");
  assert(asBigInt(final.payoutBalance) - asBigInt(stored.baseline.payoutBalance) === expectedForumClaim, "Forum USDC balance delta is not exact");
  assert(asBigInt(final.protocolBalance) - asBigInt(stored.baseline.protocolBalance) === expectedProtocolClaim, "protocol USDC balance delta is not exact");
  assert(asBigInt(final.splitterToFeeRouterAllowance) === 0n, "splitter -> FeeRouter allowance is not zero after claims");
  assert(asBigInt(final.routerToSplitterAllowance) === 0n, "router -> splitter allowance is not zero after claims");

  writeState({ ...stored, phase: "complete", claims: { forumClaimTx, protocolClaimTx, final } });
  console.log(json({ result: "CANARY_COMPLETE", forumClaimTx, protocolClaimTx, final }));
} else {
  throw new Error(`unsupported MODE: ${MODE}`);
}
