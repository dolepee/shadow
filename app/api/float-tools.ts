import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  recoverTypedDataAddress,
  stringToBytes,
} from "viem";

export const config = { maxDuration: 15 };

const ARC_CHAIN_ID = 5_042_002;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_ALPHA = "0xa100000000000000000000000000000000000001";
const DEFAULT_BETA = "0xbe7a000000000000000000000000000000000002";
const DEFAULT_SELF_TEST_AGENTS = [
  "0x0C63826eE08aF1f144ec5D84B6c56fe393fE19F5",
  "0xD3eed2f7dcED5fbc96Fb1a0FC058C540D50b4f80",
  "0xa539a18b55e5e3b98892c724f8f75914c0b69942",
] as const;
const STATUSES = ["UNKNOWN", "ELIGIBLE", "LIMITED", "DENIED", "REVOKED", "REPAID", "DEFAULTED"];

const floatAbi = parseAbi([
  "function lines(address agent) view returns (address wallet, uint16 score, uint256 creditLimitUSDC, uint256 availableCreditUSDC, uint256 activeDebtUSDC, uint8 status, uint64 lastReview, bytes32 mandateId, uint64 day, uint256 spentTodayUSDC)",
  "function receiptByRequestHash(bytes32 requestHash) view returns (bytes32)",
]);
const x402PaymentBoundEvent = parseAbiItem(
  "event X402PaymentBound(uint256 indexed receiptId, bytes32 indexed requestHash, bytes32 x402Hash, address indexed provider, uint256 amountUSDC, address facilitator)",
);

type Req = { method?: string; url?: string; query?: Record<string, string | string[] | undefined> };
type Res = { setHeader(n: string, v: string | number): void; status(c: number): Res; json(b: unknown): void };

type LoopRun = {
  source?: string;
  float?: string;
  agent?: string;
  requestHash?: string;
  rationalePreimage?: string;
  rationale?: string;
  action?: string;
  outcome?: string;
  model?: string;
  at?: string;
  amountUSDC?: string;
  txHash?: string;
  signature?: string;
  intent?: SignedIntent;
  x402Hash?: string;
  bindTxHash?: string;
};

type SignedIntent = {
  agent: string;
  provider: string;
  endpointHash: string;
  amountUSDC: string;
  nonce: string;
  expiry: string;
  reason: string;
  float: string;
  chainId: number;
};

const intentTypes = {
  FloatSpendIntent: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "reason", type: "string" },
  ],
} as const;

export default async function handler(req: Req, res: Res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method not allowed, use GET" });
    return;
  }

  const action = readParam(req, "action");
  if (action === "agent") return handleAgent(req, res);
  if (action === "rationale") return handleRationale(req, res);
  if (action === "verify") return handleVerify(req, res);
  if (action === "score") return handleScore(req, res);

  res.status(400).json({
    error: "pass ?action=agent|rationale|verify|score",
    examples: [
      "/api/float-tools?action=agent&address=0x...",
      "/api/float-tools?action=rationale&hash=0x...",
      "/api/float-tools?action=verify&hash=0x...",
      "/api/float-tools?action=score&address=0x...",
    ],
  });
}

async function handleAgent(req: Req, res: Res) {
  const address = readParam(req, "address");
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: "pass ?action=agent&address=0x... (the agent address whose Float standing you want)" });
    return;
  }

  const floatRaw = clean(process.env.SHADOW_FLOAT || process.env.VITE_SHADOW_FLOAT);
  if (!floatRaw || !isAddress(floatRaw)) {
    res.status(200).json({ configured: false, testnet: true, network: "arc-testnet" });
    return;
  }
  const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";

  try {
    const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) });
    const line = await client.readContract({
      address: getAddress(floatRaw),
      abi: floatAbi,
      functionName: "lines",
      args: [getAddress(address)],
    });
    const wallet = line[0] as string;
    const known = Boolean(wallet) && wallet.toLowerCase() !== ZERO;
    res.status(200).json({
      configured: true,
      testnet: true,
      network: "arc-testnet",
      float: getAddress(floatRaw),
      agent: getAddress(address),
      label: labelFor(address),
      known,
      standing: known
        ? {
            wallet,
            score: Number(line[1]),
            creditLimitUSDC: (line[2] as bigint).toString(),
            availableCreditUSDC: (line[3] as bigint).toString(),
            activeDebtUSDC: (line[4] as bigint).toString(),
            status: STATUSES[Number(line[5])] || `STATUS_${line[5]}`,
            lastReview: Number(line[6]),
          }
        : null,
      note: known
        ? "Standing is behavior-backed: the Shadow operator grants and adjusts the line from observed on-chain behavior."
        : "No Float line for this address yet. Behavior earns a line; it is not self-claimed.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ configured: true, degraded: true, error: sanitize(error) });
  }
}

async function handleRationale(req: Req, res: Res) {
  const hash = readHash(req);
  if (!hash) {
    res.status(400).json({ error: "pass ?action=rationale&hash=0x... (the requestHash from a Float receipt)" });
    return;
  }

  const floatRaw = clean(process.env.SHADOW_FLOAT || process.env.VITE_SHADOW_FLOAT);
  const runs = filterRunsForFloat(await readLoopRuns(), floatRaw);
  const match = runs.find((r) => (r.requestHash || "").toLowerCase() === hash.toLowerCase());
  if (!match || !match.rationalePreimage) {
    res.status(200).json({
      found: false,
      requestHash: hash,
      note: "No published rationale preimage for this requestHash on the current Float deployment. Admin/demo actions and receipts predating re-hashable rationale will not have one.",
      fetchedAt: Date.now(),
    });
    return;
  }

  const recomputedHash = keccak256(stringToBytes(match.rationalePreimage));
  res.status(200).json({
    found: true,
    requestHash: hash,
    rationalePreimage: match.rationalePreimage,
    recomputedHash,
    matches: recomputedHash.toLowerCase() === hash.toLowerCase(),
    decision: {
      action: match.action,
      outcome: match.outcome,
      rationale: match.rationale,
      model: match.model,
      at: match.at,
    },
    note: "requestHash = keccak256(rationalePreimage). Re-hash the preimage to verify the on-chain commitment to the agent's reasoning.",
    fetchedAt: Date.now(),
  });
}

async function handleVerify(req: Req, res: Res) {
  const hash = readHash(req);
  if (!hash) {
    res.status(400).json({ error: "pass ?action=verify&hash=0x... (the requestHash from a signed external Float receipt)" });
    return;
  }

  const floatRaw = clean(process.env.SHADOW_FLOAT || process.env.VITE_SHADOW_FLOAT);
  if (!floatRaw || !isAddress(floatRaw)) {
    res.status(200).json({ configured: false, testnet: true, network: "arc-testnet" });
    return;
  }
  const runs = filterRunsForFloat(await readLoopRuns(), floatRaw);
  const match = runs.find((r) => r.source === "external-signed" && (r.requestHash || "").toLowerCase() === hash.toLowerCase());
  if (!match || !match.intent || !match.signature) {
    res.status(200).json({
      found: false,
      requestHash: hash,
      note: "No signed external intent for this requestHash on the current Float deployment. Lab-loop and requestSpend receipts are not signed-intent spends.",
      fetchedAt: Date.now(),
    });
    return;
  }

  const intent = match.intent;
  const domain = {
    name: "ShadowFloat",
    version: "1",
    chainId: intent.chainId || ARC_CHAIN_ID,
    verifyingContract: getAddress(intent.float),
  };
  const message = {
    agent: getAddress(intent.agent),
    provider: getAddress(intent.provider),
    endpointHash: intent.endpointHash as `0x${string}`,
    amountUSDC: BigInt(intent.amountUSDC),
    nonce: BigInt(intent.nonce),
    expiry: BigInt(intent.expiry),
    reason: intent.reason,
  };

  try {
    const recovered = await recoverTypedDataAddress({
      domain,
      types: intentTypes,
      primaryType: "FloatSpendIntent",
      message,
      signature: match.signature as `0x${string}`,
    });
    const digest = hashTypedData({ domain, types: intentTypes, primaryType: "FloatSpendIntent", message });
    const signerMatchesAgent = getAddress(recovered) === getAddress(intent.agent);
    const digestMatchesRequestHash = digest.toLowerCase() === hash.toLowerCase();
    const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
    const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) });
    const onchain = await verifyOnchainExternalProof(client, {
      float: getAddress(floatRaw),
      requestHash: hash,
      bindTxHash: match.bindTxHash,
      x402Hash: match.x402Hash,
      provider: getAddress(intent.provider),
      amountUSDC: BigInt(intent.amountUSDC),
    });
    if (!signerMatchesAgent || !digestMatchesRequestHash || !onchain.ok) {
      res.status(200).json({
        found: false,
        metadataFound: true,
        requestHash: hash,
        recoveredSigner: recovered,
        agent: getAddress(intent.agent),
        signerMatchesAgent,
        digestMatchesRequestHash,
        onchainVerified: false,
        onchain,
        note: "A signed metadata record exists, but the current Float deployment did not verify the full on-chain bind proof.",
        fetchedAt: Date.now(),
      });
      return;
    }
    res.status(200).json({
      found: true,
      requestHash: hash,
      recoveredSigner: recovered,
      agent: getAddress(intent.agent),
      signerMatchesAgent,
      digestMatchesRequestHash,
      onchainVerified: true,
      receiptHash: onchain.receiptHash,
      intent,
      signature: match.signature,
      x402Hash: match.x402Hash,
      bindTxHash: match.bindTxHash,
      note: "Recompute: hashTypedData(intent) must equal requestHash, recoverTypedDataAddress(intent, signature) must equal agent, receiptByRequestHash must be nonzero, and bindTxHash must emit the matching X402PaymentBound event.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.status(200).json({ found: true, requestHash: hash, error: String((error as Error)?.message || error).slice(0, 200) });
  }
}

async function verifyOnchainExternalProof(
  client: ReturnType<typeof createPublicClient>,
  expected: {
    float: `0x${string}`;
    requestHash: `0x${string}`;
    bindTxHash?: string;
    x402Hash?: string;
    provider: string;
    amountUSDC: bigint;
  },
) {
  try {
    const receiptHash = await client.readContract({
      address: expected.float,
      abi: floatAbi,
      functionName: "receiptByRequestHash",
      args: [expected.requestHash],
    });
    if (!receiptHash || receiptHash === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      return { ok: false, reason: "receiptByRequestHash is empty" };
    }
    if (!expected.bindTxHash || !/^0x[0-9a-fA-F]{64}$/.test(expected.bindTxHash)) {
      return { ok: false, receiptHash, reason: "missing valid bindTxHash" };
    }
    if (!expected.x402Hash || !/^0x[0-9a-fA-F]{64}$/.test(expected.x402Hash)) {
      return { ok: false, receiptHash, reason: "missing valid x402Hash" };
    }
    const bindReceipt = await client.getTransactionReceipt({ hash: expected.bindTxHash as `0x${string}` });
    if (bindReceipt.status !== "success") return { ok: false, receiptHash, reason: "bind transaction failed" };
    const matched = bindReceipt.logs.some((log) => {
      if (getAddress(log.address) !== expected.float) return false;
      const decoded = decodeLog(x402PaymentBoundEvent, log);
      return Boolean(
        decoded &&
          decoded.args.requestHash?.toLowerCase() === expected.requestHash.toLowerCase() &&
          decoded.args.x402Hash?.toLowerCase() === expected.x402Hash!.toLowerCase() &&
          getAddress(decoded.args.provider) === getAddress(expected.provider) &&
          decoded.args.amountUSDC === expected.amountUSDC,
      );
    });
    return matched
      ? { ok: true, receiptHash, bindTxHash: expected.bindTxHash }
      : { ok: false, receiptHash, reason: "bind transaction missing matching X402PaymentBound event" };
  } catch (error) {
    return { ok: false, reason: sanitize(error) };
  }
}

function decodeLog(event: typeof x402PaymentBoundEvent, log: { data: `0x${string}`; topics: readonly `0x${string}`[] }) {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics as any });
  } catch {
    return null;
  }
}

async function handleScore(req: Req, res: Res) {
  const address = readParam(req, "address");
  if (!address || !isAddress(address)) {
    res.status(400).json({ error: "pass ?action=score&address=0x... (the agent address whose deterministic Float score you want)" });
    return;
  }

  const floatRaw = clean(process.env.SHADOW_FLOAT || process.env.VITE_SHADOW_FLOAT);
  if (!floatRaw || !isAddress(floatRaw)) {
    res.status(200).json({ configured: false, testnet: true, network: "arc-testnet" });
    return;
  }
  const rpcUrl = clean(process.env.ARC_RPC_URL || process.env.VITE_ARC_RPC_URL) || "https://rpc.testnet.arc.network";
  const agent = getAddress(address);

  try {
    const client = createPublicClient({ chain: arcTestnet(rpcUrl), transport: http(rpcUrl) });
    const line = await client.readContract({
      address: getAddress(floatRaw),
      abi: floatAbi,
      functionName: "lines",
      args: [agent],
    });
    const runs = filterRunsForFloat(await readLoopRuns(), floatRaw);
    const label = labelFor(agent);
    const evidence = scoreEvidence(agent, runs);
    const score = deterministicScore(label, evidence);
    const recommendedLimitUSDC = recommendedLimitForScore(score);
    const currentLine = serializeLine(line);

    res.status(200).json({
      configured: true,
      testnet: true,
      network: "arc-testnet",
      float: getAddress(floatRaw),
      agent,
      label,
      formulaVersion: "shadow-float-score-v0",
      formula: {
        base: {
          lab: 8500,
          invited: 7500,
          selfTest: 6500,
          demo: 5000,
        },
        adjustments: {
          paidBound: "+150 each, max 5",
          signedExternalPaidBound: "+350 each, max 3",
          repaid: "+400 each, max 3",
          blocked: "-250 each, max 5",
          denied: "-900 each, max 3",
          error: "-300 each, max 3",
        },
        lineBandsAtomicUSDC: [
          { scoreGte: 9000, limit: "1000000" },
          { scoreGte: 8000, limit: "50000" },
          { scoreGte: 7500, limit: "25000" },
          { scoreGte: 0, limit: "0" },
        ],
      },
      evidence,
      computed: {
        score,
        recommendedLimitUSDC,
        recommendedLimitFormatted: formatAtomicUSDC(recommendedLimitUSDC),
      },
      currentLine,
      supportCheck: {
        currentScore: currentLine.score,
        currentCreditLimitUSDC: currentLine.creditLimitUSDC,
        scoreSupported: currentLine.score <= score,
        limitSupported: BigInt(currentLine.creditLimitUSDC) <= BigInt(recommendedLimitUSDC),
      },
      note: "This v0 verifier is deterministic and public. The contract exposes the same formula through deterministicScore/recommendedLimitUSDC and can grant with grantFloatFromScore once reviewed evidence counts are submitted.",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ configured: true, degraded: true, error: sanitize(error) });
  }
}

async function readLoopRuns(): Promise<LoopRun[]> {
  const url = clean(process.env.KV_REST_API_URL);
  const token = clean(process.env.KV_REST_API_TOKEN);
  if (!url || !token) return [];
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/get/${encodeURIComponent("float:loop:runs")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const json = (await response.json()) as { result?: string | null };
    if (!json.result) return [];
    const parsed = JSON.parse(json.result) as unknown;
    return Array.isArray(parsed) ? (parsed as LoopRun[]).filter((r) => r && typeof r === "object") : [];
  } catch {
    return [];
  }
}

function labelFor(address: string): "lab" | "invited" | "self-test" | "demo" {
  const a = address.toLowerCase();
  const lab = parseSet(process.env.FLOAT_LAB_AGENTS, [DEFAULT_ALPHA]);
  const demo = parseSet(process.env.FLOAT_DEMO_AGENTS, [DEFAULT_BETA]);
  const selfTest = parseSet(process.env.FLOAT_SELF_TEST_AGENTS || process.env.VITE_FLOAT_SELF_TEST_AGENTS, [...DEFAULT_SELF_TEST_AGENTS]);
  if (lab.has(a)) return "lab";
  if (demo.has(a)) return "demo";
  if (selfTest.has(a)) return "self-test";
  return "invited";
}

function scoreEvidence(agent: string, runs: LoopRun[]) {
  const a = agent.toLowerCase();
  const matching = runs.filter((run) => runAgent(run) === a);
  const paidBound = matching.filter((run) => run.outcome === "PAID_BOUND").length;
  const signedExternalPaidBound = matching.filter(
    (run) => run.source === "external-signed" && run.outcome === "PAID_BOUND" && Boolean(run.signature && run.intent && run.x402Hash && run.bindTxHash),
  ).length;
  const repaid = matching.filter((run) => run.outcome === "REPAID").length;
  const blocked = matching.filter((run) => run.outcome === "PREMIUM_BLOCKED" || run.outcome === "GATE_BLOCKED").length;
  const denied = matching.filter((run) => run.outcome === "DENIED").length;
  const error = matching.filter((run) => run.outcome === "ERROR").length;
  return {
    runs: matching.length,
    paidBound,
    signedExternalPaidBound,
    repaid,
    blocked,
    denied,
    error,
    requestHashes: matching.map((run) => run.requestHash).filter(Boolean).slice(-8),
  };
}

function runAgent(run: LoopRun): string | null {
  const agent = run.agent || run.intent?.agent;
  return agent && isAddress(agent) ? getAddress(agent).toLowerCase() : null;
}

function filterRunsForFloat(runs: LoopRun[], floatRaw: string | undefined): LoopRun[] {
  if (!floatRaw || !isAddress(floatRaw)) return [];
  const current = getAddress(floatRaw);
  return runs.filter((run) => Boolean(run.float && isAddress(run.float) && getAddress(run.float) === current));
}

function deterministicScore(label: "lab" | "invited" | "self-test" | "demo", evidence: ReturnType<typeof scoreEvidence>) {
  const base = label === "lab" ? 8500 : label === "invited" ? 7500 : label === "self-test" ? 6500 : 5000;
  const raw =
    base +
    Math.min(evidence.paidBound, 5) * 150 +
    Math.min(evidence.signedExternalPaidBound, 3) * 350 +
    Math.min(evidence.repaid, 3) * 400 -
    Math.min(evidence.blocked, 5) * 250 -
    Math.min(evidence.denied, 3) * 900 -
    Math.min(evidence.error, 3) * 300;
  return Math.max(0, Math.min(10000, raw));
}

function recommendedLimitForScore(score: number): string {
  if (score >= 9000) return "1000000";
  if (score >= 8000) return "50000";
  if (score >= 7500) return "25000";
  return "0";
}

function serializeLine(line: readonly unknown[]) {
  return {
    wallet: line[0],
    score: Number(line[1]),
    creditLimitUSDC: (line[2] as bigint).toString(),
    availableCreditUSDC: (line[3] as bigint).toString(),
    activeDebtUSDC: (line[4] as bigint).toString(),
    status: STATUSES[Number(line[5])] || `STATUS_${line[5]}`,
    lastReview: Number(line[6]),
  };
}

function formatAtomicUSDC(value: string) {
  const atomic = BigInt(value);
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function parseSet(raw: string | undefined, fallback: string[]): Set<string> {
  const cleaned = clean(raw);
  const list = cleaned ? cleaned.split(",") : fallback;
  return new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function readHash(req: Req): `0x${string}` | undefined {
  const hash = readParam(req, "hash");
  return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (hash as `0x${string}`) : undefined;
}

function readParam(req: Req, name: string): string | undefined {
  const q = req.query?.[name];
  if (typeof q === "string") return q;
  if (Array.isArray(q) && q.length) return q[0];
  if (req.url) {
    try {
      return new URL(req.url, "http://local").searchParams.get(name) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function clean(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\\n/g, "").trim();
  return cleaned || undefined;
}

function sanitize(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error);
  msg = msg.replace(/https?:\/\/[^\s"']+/gi, "[rpc]");
  return (msg.split("\n")[0] || "").slice(0, 200).trim() || "standing unavailable";
}

function arcTestnet(rpcUrl: string) {
  return defineChain({
    id: ARC_CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
