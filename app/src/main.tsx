import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { createWalletClient, custom, keccak256, parseUnits, stringToBytes, type Address, type Hash, type Hex } from "viem";
import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
  getUserOperationGasPrice,
  type WebAuthnCredential,
} from "@circle-fin/modular-wallets-core";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { createPublicClient as createClient, encodeFunctionData, http } from "viem";
import {
  addresses,
  agentSignal,
  arcTestnet,
  computeEarnedReputation,
  erc20Abi,
  fetchLeptonState,
  fetchShadowState,
  formatAsset,
  formatUSDC,
  isConfigured,
  isLeptonConfigured,
  leptonAddresses,
  mandateRegistryAbi,
  pilotAttestorAbi,
  publicClient,
  routerAbi,
  shortAddress,
  txUrl,
  v4StyleArcAdapterAbi,
  type AgentSignal,
  type EarnedReputation,
  type IntentLog,
  type LeptonState,
  type PositionCloseLog,
  type ReceiptLog,
  type ShadowState,
  type SourceAgent,
} from "./chain";
import "./styles.css";

type PresetKey = "conservative" | "balanced" | "aggressive";

type Preset = {
  label: string;
  tagline: string;
  maxAmountPerIntent: string;
  dailyCap: string;
  maxRiskLevel: number;
  minBpsOut: number;
};

const PRESETS: Record<PresetKey, Preset> = {
  conservative: {
    label: "Conservative",
    tagline: "Strict slippage, low risk only, tight cap.",
    maxAmountPerIntent: "0.2",
    dailyCap: "1",
    maxRiskLevel: 1,
    minBpsOut: 10000,
  },
  balanced: {
    label: "Balanced",
    tagline: "Moderate slippage, mid risk, daily room to run.",
    maxAmountPerIntent: "0.5",
    dailyCap: "3",
    maxRiskLevel: 2,
    minBpsOut: 9500,
  },
  aggressive: {
    label: "Aggressive",
    tagline: "Loose slippage, take any risk, larger size.",
    maxAmountPerIntent: "1",
    dailyCap: "5",
    maxRiskLevel: 3,
    minBpsOut: 9000,
  },
};

const OBOL_SIGNER = "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3".toLowerCase();

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type ActionState = {
  label: string;
  tx?: `0x${string}`;
  error?: string;
};

type VerifyOutcome = {
  address: Address;
  status: "COPIED" | "BLOCKED";
  reason: string;
  usdcAmount: string;
  mirrorFee: string;
  assetOut: string;
};

type VerifyResponse = {
  ok: boolean;
  cached: boolean;
  retryAfter: number;
  tx: `0x${string}`;
  blockNumber: string;
  amountUSDC: string;
  liveQuote: string;
  minAmountOut: string;
  scaledMinA: string;
  scaledMinB: string;
  followerA: VerifyOutcome;
  followerB: VerifyOutcome;
  intentHash?: string;
  reasoning?: ReasoningPacket;
};

type ReasoningPacket = {
  sourceAgent: string;
  sourceName: string;
  intentHash: string;
  createdAt: number;
  amountUSDC: string;
  minAmountOut: string;
  liveQuote: string;
  reserveUSDC: string;
  reserveAsset: string;
  riskLevel: number;
  confidenceBps: number;
  decision: "publish" | "skip";
  rationale: string;
};

type ReasoningResponse = {
  configured: boolean;
  packet: ReasoningPacket | null;
  latestIntentHash: string | null;
  error?: string;
};

type PilotSlice = {
  sourceAddress: string;
  name: string;
  weightBps: number;
  preset: PresetKey;
  amountUSDC: string;
  reason: string;
};

type PilotPlan = {
  model: string;
  fellBack: boolean;
  fellBackReason?: string;
  headline: string;
  confidenceBps: number;
  rationale: string;
  watchSignals: string[];
  allocation: PilotSlice[];
  generatedAt: number;
  decisionHash: string;
};

type PilotRisk = "low" | "balanced" | "high";

type FloatLineState = {
  wallet: Address;
  score: number;
  creditLimitUSDC: string;
  availableCreditUSDC: string;
  activeDebtUSDC: string;
  status: string;
  lastReview: number;
  mandateId: string;
  day: number;
  spentTodayUSDC: string;
};

type FloatReceiptState = {
  receiptId: string;
  receiptHash: string;
  receiptType: string;
  agent: Address;
  provider: Address;
  endpointHash: string;
  amountUSDC: string;
  amountFormatted: string;
  providerAmountUSDC?: string;
  feeUSDC?: string;
  debtOpenedUSDC?: string;
  debtDeltaUSDC?: string;
  creditBeforeUSDC: string;
  creditAfterUSDC: string;
  debtBeforeUSDC: string;
  debtAfterUSDC: string;
  reason: string;
  mandateId: string;
  requestHash: string;
  prevChecksum: string;
  checksum: string;
  transactionHash: `0x${string}`;
  blockNumber: string;
  x402?: {
    receiptId: string;
    requestHash: string;
    x402Hash: `0x${string}`;
    provider: Address;
    amountUSDC: string;
    amountFormatted: string;
    facilitator: Address;
    bindingTxHash: `0x${string}`;
    blockNumber: string;
  };
};

type FloatSourceSummary = {
  cycles?: number;
  paidCount?: number;
  blockedCount?: number;
  deniedCount?: number;
  repaidCount?: number;
  lifecycleClosedCount?: number;
  skipCount?: number;
  errorCount?: number;
  fallbacks?: number;
  providerPaidUSDC?: string;
  debtOpenedUSDC?: string;
  blockedUSDC?: string;
  deniedUSDC?: string;
  repaidUSDC?: string;
};

type FloatLoopRun = {
  id?: string;
  source?: "agent-loop" | "external-signed" | "operator-assisted" | "external";
  action?: string;
  outcome?: string;
  at?: string;
  agent?: Address;
  facilitator?: Address;
  amountUSDC?: string;
  x402Hash?: `0x${string}`;
  bindTxHash?: `0x${string}`;
  repayTxHash?: `0x${string}`;
  txHash?: `0x${string}`;
  requestHash?: string;
  reason?: string;
  rationale?: string;
  intent?: {
    agent?: Address;
    provider?: Address;
    endpointHash?: string;
    amountUSDC?: string;
    nonce?: string;
    expiry?: string;
    reason?: string;
    float?: Address;
    chainId?: number;
  };
  model?: string;
  fellBack?: boolean;
};

type FloatStandingAgent = {
  agent: Address;
  label: "lab" | "invited" | "self-test" | "demo";
  score: number;
  status: string;
  creditLimitUSDC: string;
  availableCreditUSDC: string;
  activeDebtUSDC: string;
  lastReview: number;
};

type FloatStandingBoard = {
  generatedAt?: number;
  legend?: Record<string, string>;
  counts?: {
    lab?: number;
    invited?: number;
    "self-test"?: number;
    demo?: number;
  };
  agents?: FloatStandingAgent[];
};

type FloatState = {
  configured: boolean;
  testnet: true;
  network: "arc-testnet";
  float?: Address;
  usdc?: Address;
  alpha?: Address;
  beta?: Address;
  provider?: Address;
  receiptCount?: string;
  treasuryBalanceUSDC?: string;
  totalProviderPaidUSDC?: string;
  totalDebtOpenedUSDC?: string;
  totalBlockedUSDC?: string;
  totalDeniedUSDC?: string;
  totalRepaidUSDC?: string;
  totalFeesAccruedUSDC?: string;
  totalDefaultedUSDC?: string;
  totalAvailableCreditUSDC?: string;
  feeBps?: number;
  lastChecksum?: string;
  alphaLine?: FloatLineState;
  betaLine?: FloatLineState;
  providerMandate?: {
    endpointHash: string;
    maxPerRequestUSDC: string;
    dailyLimitUSDC: string;
    expiry: number;
    active: boolean;
  };
  sourceBreakdown?: {
    agentLoop?: FloatSourceSummary;
    demoAdmin?: FloatSourceSummary;
    externalSigned?: FloatSourceSummary;
    assisted?: FloatSourceSummary;
  };
  proofChecks?: Record<string, boolean | string>;
  proofPointers?: {
    x402BoundReceipt?: FloatReceiptState | null;
    providerPaidReceipt?: FloatReceiptState | null;
    debtReceipt?: FloatReceiptState | null;
    repaymentReceipt?: FloatReceiptState | null;
    overspendReceipt?: FloatReceiptState | null;
    denialReceipt?: FloatReceiptState | null;
    grantReceipt?: FloatReceiptState | null;
    latestExternalVerify?: { requestHash: string; verifyUrl: string } | null;
  };
  walletProof?: {
    agent?: Address;
    balanceSnapshot?: "current" | "historical";
    historicalBeforeBalanceAvailable?: boolean;
    note?: string;
    agentWalletUSDC?: string;
    requiredX402AmountUSDC?: string;
    walletShortfallUSDC?: string;
    floatAvailableCapacityUSDC?: string;
    facilitatorPaidUSDC?: string;
    debtAssignedUSDC?: string;
    requestHash?: string | null;
    x402Hash?: `0x${string}` | null;
    bindTxHash?: `0x${string}` | null;
  };
  standingBoard?: FloatStandingBoard;
  loopRuns?: FloatLoopRun[];
  receipts?: FloatReceiptState[];
  latestBlock?: string;
  fetchedAt?: number;
  missing?: string[];
  degraded?: boolean;
  error?: string;
};

type TreasuryCheck = {
  check: string;
  status: "PASS" | "FAIL";
  ok: boolean;
  detail: string;
};

type TreasuryState = {
  ok: boolean;
  checkedAt?: string;
  mode?: string;
  chainId?: number;
  operator?: Address;
  requestHash?: Hash;
  txs?: {
    createMandate?: Hash;
    allowedAllocation?: Hash;
    blockedAllocation?: Hash;
    x402Settlement?: Hash;
    floatBind?: Hash;
  };
  amounts?: {
    allowedAllocationUSDC?: string;
    blockedAttemptUSDC?: string;
    x402PaidUSDC?: string;
    floatFeeUSDC?: string;
  };
  checks?: TreasuryCheck[];
  error?: string;
};

const TREASURY_PROOF = {
  operator: "0x26bA923FbbB4404395E61f94Ca4b39823A1763c5" as Address,
  float: "0xF305647bA0ff7f1E2d4bE5f37F2EF9f930531057" as Address,
  mandateRegistry: "0xe3cf1a4d54f627f599255142cef4bf9b8c361a4c" as Address,
  mandateAttestor: "0x9b5afc6c442364d4397763917ebbc659d85ee86d" as Address,
  bondedEnforcer: "0x1825f447c0aa8e64dd2d290cdce85d82993d0e1e" as Address,
  morphoAdapter: "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5" as Address,
  vaultSink: "0x110f79c5617797b199d3d6e2abb855c34fbc5e58" as Address,
  amountAllocatedUSDC: "100000",
  amountBlockedUSDC: "300000",
  amountX402USDC: "1000",
  feeUSDC: "10",
  txs: {
    createMandate: "0x5f511e1bf49fadf998b7a94f5e34598510e9479fab15f5a5fb713636c158a411" as Hash,
    allocation: "0x9836e74ee95907847fac464f3a65554cf314adab9efe7141f4644022b3e09c17" as Hash,
    blocked: "0x7d3dddd89dc50ea5b410564c7f1134ce1350fd3687e8cefec74192d9e9b4bd23" as Hash,
    x402Settlement: "0x516d95ed55d61663c491f2cccb45d1d16d83967bdcc6fc66899d05426fea80ab" as Hash,
    floatBind: "0x7fe14e70081f682017d5804250f9db6b0dc7416fe1eb100f7135c6e34007d103" as Hash,
  },
  hashes: {
    floatRequest: "0xbcb5bbbcdd270198a5c4258d34ac1c0625c8b807f8fe8dde8912ac12feda910b",
    allowedAction: "0x7b0f276c844b63db15c82995ba154ffb136dab19aa7481a853ce95eedff16205",
    blockedAction: "0xe93a7933e6ce39a04dcb0bf8561c838930f8333b6d4eeb4f60db4d2a366b7523",
  },
};

function App() {
  const [state, setState] = useState<ShadowState | null>(null);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<Address>();
  const [action, setAction] = useState<ActionState>({ label: "ready" });
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<Address | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PresetKey>("balanced");
  const [depositAmount, setDepositAmount] = useState("0.5");
  const [userBalance, setUserBalance] = useState<bigint>(0n);
  const [userFollows, setUserFollows] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [managing, setManaging] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningResponse | null>(null);
  const [closingIntentId, setClosingIntentId] = useState<bigint | null>(null);
  const [pilotAmount, setPilotAmount] = useState("1");
  const [pilotRisk, setPilotRisk] = useState<PilotRisk>("balanced");
  const [pilotPlan, setPilotPlan] = useState<PilotPlan | null>(null);
  const [pilotLoading, setPilotLoading] = useState(false);
  const [pilotExecuting, setPilotExecuting] = useState(false);
  const [pilotError, setPilotError] = useState<string | null>(null);
  const [leptonState, setLeptonState] = useState<LeptonState | null>(null);
  const [leptonLoading, setLeptonLoading] = useState(false);
  const [leptonError, setLeptonError] = useState<string | null>(null);
  const [floatState, setFloatState] = useState<FloatState | null>(null);
  const [floatLoading, setFloatLoading] = useState(false);
  const [floatError, setFloatError] = useState<string | null>(null);
  const [treasuryState, setTreasuryState] = useState<TreasuryState | null>(null);
  const [treasuryLoading, setTreasuryLoading] = useState(false);
  const [treasuryError, setTreasuryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/reasoning");
        const data = (await response.json()) as ReasoningResponse;
        if (cancelled) return;
        setReasoning(data);
      } catch {
        // best-effort; transient errors are ignored
      }
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      setState(await fetchShadowState());
    } catch (error) {
      setAction({ label: "read failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshLepton() {
    setLeptonLoading(true);
    try {
      setLeptonState(await fetchLeptonState());
      setLeptonError(null);
    } catch (error) {
      setLeptonError(error instanceof Error ? error.message : String(error));
    } finally {
      setLeptonLoading(false);
    }
  }

  useEffect(() => {
    refreshLepton();
    const interval = setInterval(refreshLepton, 20_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshFloat() {
    setFloatLoading(true);
    try {
      const response = await fetch("/api/float");
      const data = (await response.json()) as FloatState;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Float read failed with ${response.status}`);
      }
      setFloatState(data);
      setFloatError(null);
    } catch (error) {
      setFloatError(error instanceof Error ? error.message : String(error));
    } finally {
      setFloatLoading(false);
    }
  }

  useEffect(() => {
    refreshFloat();
    const interval = setInterval(refreshFloat, 20_000);
    return () => clearInterval(interval);
  }, []);

  async function refreshTreasury() {
    setTreasuryLoading(true);
    try {
      const response = await fetch("/api/treasury");
      const data = (await response.json()) as TreasuryState;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Treasury proof read failed with ${response.status}`);
      }
      setTreasuryState(data);
      setTreasuryError(null);
    } catch (error) {
      setTreasuryError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreasuryLoading(false);
    }
  }

  useEffect(() => {
    refreshTreasury();
    const interval = setInterval(refreshTreasury, 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (state?.sources?.length && !selectedSource) {
      setSelectedSource(state.sources[0].address);
    }
  }, [state, selectedSource]);

  useEffect(() => {
    if (!account || !isConfigured || !state?.sources?.length) {
      setUserBalance(0n);
      setUserFollows(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [balance, ...follows] = await Promise.all([
          publicClient.readContract({
            address: addresses.router!,
            abi: routerAbi,
            functionName: "followerBalanceUSDC",
            args: [account],
          }),
          ...state.sources.map((source) =>
            publicClient.readContract({
              address: addresses.router!,
              abi: routerAbi,
              functionName: "getPolicy",
              args: [account, source.address],
            }),
          ),
        ]);
        if (cancelled) return;
        setUserBalance(balance as bigint);
        const followedSet = new Set<string>();
        state.sources.forEach((source, index) => {
          const policy = follows[index] as readonly [bigint, bigint, Address, number, number, bigint, bigint, boolean];
          if (policy[7]) followedSet.add(source.address.toLowerCase());
        });
        setUserFollows(followedSet);
      } catch {
        // best-effort read; ignore transient RPC errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, state]);

  const copiedReceipts = useMemo(() => state?.receipts.filter((receipt) => receipt.status === "copied") || [], [state]);
  const blockedReceipts = useMemo(() => state?.receipts.filter((receipt) => receipt.status === "blocked") || [], [state]);
  const sourceNameByAddress = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of state?.sources || []) {
      map.set(source.address.toLowerCase(), source.name);
    }
    return map;
  }, [state]);
  const feedReceipts = useMemo(() => {
    const all = state?.receipts || [];
    return all
      .slice()
      .sort((a, b) => Number(b.blockNumber - a.blockNumber))
      .slice(0, 12);
  }, [state]);
  const spotlight = useMemo(() => {
    if (!state) return null;
    const intents = [...state.intents].sort((a, b) => Number(b.blockNumber - a.blockNumber));
    for (const intent of intents) {
      const matches = state.receipts.filter((r) => r.intentId === intent.intentId);
      const copied = matches.find((r) => r.status === "copied");
      const blocked = matches.find((r) => r.status === "blocked");
      if (copied && blocked) return { intent, copied, blocked };
    }
    return null;
  }, [state]);

  async function runVerify() {
    setVerifying(true);
    setVerifyError(null);
    try {
      const demoCode = ((import.meta as any).env?.VITE_SHADOW_DEMO_CODE as string | undefined) || "";
      const response = await fetch("/api/verify-slippage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shadow-demo-code": demoCode },
        body: JSON.stringify({ demoCode }),
      });
      const data = (await response.json()) as VerifyResponse & { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `request failed with ${response.status}`);
      }
      setVerifyResult(data);
      if (data.reasoning) {
        setReasoning({ configured: true, packet: data.reasoning, latestIntentHash: data.reasoning.intentHash });
      }
      refresh();
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setVerifying(false);
    }
  }

  async function connectWallet() {
    if (!window.ethereum) {
      setAction({ label: "wallet missing", error: "Install a browser wallet to write transactions." });
      return;
    }
    try {
      setAction({ label: "connecting wallet" });
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      setAccount(accounts[0]);
      await switchToArc();
      setAction({ label: "wallet connected on Arc Testnet" });
    } catch (error) {
      setAction({ label: "wallet connect failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function followWithPreset() {
    if (!isConfigured || !addresses.router || !addresses.usdc || !addresses.arceth) {
      setAction({ label: "follow blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "follow blocked", error: "Install a browser wallet to follow." });
      return;
    }
    if (!selectedSource) {
      setAction({ label: "follow blocked", error: "Pick a source agent." });
      return;
    }
    let parsedDeposit: bigint;
    try {
      parsedDeposit = parseUnits(depositAmount || "0", 6);
    } catch {
      setAction({ label: "follow blocked", error: "Enter a valid USDC amount." });
      return;
    }
    if (parsedDeposit < 0n) {
      setAction({ label: "follow blocked", error: "Deposit must be non-negative." });
      return;
    }
    const preset = PRESETS[selectedPreset];
    const maxAmount = parseUnits(preset.maxAmountPerIntent, 6);
    const dailyCap = parseUnits(preset.dailyCap, 6);

    setFollowing(true);
    setAction({ label: "follow flow starting" });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({
        account: user,
        chain: arcTestnet,
        transport: custom(window.ethereum),
      });

      if (parsedDeposit > 0n) {
        setAction({ label: `approve ${depositAmount} USDC` });
        const approveTx = await wallet.writeContract({
          account: user,
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.router, parsedDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });

        setAction({ label: `deposit ${depositAmount} USDC`, tx: approveTx });
        const depositTx = await wallet.writeContract({
          account: user,
          address: addresses.router,
          abi: routerAbi,
          functionName: "depositUSDC",
          args: [parsedDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: depositTx });
        setAction({ label: "deposit confirmed", tx: depositTx });
      }

      setAction({ label: `follow ${preset.label.toLowerCase()}` });
      const followTx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource,
          maxAmount,
          dailyCap,
          addresses.arceth,
          preset.maxRiskLevel,
          preset.minBpsOut,
        ],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: followTx });
      setAction({ label: "follow confirmed", tx: followTx });
      await refresh();
    } catch (error) {
      setAction({
        label: "follow failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFollowing(false);
    }
  }

  async function runPilot() {
    if (!state) {
      setPilotError("State is still loading; try again in a moment.");
      return;
    }
    if (state.sources.length === 0) {
      setPilotError("No source agents registered yet.");
      return;
    }
    const amt = Number(pilotAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setPilotError("Enter a positive USDC amount.");
      return;
    }
    setPilotLoading(true);
    setPilotError(null);
    try {
      const reputation = computeEarnedReputation(state);
      const sourceMap = new Map(reputation.map((r) => [r.source.address.toLowerCase(), r]));
      // Make sure every registered source is sent, even if no reputation yet.
      const payloadSources = state.sources.map((src) => {
        const r = sourceMap.get(src.address.toLowerCase());
        return {
          address: src.address,
          name: src.name,
          intentsPublished: r?.intentsPublished || 0,
          copyCount: r?.copyCount || 0,
          blockCount: r?.blockCount || 0,
          copyRateBps: r?.copyRateBps || 0,
          routedUSDC: formatUSDC(r?.routedUSDC || 0n),
          mirrorFeesUSDC: formatUSDC(r?.mirrorFeesUSDC || 0n),
          closedCount: r?.closedCount || 0,
          realizedPnlAvgBps: r?.realizedPnlAvgBps ?? null,
        };
      });
      const response = await fetch("/api/pilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUSDC: pilotAmount, risk: pilotRisk, sources: payloadSources }),
      });
      const data = (await response.json()) as PilotPlan & { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `pilot request failed with ${response.status}`);
      }
      setPilotPlan(data);
    } catch (err) {
      setPilotError(err instanceof Error ? err.message : String(err));
    } finally {
      setPilotLoading(false);
    }
  }

  async function executePilot() {
    if (!pilotPlan) return;
    if (!isConfigured || !addresses.router || !addresses.usdc || !addresses.arceth) {
      setAction({ label: "pilot blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "pilot blocked", error: "Install a browser wallet." });
      return;
    }
    setPilotExecuting(true);
    setAction({ label: "pilot starting" });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({
        account: user,
        chain: arcTestnet,
        transport: custom(window.ethereum),
      });
      const totalDeposit = pilotPlan.allocation.reduce(
        (sum, slice) => sum + parseUnits(slice.amountUSDC || "0", 6),
        0n,
      );

      if (addresses.pilotAttestor) {
        setAction({ label: "anchor decision onchain" });
        const decisionHashBytes32 = normalizeBytes32(pilotPlan.decisionHash);
        const modelHash = keccak256(stringToBytes(pilotPlan.model));
        const attestTx = await wallet.writeContract({
          account: user,
          address: addresses.pilotAttestor,
          abi: pilotAttestorAbi,
          functionName: "attest",
          args: [
            decisionHashBytes32,
            totalDeposit,
            pilotPlan.allocation.length,
            pilotPlan.confidenceBps,
            modelHash,
          ],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: attestTx });
        setAction({ label: "decision anchored", tx: attestTx });
      }
      if (totalDeposit > 0n) {
        setAction({ label: `approve ${formatUSDC(totalDeposit)} USDC` });
        const approveTx = await wallet.writeContract({
          account: user,
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.router, totalDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        setAction({ label: `deposit ${formatUSDC(totalDeposit)} USDC`, tx: approveTx });
        const depositTx = await wallet.writeContract({
          account: user,
          address: addresses.router,
          abi: routerAbi,
          functionName: "depositUSDC",
          args: [totalDeposit],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: depositTx });
        setAction({ label: "deposit confirmed", tx: depositTx });
      }
      for (let i = 0; i < pilotPlan.allocation.length; i++) {
        const slice = pilotPlan.allocation[i];
        const preset = PRESETS[slice.preset];
        setAction({
          label: `follow ${slice.name} ${preset.label.toLowerCase()} (${i + 1}/${pilotPlan.allocation.length})`,
        });
        const followTx = await wallet.writeContract({
          account: user,
          address: addresses.router,
          abi: routerAbi,
          functionName: "followSource",
          args: [
            slice.sourceAddress as Address,
            parseUnits(preset.maxAmountPerIntent, 6),
            parseUnits(preset.dailyCap, 6),
            addresses.arceth,
            preset.maxRiskLevel,
            preset.minBpsOut,
          ],
          chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash: followTx });
        setAction({ label: `${slice.name} followed`, tx: followTx });
      }
      setAction({ label: "pilot plan executed" });
      await refresh();
    } catch (err) {
      setAction({ label: "pilot failed", error: err instanceof Error ? err.message : String(err) });
    } finally {
      setPilotExecuting(false);
    }
  }

  async function withdraw() {
    if (!isConfigured || !addresses.router) {
      setAction({ label: "withdraw blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "withdraw blocked", error: "Install a browser wallet." });
      return;
    }
    let parsed: bigint;
    try {
      parsed = parseUnits(withdrawAmount || "0", 6);
    } catch {
      setAction({ label: "withdraw blocked", error: "Enter a valid USDC amount." });
      return;
    }
    if (parsed <= 0n) {
      setAction({ label: "withdraw blocked", error: "Amount must be positive." });
      return;
    }
    if (parsed > userBalance) {
      setAction({ label: "withdraw blocked", error: "Amount exceeds router balance." });
      return;
    }
    setManaging(true);
    setAction({ label: `withdraw ${withdrawAmount} USDC` });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({ account: user, chain: arcTestnet, transport: custom(window.ethereum) });
      const tx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "withdrawUSDC",
        args: [parsed],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAction({ label: "withdraw confirmed", tx });
      setWithdrawAmount("");
      await refresh();
    } catch (error) {
      setAction({ label: "withdraw failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setManaging(false);
    }
  }

  async function unfollow(source: Address) {
    if (!isConfigured || !addresses.router) {
      setAction({ label: "unfollow blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "unfollow blocked", error: "Install a browser wallet." });
      return;
    }
    setManaging(true);
    setAction({ label: `unfollow ${shortAddress(source)}` });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({ account: user, chain: arcTestnet, transport: custom(window.ethereum) });
      const tx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "unfollowSource",
        args: [source],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAction({ label: "unfollow confirmed", tx });
      await refresh();
    } catch (error) {
      setAction({ label: "unfollow failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setManaging(false);
    }
  }

  async function closePosition(intentId: bigint) {
    if (!isConfigured || !addresses.router) {
      setAction({ label: "close blocked", error: "Configure addresses first." });
      return;
    }
    if (!window.ethereum) {
      setAction({ label: "close blocked", error: "Install a browser wallet." });
      return;
    }
    setClosingIntentId(intentId);
    setAction({ label: `closing intent ${intentId.toString()}` });
    try {
      const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      await switchToArc();
      setAccount(user);
      const wallet = createWalletClient({ account: user, chain: arcTestnet, transport: custom(window.ethereum) });
      const tx = await wallet.writeContract({
        account: user,
        address: addresses.router,
        abi: routerAbi,
        functionName: "closePosition",
        args: [intentId],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAction({ label: "position closed", tx });
      await refresh();
    } catch (error) {
      setAction({ label: "close failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setClosingIntentId(null);
    }
  }

  const navigate = useNavigate();

  const followFromAgents = (addr: Address) => {
    setSelectedSource(addr);
    navigate("/follow");
  };

  const heroExternalSignedCount = floatState?.sourceBreakdown?.externalSigned?.cycles;
  const heroExternalSignedLabel =
    heroExternalSignedCount !== undefined
      ? `${heroExternalSignedCount.toLocaleString()} signed external draws`
      : "external signed proof live";

  const homePage = (
    <>
      <section className="hero" id="top">
        <div className="heroBackdrop" aria-hidden="true">
          <span className="heroBackdropGrid" />
          <span className="heroBackdropGlow heroBackdropGlow--graphite" />
          <span className="heroBackdropGlow heroBackdropGlow--signal" />
          <span className="heroBackdropTrail" />
        </div>
        <div className="heroGrid">
          <div className="heroCopy">
            <div className="heroBadge">
              <span className="heroBadgeDot" />
              Shadow Float · live on Arc testnet
            </div>
            <h1>Agents buy x402 services before their wallet is funded.</h1>
            <p className="lede">
              Shadow Float fronts approved Arc USDC payments to x402 providers, opens fee-inclusive debt, restores capacity
              on repayment, and blocks unsafe spends before treasury funds move. Treasury/M1 is the supporting mandate
              extension, not the primary Float proof path.
            </p>
            <div className="heroActions">
              <Link to="/float" className="heroCtaPrimary">
                Open Shadow Float
                <span className="heroCtaArrow">→</span>
              </Link>
              <Link className="heroCtaSecondary" to="/treasury">
                View Treasury extension
              </Link>
            </div>
            <ul className="heroTrust" aria-label="Built on">
              <li><span className="heroTrustDot heroTrustDot--signal" />Arc testnet</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />Arc USDC</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />x402 bound onchain</li>
              <li>
                <span className="heroTrustDot heroTrustDot--signal" />
                {heroExternalSignedLabel}
              </li>
            </ul>
          </div>
          <HeroDiagram />
        </div>
        <HeroMetrics state={floatState} />
      </section>

      <HomeProofOverview state={floatState} loading={floatLoading} error={floatError} />

      <section className="pageNext" aria-label="Shadow Float verification paths">
        <Link to="/float" className="pageNextCard pageNextCardPrimary">
          <span className="pageNextEyebrow">product</span>
          <span className="pageNextTitle">Walk the signed x402 spend, debt, repay, block, and denial loop</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/treasury" className="pageNextCard">
          <span className="pageNextEyebrow">mandate extension</span>
          <span className="pageNextTitle">See the M1 adapter allocate when allowed and move nothing when blocked</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/proof" className="pageNextCard">
          <span className="pageNextEyebrow">verify</span>
          <span className="pageNextTitle">Check receipts, reserves, proof links, and external signed draws</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/roadmap" className="pageNextCard">
          <span className="pageNextEyebrow">roadmap</span>
          <span className="pageNextTitle">Permissionless underwriting, Gateway-batched x402, and production-grade M1 custody</span>
          <span className="pageNextArrow">→</span>
        </Link>
      </section>
    </>
  );

  const agentsPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">agents · behavior history</p>
        <h1 className="pageTitle">Agent behavior is the reputation layer.</h1>
        <p className="pageLede">
          Shadow 2.0 does not trust a profile badge. It reads receipts: who got copied, who got blocked, who repaid, and
          which behavior earns an agent a float line or a stricter mandate.
        </p>
      </section>
      <EarnedReputationPanel
        rows={state ? computeEarnedReputation(state) : []}
        onFollow={followFromAgents}
      />
      <HowItWorks />
    </>
  );

  const followPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">follow · adapter one</p>
        <h1 className="pageTitle">The mirror adapter proves policy enforcement.</h1>
        <p className="pageLede">
          This is Shadow&apos;s first working adapter: a follower sets size, slippage, daily cap, and risk limits; the router
          either executes or records the refusal. Float and protocol mandates reuse the same enforcement discipline.
        </p>
      </section>
      <FollowFlow
        sources={state?.sources || []}
        selectedSource={selectedSource}
        onSelectSource={setSelectedSource}
        selectedPreset={selectedPreset}
        onSelectPreset={setSelectedPreset}
        depositAmount={depositAmount}
        onDepositChange={setDepositAmount}
        onFollow={followWithPreset}
        following={following}
        action={action}
        account={account}
        userBalance={userBalance}
        userFollows={userFollows}
        connectWallet={connectWallet}
      />
      {account && userFollows.size > 0 && state && (
        <PilotMonitor
          state={state}
          account={account}
          userFollows={userFollows}
          plan={pilotPlan}
          onRerun={runPilot}
          loading={pilotLoading}
        />
      )}
      {account && (userBalance > 0n || userFollows.size > 0) && (
        <ManagePanel
          sources={state?.sources || []}
          userBalance={userBalance}
          userFollows={userFollows}
          withdrawAmount={withdrawAmount}
          onWithdrawChange={setWithdrawAmount}
          onWithdraw={withdraw}
          onUnfollow={unfollow}
          managing={managing}
        />
      )}
      <PilotCard
        amount={pilotAmount}
        onAmountChange={setPilotAmount}
        risk={pilotRisk}
        onRiskChange={setPilotRisk}
        plan={pilotPlan}
        loading={pilotLoading}
        error={pilotError}
        executing={pilotExecuting}
        onRun={runPilot}
        onExecute={executePilot}
        sourcesCount={state?.sources.length || 0}
      />
      <CircleStackPanel />
    </>
  );

  const receiptsPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">receipts · Shadow proof rail</p>
        <h1 className="pageTitle">One proof rail for float, mandates, and mirror actions.</h1>
        <p className="pageLede">
          Read this page as the audit layer. Allowed spends, x402 hashes, repayments, blocked overreach, copied intents,
          refused mirrors, and mandate proofs all point back to Arc testnet events.
        </p>
      </section>
      <FloatPanel state={floatState} loading={floatLoading} error={floatError} compact />
      {state && (
        <LiveFeed
          receipts={feedReceipts}
          intents={state.intents}
          closes={state.positionCloses}
          sourceNameByAddress={sourceNameByAddress}
          reasoning={reasoning}
          latestBlock={state.latestBlock}
          fetchedAt={state.fetchedAt}
          loading={loading}
          totalReceipts={state.recentWindow.receipts}
          account={account}
          closingIntentId={closingIntentId}
          onClosePosition={closePosition}
        />
      )}

      <LatestReasoningPanel data={reasoning} />

      <section className="grid">
        <Stat label="registered agents" value={String(state?.sources.length || 0)} />
        <Stat label="recent receipts" value={String(state?.recentWindow.receipts || 0)} />
        <Stat label="recent USDC mirrored" value={formatUSDC(totalMirrored(copiedReceipts))} />
        <Stat label="recent blocked copies" value={String(blockedReceipts.length)} />
        <Stat label="source fees paid" value={formatUSDC(totalKickbacks(state))} />
        <Stat label="1 USDC quote" value={`${formatAsset(state?.quoteForOneUSDC || 0n)} ARCETH`} />
      </section>

      <section className="panel">
        <Header eyebrow="controlled AMM" title="Real onchain exchange path, intentionally small" />
        <div className="reserveGrid">
          <Stat label="USDC reserve" value={formatUSDC(state?.reserves.usdc || 0n)} />
          <Stat label="ARCETH reserve" value={formatAsset(state?.reserves.asset || 0n)} />
          <Stat label="next intent id" value={String(state?.nextIntentId || 1n)} />
        </div>
      </section>

      <BuilderFeesBanner state={state} />

      <LeptonM1Panel state={leptonState} loading={leptonLoading} error={leptonError} compact />

      <TechnicalPrimitive state={state} />
    </>
  );

  const leptonPage = (
    <>
      <LeptonM1Panel state={leptonState} loading={leptonLoading} error={leptonError} />
      <CircleStackPanel />
    </>
  );

  const treasuryPage = (
    <>
      <TreasuryHero floatState={floatState} treasuryState={treasuryState} />
      <TreasuryEvidenceStrip treasuryState={treasuryState} />
      <TreasuryRailSplit floatState={floatState} leptonState={leptonState} />
      <TreasuryProofPanel floatState={floatState} leptonState={leptonState} treasuryState={treasuryState} />
      <TreasuryReceiptStructurePanel />
      <TreasuryLiveVerifierPanel state={treasuryState} loading={treasuryLoading} error={treasuryError} />
      <TreasuryJudgePath />
      <TreasuryValidationPanel floatState={floatState} />
      <TreasuryHardeningPanel />
    </>
  );

  const floatPage = (
    <>
      <FloatPanel state={floatState} loading={floatLoading} error={floatError} />
      <CircleStackPanel />
      <FloatEconomicsPanel />
    </>
  );

  const proofPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">proof · live verification</p>
        <h1 className="pageTitle">Verify the Float loop without trusting the screenshot.</h1>
        <p className="pageLede">
          Start with the external signed spends, then check the contract, reserve, x402 bind, debt, repayment, overspend
          block, and denial. Every link below points to live data or Arc testnet transactions.
        </p>
      </section>
      <FloatExternalSignedPanel state={floatState} />
      <FloatProofChecksPanel state={floatState} />
      <FloatJudgePath state={floatState} />
      <section className="productPageGrid" aria-label="Verifier entry points">
        <a className="productInfoCard primary" href="/api/float" target="_blank" rel="noreferrer">
          <span>live API</span>
          <strong>/api/float</strong>
          <p>Receipts, source breakdowns, proof checks, treasury reserve, and standing board.</p>
        </a>
        <a className="productInfoCard" href="https://github.com/dolepee/shadow" target="_blank" rel="noreferrer">
          <span>repo verifier</span>
          <strong>npm run float:verify-live</strong>
          <p>Read-only command that checks the live Float deployment with no private keys.</p>
        </a>
        <a className="productInfoCard" href="https://github.com/dolepee/shadow" target="_blank" rel="noreferrer">
          <span>treasury verifier</span>
          <strong>npm run treasury:verify-live</strong>
          <p>Read-only command that checks the combined Float payment and M1 allocation proof.</p>
        </a>
        {floatState?.float && (
          <a className="productInfoCard" href={`https://testnet.arcscan.app/address/${floatState.float}`} target="_blank" rel="noreferrer">
            <span>contract</span>
            <strong>{shortAddress(floatState.float)}</strong>
            <p>ShadowFloat on Arc testnet, including receipt and x402 bind events.</p>
          </a>
        )}
      </section>
    </>
  );

  const buildersPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">builders · agent access</p>
        <h1 className="pageTitle">Give your agent a spending line without hot-funding it first.</h1>
        <p className="pageLede">
          Shadow Float is for buyer agents that need paid data, compute, or API calls before their wallet is topped up. The
          builder signs intent; Shadow fronts x402; the receipt proves what happened.
        </p>
      </section>
      <section className="builderFlowGrid" aria-label="Builder integration flow">
        <article className="builderFlowCard">
          <span>1</span>
          <strong>Request a line</strong>
          <p>Share the Arc testnet wallet your agent actually controls. Shadow registers a bounded line for that signer.</p>
        </article>
        <article className="builderFlowCard">
          <span>2</span>
          <strong>Sign an intent</strong>
          <p>Sign typed data locally. The key stays on your machine; only the intent JSON and signature are shared.</p>
        </article>
        <article className="builderFlowCard">
          <span>3</span>
          <strong>Shadow fronts x402</strong>
          <p>Shadow verifies the signature, pays the x402 provider, and binds the settlement hash onchain.</p>
        </article>
        <article className="builderFlowCard">
          <span>4</span>
          <strong>Repay when ready</strong>
          <p>Your agent can repay from its own wallet to close the external borrow, spend, and repay loop.</p>
        </article>
      </section>
      <section className="builderReferenceGrid" aria-label="Builder references">
        <article className="builderReferenceCard">
          <span>standing API</span>
          <code>/api/float-tools?action=agent&amp;address=0x...</code>
          <p>Read line limit, available capacity, active debt, status, and behavior score.</p>
        </article>
        <article className="builderReferenceCard">
          <span>intent verifier</span>
          <code>/api/float-tools?action=verify&amp;hash=0x...</code>
          <p>Verify signer, request hash, onchain receipt, and matching x402 bind event.</p>
        </article>
        <article className="builderReferenceCard">
          <span>local scripts</span>
          <code>float-builder-sign.mjs · float-builder-repay.mjs</code>
          <p>Reference helpers for local signing and repayment. Builders can also construct calls with their own signer.</p>
        </article>
      </section>
      <FloatStandingBoardPanel board={floatState?.standingBoard} alpha={floatState?.alpha} beta={floatState?.beta} compact={false} />
    </>
  );

  const roadmapPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">roadmap · mainnet path</p>
        <h1 className="pageTitle">From testnet mechanics to an agent spending network.</h1>
        <p className="pageLede">
          The live product proves treasury fronting, x402 settlement, debt, repayment, blocks, and signed external use. The
          roadmap is about opening the market without pretending those pieces are already complete.
        </p>
      </section>
      <FloatEconomicsPanel />
      <CircleStackPanel />
      <section className="roadmapGrid" aria-label="Shadow Float roadmap">
        <article className="roadmapCard">
          <span>interop</span>
          <strong>Gateway-batched x402</strong>
          <p>Bridge the current EIP-3009 path into the Gateway-batched dialect Obol and Archer surfaced.</p>
        </article>
        <article className="roadmapCard">
          <span>market</span>
          <strong>Independent providers</strong>
          <p>Let Float-funded buyer agents purchase from third-party x402 sellers, not only Shadow&apos;s provider.</p>
        </article>
        <article className="roadmapCard">
          <span>risk</span>
          <strong>Permissionless scoring</strong>
          <p>Move from deterministic v0 over operator-reviewed evidence to an indexed, permissionless score path.</p>
        </article>
        <article className="roadmapCard">
          <span>capital</span>
          <strong>Treasury reserve model</strong>
          <p>Give operators and LPs a reserve, fee, and default framework for funding agent spending lines.</p>
        </article>
      </section>
    </>
  );

  const archivePage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">archive · prior Shadow</p>
        <h1 className="pageTitle">The earlier receipt-and-policy surfaces remain live.</h1>
        <p className="pageLede">
          These routes are historical proof of the primitive that Float builds on: source-agent behavior, mirror receipts,
          and mandate enforcement. They are not the current Lepton product path.
        </p>
      </section>
      <Shadow2ProofStrip
        floatState={floatState}
        leptonState={leptonState}
        copiedCount={copiedReceipts.length}
        blockedCount={blockedReceipts.length}
      />
      <section className="pageNext" aria-label="Prior Shadow routes">
        <Link to="/agents" className="pageNextCard">
          <span className="pageNextEyebrow">agents</span>
          <span className="pageNextTitle">Source-agent history that feeds reputation</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/follow" className="pageNextCard">
          <span className="pageNextEyebrow">follow</span>
          <span className="pageNextTitle">The original mirror adapter and policy controls</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/lepton" className="pageNextCard">
          <span className="pageNextEyebrow">mandates</span>
          <span className="pageNextTitle">Protocol-facing mandate enforcement</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/receipts" className="pageNextCard">
          <span className="pageNextEyebrow">receipts</span>
          <span className="pageNextTitle">The full historical receipt rail</span>
          <span className="pageNextArrow">→</span>
        </Link>
      </section>
    </>
  );

  return (
    <main className="shell">
      <nav className="nav">
        <Link className="brand" to="/" aria-label="Shadow">
          <ShadowMark />
          <span>Shadow</span>
        </Link>
        <div className="navLinks">
          <NavLink end to="/" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Home
          </NavLink>
          <NavLink to="/treasury" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Treasury
          </NavLink>
          <NavLink to="/float" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Float
          </NavLink>
          <NavLink to="/proof" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Proof
          </NavLink>
          <NavLink to="/builders" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Builders
          </NavLink>
          <NavLink to="/roadmap" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Roadmap
          </NavLink>
        </div>
        <div className="navActions">
          <button
            className={account ? "navWallet connected" : "navWallet"}
            onClick={connectWallet}
            type="button"
            aria-label={account ? `Connected wallet ${account}` : "Connect wallet"}
          >
            <span className="navWalletDot" />
            {account ? shortAddress(account) : "Wallet"}
          </button>
          <Link to="/treasury" className="navCta">
            Open Treasury
          </Link>
        </div>
      </nav>

      <RouteScroll />

      <Routes>
        <Route path="/" element={homePage} />
        <Route path="/agents" element={agentsPage} />
        <Route path="/follow" element={followPage} />
        <Route path="/receipts" element={receiptsPage} />
        <Route path="/lepton" element={leptonPage} />
        <Route path="/treasury" element={treasuryPage} />
        <Route path="/float" element={floatPage} />
        <Route path="/proof" element={proofPage} />
        <Route path="/builders" element={buildersPage} />
        <Route path="/roadmap" element={roadmapPage} />
        <Route path="/archive" element={archivePage} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <SiteFooter />
    </main>
  );
}

function RouteScroll() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const id = hash.slice(1);
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        else window.scrollTo({ top: 0, behavior: "auto" });
      });
    } else {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [pathname, hash]);
  return null;
}

function TreasuryHero({ floatState, treasuryState }: {
  floatState: FloatState | null;
  treasuryState: TreasuryState | null;
}) {
  const externalSigned = floatState?.sourceBreakdown?.externalSigned;
  const checks = floatState?.proofChecks || {};
  const greenChecks = Object.values(checks).filter((value) => value === true).length;
  const totalChecks = Object.values(checks).filter((value) => typeof value === "boolean").length;
  const externalDrawsLabel = floatState ? `${externalSigned?.cycles ?? 0}` : "syncing";
  const railStats = [
    { label: "x402 paid", value: `${formatFloatUSDC(TREASURY_PROOF.amountX402USDC)} USDC`, tone: "allow" },
    { label: "vault allocated", value: `${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`, tone: "allow" },
    { label: "blocked first", value: `${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`, tone: "block" },
    { label: "external Float draws", value: externalDrawsLabel, tone: "neutral" },
  ];
  const verifierLabel = treasuryState
    ? treasuryState.ok
      ? `${treasuryState.checks?.filter((check) => check.ok).length || 0}/${treasuryState.checks?.length || 0} Treasury checks`
      : "Treasury verifier red"
    : totalChecks
      ? `${greenChecks}/${totalChecks} Float checks`
      : "syncing verifier";

  return (
    <section className="treasuryHero" aria-label="Shadow Treasury overview">
      <div className="treasuryHeroCopy">
        <p className="eyebrow">Shadow Treasury / M1 · verified extension</p>
        <h1>Approved adapters enforce mandate checks before vault-style funds move.</h1>
        <p>
          Shadow Treasury is the M1 extension to Float, not the primary Float proof path. The live proof shows an operator
          paying an x402 provider through Float, allocating through a hardened approved adapter, and getting an over-limit
          allocation blocked before vault-style USDC moves.
        </p>
        <div className="treasuryHeroActions">
          <a className="treasuryHeroPrimary" href="#treasury-proof">
            Verify live proof
          </a>
          <a className="treasuryHeroSecondary" href="/api/float" target="_blank" rel="noreferrer">
            Open live API
          </a>
        </div>
        <div className="treasuryHeroBoundary" aria-label="Verified proof scope">
          <span>External Float usage live</span>
          <span>M1 approved-adapter proof</span>
          <span>{verifierLabel}</span>
        </div>
      </div>

      <aside className="treasuryFlow" aria-label="Shadow Treasury flow">
        <div className="treasuryFlowHeader">
          <span>operator</span>
          <code>{shortAddress(TREASURY_PROOF.operator)}</code>
        </div>
        <div className="treasuryFlowBranch allow">
          <span>Float rail</span>
          <strong>Pays x402 provider</strong>
          <a href={txUrl(TREASURY_PROOF.txs.x402Settlement)} target="_blank" rel="noreferrer">
            {shortAddress(TREASURY_PROOF.txs.x402Settlement)}
          </a>
        </div>
        <div className="treasuryFlowBranch allow">
          <span>M1 rail</span>
          <strong>Allocates to vault</strong>
          <a href={txUrl(TREASURY_PROOF.txs.allocation)} target="_blank" rel="noreferrer">
            {shortAddress(TREASURY_PROOF.txs.allocation)}
          </a>
        </div>
        <div className="treasuryFlowBranch block">
          <span>policy guard</span>
          <strong>Blocks overreach</strong>
          <a href={txUrl(TREASURY_PROOF.txs.blocked)} target="_blank" rel="noreferrer">
            {shortAddress(TREASURY_PROOF.txs.blocked)}
          </a>
        </div>
        <div className="treasuryFlowFooter">
          <span>combined verifier</span>
          <code>npm run treasury:verify-live</code>
        </div>
      </aside>

      <div className="treasuryHeroStats" aria-label="Shadow Treasury live amounts">
        {railStats.map((stat) => (
          <div className={`treasuryHeroStat ${stat.tone}`} key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function TreasuryEvidenceStrip({ treasuryState }: { treasuryState: TreasuryState | null }) {
  const passed = treasuryState?.checks?.filter((check) => check.ok).length;
  const total = treasuryState?.checks?.length;
  const contractLinks = [
    { label: "Float", value: TREASURY_PROOF.float, href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.float}` },
    {
      label: "MandateRegistry",
      value: TREASURY_PROOF.mandateRegistry,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.mandateRegistry}`,
    },
    {
      label: "BondedEnforcer",
      value: TREASURY_PROOF.bondedEnforcer,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.bondedEnforcer}`,
    },
    {
      label: "Morpho adapter",
      value: TREASURY_PROOF.morphoAdapter,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.morphoAdapter}`,
    },
  ];
  const txLinks = [
    { label: "x402 settlement", value: TREASURY_PROOF.txs.x402Settlement, href: txUrl(TREASURY_PROOF.txs.x402Settlement) },
    { label: "Float bind", value: TREASURY_PROOF.txs.floatBind, href: txUrl(TREASURY_PROOF.txs.floatBind) },
    { label: "vault allocation", value: TREASURY_PROOF.txs.allocation, href: txUrl(TREASURY_PROOF.txs.allocation) },
    { label: "blocked allocation", value: TREASURY_PROOF.txs.blocked, href: txUrl(TREASURY_PROOF.txs.blocked) },
  ];

  return (
    <section className="treasuryEvidenceStrip" aria-label="Shadow Treasury onchain evidence">
      <div className="treasuryEvidenceIntro">
        <span>onchain evidence</span>
        <strong>{treasuryState?.ok ? `${passed}/${total} live checks pass` : "contracts and txs visible"}</strong>
        <p>Contract addresses, ArcScan transactions, and verifier JSON are visible before any narrative section.</p>
      </div>
      <div className="treasuryEvidenceGroup" aria-label="Treasury contracts">
        {contractLinks.map((item) => (
          <a href={item.href} target="_blank" rel="noreferrer" key={item.label}>
            <span>{item.label}</span>
            <code>{shortAddress(item.value)}</code>
          </a>
        ))}
      </div>
      <div className="treasuryEvidenceGroup" aria-label="Treasury proof transactions">
        {txLinks.map((item) => (
          <a href={item.href} target="_blank" rel="noreferrer" key={item.label}>
            <span>{item.label}</span>
            <code>{shortAddress(item.value)}</code>
          </a>
        ))}
        <a href="/api/treasury" target="_blank" rel="noreferrer">
          <span>verifier JSON</span>
          <code>/api/treasury</code>
        </a>
      </div>
    </section>
  );
}

function TreasuryRailSplit({
  floatState,
  leptonState,
}: {
  floatState: FloatState | null;
  leptonState: LeptonState | null;
}) {
  const externalSigned = floatState?.sourceBreakdown?.externalSigned;
  const externalDrawsLabel = floatState ? `${externalSigned?.cycles ?? 0} signed draws` : "syncing signed draws";
  const railCards = [
    {
      eyebrow: "payment rail",
      title: "Float pays before the agent is funded",
      body: "Signed agents authorize a spend, Shadow fronts the approved x402 payment, fee-inclusive debt opens, and repayment restores capacity.",
      stat: externalDrawsLabel,
      href: "/float",
      cta: "Open Float",
    },
    {
      eyebrow: "allocation rail",
      title: "M1 gates approved-adapter movement",
      body: "The approved adapter authenticates the account, reads the bonded enforcer's ALLOW or BLOCK decision, and only moves vault-style USDC on ALLOW. This guarantee is scoped to approved adapters.",
      stat: leptonState?.morphoDepositedUSDC !== undefined ? `${formatUSDC(leptonState.morphoDepositedUSDC)} USDC allocated` : "0.1 USDC allocated",
      href: "/lepton",
      cta: "Open M1",
    },
    {
      eyebrow: "combined proof",
      title: "One read-only verifier checks the proof path",
      body: "The verifier checks the x402 transfer, Float bind, debt math, vault transfer, blocked no-move path, and live API proof state.",
      stat: "25 checks",
      href: "https://github.com/dolepee/shadow",
      cta: "View repo",
    },
  ];

  return (
    <section className="treasuryRailSection" aria-label="Shadow Treasury rail split">
      <div className="treasurySectionHeader">
        <p className="eyebrow">two rails · one operator story</p>
        <h2>Payments and allocations stay separate onchain, but read as one verified mandate extension.</h2>
      </div>
      <div className="treasuryRailGrid">
        {railCards.map((card) => {
          const content = (
            <>
              <span>{card.eyebrow}</span>
              <strong>{card.title}</strong>
              <p>{card.body}</p>
              <em>{card.stat}</em>
              <small>{card.cta} →</small>
            </>
          );
          return card.href.startsWith("http") ? (
            <a className="treasuryRailCard" href={card.href} target="_blank" rel="noreferrer" key={card.eyebrow}>
              {content}
            </a>
          ) : (
            <Link className="treasuryRailCard" to={card.href} key={card.eyebrow}>
              {content}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function TreasuryProofPanel({
  floatState,
  leptonState,
  treasuryState,
}: {
  floatState: FloatState | null;
  leptonState: LeptonState | null;
  treasuryState: TreasuryState | null;
}) {
  const indexedFloatReceipt = Boolean(
    floatState?.receipts?.some(
      (receipt) => receipt.requestHash?.toLowerCase() === TREASURY_PROOF.hashes.floatRequest.toLowerCase(),
    ),
  );
  const m1HasVaultProof = Boolean(leptonState?.morphoDepositedUSDC && leptonState.morphoDepositedUSDC > 0n);
  const m1HasBlockProof = Boolean(leptonState?.morphoBlockedUSDC && leptonState.morphoBlockedUSDC > 0n);
  const proofRows = [
    {
      status: indexedFloatReceipt ? "live" : "verifier",
      title: "Float paid the x402 provider",
      amount: TREASURY_PROOF.amountX402USDC,
      receipt: "SPEND_ALLOWED + X402PaymentBound",
      meaning: "The operator fronted Arc USDC to the provider, then bound the settlement into Float debt.",
      links: [
        { label: "settlement", href: txUrl(TREASURY_PROOF.txs.x402Settlement) },
        { label: "bind", href: txUrl(TREASURY_PROOF.txs.floatBind) },
        { label: "verify", href: `/api/float-tools?action=verify&hash=${TREASURY_PROOF.hashes.floatRequest}` },
      ],
    },
    {
      status: m1HasVaultProof ? "live" : "verifier",
      title: "M1 allocated USDC into a vault sink",
      amount: TREASURY_PROOF.amountAllocatedUSDC,
      receipt: "ALLOW",
      meaning: "The bonded mandate rail allowed a vault-style allocation only after policy checks passed.",
      links: [{ label: "allocation", href: txUrl(TREASURY_PROOF.txs.allocation) }],
    },
    {
      status: m1HasBlockProof ? "live" : "verifier",
      title: "M1 blocked an oversized allocation",
      amount: TREASURY_PROOF.amountBlockedUSDC,
      receipt: "BLOCK / AMOUNT_TOO_HIGH",
      meaning: "The same mandate refused an over-limit allocation before vault USDC moved.",
      links: [{ label: "block", href: txUrl(TREASURY_PROOF.txs.blocked) }],
    },
    {
      status: "proven",
      title: "No-secret verifier checks both rails",
      amount: `${formatFloatUSDC(TREASURY_PROOF.feeUSDC)} fee`,
      receipt: "npm run treasury:verify-live",
      meaning: "The verifier checks the payment tx, bind event, vault movement, blocked no-move path, debt, and fee.",
      links: [{ label: "repo", href: "https://github.com/dolepee/shadow" }],
    },
  ];

  return (
    <section className="treasuryProofPanel" id="treasury-proof" aria-label="Shadow Treasury live proof">
      <div className="treasuryProofHeader">
        <div>
          <p className="eyebrow">live proof runway · Arc receipts</p>
          <h2>One operator paid, allocated, and was stopped on the third action.</h2>
          <p>
            The proof below is deliberately concrete: one x402 payment, one vault allocation, one blocked over-limit
            allocation, and one read-only verifier.
          </p>
        </div>
        <div className={`treasuryProofStatus ${treasuryState?.ok === false ? "fail" : ""}`}>
          <span className="treasuryProofStatusDot" />
          {treasuryState ? (treasuryState.ok ? "live verifier green" : "verifier red") : "verifier ready"}
        </div>
      </div>

      <div className="treasuryMetricGrid" aria-label="Treasury proof amounts">
        <TreasuryMetric label="x402 paid" value={`${formatFloatUSDC(TREASURY_PROOF.amountX402USDC)} USDC`} tone="allow" />
        <TreasuryMetric label="vault allocated" value={`${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`} tone="allow" />
        <TreasuryMetric label="blocked attempt" value={`${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`} tone="block" />
        <TreasuryMetric label="Float fee" value={`${formatFloatUSDC(TREASURY_PROOF.feeUSDC)} USDC`} />
      </div>

      <div className="treasuryProofLayout">
        <div className="treasuryTimeline">
          {proofRows.map((row, index) => (
            <article className={`treasuryStep ${row.status}`} key={row.title}>
              <div className="treasuryStepIndex">{index + 1}</div>
              <div className="treasuryStepBody">
                <div className="treasuryStepMeta">
                  <span>{row.status}</span>
                  <code>{row.receipt}</code>
                </div>
                <strong>{row.title}</strong>
                <p>{row.meaning}</p>
                <div className="treasuryStepFooter">
                  <span>{row.amount.includes("fee") ? row.amount : `${formatFloatUSDC(row.amount)} USDC`}</span>
                  <div className="treasuryStepLinks">
                    {row.links.map((link) =>
                      link.href.startsWith("http") || link.href.startsWith("/api") ? (
                        <a key={link.label} href={link.href} target="_blank" rel="noreferrer">
                          {link.label}
                        </a>
                      ) : (
                        <Link key={link.label} to={link.href}>
                          {link.label}
                        </Link>
                      ),
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>

        <aside className="treasuryContractStack" aria-label="Contracts used in the Treasury proof">
          <div>
            <span>operator</span>
            <code>{shortAddress(TREASURY_PROOF.operator)}</code>
          </div>
          <div>
            <span>Float</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.float}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.float)}
            </a>
          </div>
          <div>
            <span>MandateRegistry</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.mandateRegistry}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.mandateRegistry)}
            </a>
          </div>
          <div>
            <span>BondedEnforcer</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.bondedEnforcer}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.bondedEnforcer)}
            </a>
          </div>
          <div>
            <span>Morpho-style adapter</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.morphoAdapter}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.morphoAdapter)}
            </a>
          </div>
          <div>
            <span>vault sink</span>
            <a href={`https://testnet.arcscan.app/address/${TREASURY_PROOF.vaultSink}`} target="_blank" rel="noreferrer">
              {shortAddress(TREASURY_PROOF.vaultSink)}
            </a>
          </div>
        </aside>
      </div>

      <div className="treasuryBoundary">
        <span>External Float signed usage is live.</span>
        <span>CitePay and Forum reviewed the Treasury proof.</span>
        <span>
          API and CLI both check the combined proof: <code>/api/treasury</code> and <code>npm run treasury:verify-live</code>.
        </span>
      </div>
    </section>
  );
}

function TreasuryReceiptStructurePanel() {
  const receipts = [
    {
      title: "ALLOW receipt",
      subtitle: "vault allocation",
      href: txUrl(TREASURY_PROOF.txs.allocation),
      fields: [
        "decision = ALLOW",
        "reason = NONE",
        `amount = ${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`,
        `actor = ${shortAddress(TREASURY_PROOF.operator)}`,
        `target = ${shortAddress(TREASURY_PROOF.morphoAdapter)}`,
        `actionHash = ${shortAddress(TREASURY_PROOF.hashes.allowedAction as Hash)}`,
      ],
    },
    {
      title: "BLOCK receipt",
      subtitle: "over-limit allocation",
      href: txUrl(TREASURY_PROOF.txs.blocked),
      fields: [
        "decision = BLOCK",
        "reason = AMOUNT_TOO_HIGH",
        `amount = ${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`,
        `actor = ${shortAddress(TREASURY_PROOF.operator)}`,
        "vault Transfer = none",
        `actionHash = ${shortAddress(TREASURY_PROOF.hashes.blockedAction as Hash)}`,
      ],
    },
    {
      title: "Float debt receipt",
      subtitle: "x402 payment",
      href: `/api/float-tools?action=verify&hash=${TREASURY_PROOF.hashes.floatRequest}`,
      fields: [
        "receipt = SPEND_ALLOWED + PROVIDER_PAID + FEE_ACCRUED + DEBT_OPENED",
        `provider paid = ${formatFloatUSDC(TREASURY_PROOF.amountX402USDC)} USDC`,
        `fee = ${formatFloatUSDC(TREASURY_PROOF.feeUSDC)} USDC`,
        `requestHash = ${shortAddress(TREASURY_PROOF.hashes.floatRequest as Hash)}`,
      ],
    },
  ];

  return (
    <section className="treasuryReceiptStructure" aria-label="Treasury receipt structure">
      <div className="treasurySectionHeader">
        <p className="eyebrow">receipt structure · defined fields</p>
        <h2>ALLOW and BLOCK are not labels; they are receipt fields checked by the verifier.</h2>
      </div>
      <div className="treasuryReceiptGrid">
        {receipts.map((receipt) => (
          <a className="treasuryReceiptCard" href={receipt.href} target="_blank" rel="noreferrer" key={receipt.title}>
            <span>{receipt.subtitle}</span>
            <strong>{receipt.title}</strong>
            <ul>
              {receipt.fields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </a>
        ))}
      </div>
    </section>
  );
}

function TreasuryLiveVerifierPanel({
  state,
  loading,
  error,
}: {
  state: TreasuryState | null;
  loading: boolean;
  error: string | null;
}) {
  const checks = state?.checks || [];
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  const visibleChecks = checks.slice(0, 8);
  const checkedAt = state?.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <section className="treasuryLiveVerifier" aria-label="Live Shadow Treasury verifier">
      <div className="treasuryLiveVerifierHeader">
        <div>
          <p className="eyebrow">live verifier · no private keys</p>
          <h2>The Treasury page now reads the same proof checks as the CLI.</h2>
          <p>
            This endpoint verifies the x402 settlement, Float bind, debt math, vault transfer, blocked no-transfer path,
            bonds, and API indexing from live Arc state.
          </p>
        </div>
        <a href="/api/treasury" target="_blank" rel="noreferrer" className={`treasuryVerifierBadge ${state?.ok ? "pass" : error ? "fail" : ""}`}>
          {loading && !state ? "syncing" : state?.ok ? "PASS" : error ? "CHECK API" : "loading"}
          {state && <span>{passed}/{checks.length} checks</span>}
        </a>
      </div>

      {error ? (
        <div className="treasuryVerifierError">
          <strong>Verifier read failed</strong>
          <p>{error}</p>
        </div>
      ) : (
        <div className="treasuryVerifierGrid">
          <article className="treasuryVerifierSummary">
            <span>combined proof</span>
            <strong>{state?.ok ? "green" : loading ? "syncing" : "pending"}</strong>
            <p>
              {failed
                ? `${failed} check${failed === 1 ? "" : "s"} need attention before relying on this proof.`
                : state
                  ? `All ${passed} live checks passed${checkedAt ? ` at ${checkedAt}` : ""}.`
                  : "Waiting for the live Treasury API to return."}
            </p>
            <div>
              <a href="/api/treasury" target="_blank" rel="noreferrer">
                Open JSON
              </a>
              <a href="https://github.com/dolepee/shadow" target="_blank" rel="noreferrer">
                Run CLI
              </a>
            </div>
          </article>
          <div className="treasuryVerifierChecks">
            {visibleChecks.map((check) => (
              <article className={check.ok ? "pass" : "fail"} key={check.check}>
                <span>{check.status}</span>
                <strong>{check.check}</strong>
                <p>{check.detail}</p>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TreasuryJudgePath() {
  const links = [
    { label: "Run verifier", value: "npm run treasury:verify-live", href: "https://github.com/dolepee/shadow" },
    { label: "x402 settlement", value: shortAddress(TREASURY_PROOF.txs.x402Settlement), href: txUrl(TREASURY_PROOF.txs.x402Settlement) },
    { label: "Float bind", value: shortAddress(TREASURY_PROOF.txs.floatBind), href: txUrl(TREASURY_PROOF.txs.floatBind) },
    { label: "Vault allocation", value: shortAddress(TREASURY_PROOF.txs.allocation), href: txUrl(TREASURY_PROOF.txs.allocation) },
    { label: "Blocked allocation", value: shortAddress(TREASURY_PROOF.txs.blocked), href: txUrl(TREASURY_PROOF.txs.blocked) },
    { label: "Live Float API", value: "/api/float", href: "/api/float" },
  ];

  return (
    <section className="treasuryJudgePath" aria-label="Judge path for Shadow Treasury">
      <div className="treasurySectionHeader">
        <p className="eyebrow">judge path · one click each</p>
        <h2>Check the proof without trusting the UI.</h2>
      </div>
      <div className="treasuryJudgeGrid">
        {links.map((link) => (
          <a className="treasuryJudgeLink" href={link.href} target="_blank" rel="noreferrer" key={link.label}>
            <span>{link.label}</span>
            <strong>{link.value}</strong>
          </a>
        ))}
      </div>
    </section>
  );
}

function TreasuryValidationPanel({ floatState }: { floatState: FloatState | null }) {
  const externalSigned = floatState?.sourceBreakdown?.externalSigned;
  const externalClosed = externalSigned?.lifecycleClosedCount ?? 0;
  const validationRows = [
    {
      label: "Obol",
      status: "verified Float draw",
      detail: "Buyer-side agent signed a current-contract spend intent and publicly confirmed the bind.",
    },
    {
      label: "Argus",
      status: "signed security-agent intent",
      detail: "Agent Alpha signed a Float intent for paid x402 security data before producing a verdict.",
    },
    {
      label: "CitePay",
      status: "architecture fit reviewed",
      detail: "Builder feedback says Float + M1 fits agent/x402 workflows because enforcement happens before USDC leaves the policy boundary.",
    },
    {
      label: "Forum",
      status: "live txs verified",
      detail: "Forum reviewed the Arc transactions and confirmed the same vault entrypoint moved funds when allowed, then moved zero USDC when over limit.",
    },
  ];

  return (
    <section className="treasuryValidationSection" aria-label="External validation and builder background">
      <div className="treasurySectionHeader">
        <p className="eyebrow">validation · proof scope</p>
        <h2>External Float usage is live; M1 review is tied to verifier proof.</h2>
      </div>

      <div className="treasuryValidationGrid">
        <article className="treasuryValidationCard treasuryValidationCardPrimary">
          <span>external Float proof</span>
          <strong>{externalSigned?.cycles ?? 0} signed draws</strong>
          <p>
            External agents can authorize a Float spend without hot-funding the x402 payment first. The current standing
            board and verifier expose the signed draw path; {externalClosed} external lifecycle{externalClosed === 1 ? "" : "s"} closed through repayment.
          </p>
          <Link to="/proof">Open external proof →</Link>
        </article>

        <article className="treasuryValidationCard treasuryValidationCardValidated">
          <span>technical review</span>
          <strong>Builders reviewed the proof</strong>
          <p>
            CitePay confirmed the architecture fit. Forum checked the live Arc transactions and verified the core claim:
            the same vault adapter entrypoint moved USDC when allowed, then moved zero USDC when over limit.
          </p>
          <a href="/api/treasury" target="_blank" rel="noreferrer">
            Open verifier output →
          </a>
        </article>

        <article className="treasuryValidationCard">
          <span>builder background</span>
          <strong>Receipt rails before Treasury</strong>
          <p>
            Shadow's earlier receipt-and-policy system settled 2,893 onchain receipts across 30 follower wallets. Float is
            the focused product; M1 shows how the same discipline extends into policy-bound allocations.
          </p>
          <Link to="/archive">Open prior proof →</Link>
        </article>
      </div>

      <div className="treasuryValidationList" aria-label="External validation entries">
        {validationRows.map((row) => (
          <article key={row.label}>
            <span>{row.label}</span>
            <strong>{row.status}</strong>
            <p>{row.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TreasuryHardeningPanel() {
  const boundaries = [
    {
      label: "approved-adapter boundary",
      title: "The live M1 guarantee is scoped",
      body: "The hardened proof adapters authenticate the account and honor ALLOW/BLOCK before transfer. Arbitrary third-party adapters are not covered by this claim.",
    },
    {
      label: "proof sink",
      title: "Vault proof is not production treasury custody",
      body: "The current sink proves an allowed allocation and a no-transfer block. Post-hackathon work is a withdrawable vault or real market integration.",
    },
    {
      label: "bond scope",
      title: "The bond covers receipt liveness today",
      body: "Correctness and settlement slashing remain roadmap work. The live proof does not pretend the bond covers every production treasury risk.",
    },
    {
      label: "underwriting roadmap",
      title: "Float scoring is deterministic v0",
      body: "Current lines use operator-reviewed evidence. The next upgrade is a permissionless receipt indexer that recomputes evidence counts from chain.",
    },
  ];

  return (
    <section className="treasuryValidationSection" aria-label="M1 proof boundaries and post-hackathon hardening">
      <div className="treasurySectionHeader">
        <p className="eyebrow">proof boundary · post-hackathon hardening</p>
        <h2>The live proof is real; production treasury custody is the next build.</h2>
      </div>
      <div className="roadmapGrid">
        {boundaries.map((item) => (
          <article className="roadmapCard" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TreasuryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`treasuryMetric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function FloatPanel({
  state,
  loading,
  error,
  compact = false,
}: {
  state: FloatState | null;
  loading: boolean;
  error: string | null;
  compact?: boolean;
}) {
  const configured = Boolean(state?.configured);
  const alpha = state?.alphaLine;
  const beta = state?.betaLine;
  const receipts = state?.receipts || [];
  const pointers = state?.proofPointers;
  const agentLoop = state?.sourceBreakdown?.agentLoop;
  const externalSigned = state?.sourceBreakdown?.externalSigned;
  const standingBoard = state?.standingBoard;
  const runs = state?.loopRuns || [];
  const latestPaidRun = runs.find((run) => run.x402Hash || run.bindTxHash);
  const latestGuardRun = runs.find(
    (run) => run.outcome?.includes("BLOCK") || run.outcome?.includes("DENIED") || run.action === "PREMIUM",
  );
  const latestExternalRun = runs.find((run) => run.source === "external-signed" && run.requestHash);
  const latestPaidReceipt =
    pointers?.x402BoundReceipt || receipts.find((receipt) => receipt.x402) || receipts.find((receipt) => receipt.receiptType === "SPEND_ALLOWED");
  const latestGuardReceipt = receipts.find(
    (receipt) => receipt.receiptType.includes("BLOCK") || receipt.receiptType.includes("DENIED"),
  ) || pointers?.overspendReceipt || pointers?.denialReceipt;
  const updated =
    state?.fetchedAt && configured
      ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  const proofSteps = [
    {
      label: "1",
      title: "Earn",
      detail: "Alpha has verified Shadow receipts and receives a revocable 1 USDC spending line.",
    },
    {
      label: "2",
      title: "Pay",
      detail: "The agent buys an approved x402 resource before its own wallet is funded.",
    },
    {
      label: "3",
      title: "Bind",
      detail: "The x402 settlement hash is bound into the Float receipt and debt opens.",
    },
    {
      label: "4",
      title: "Block",
      detail: "Oversized or risky spends are refused before treasury USDC moves.",
    },
  ];
  const primaryProofHash = latestPaidRun?.x402Hash || latestPaidReceipt?.x402?.x402Hash;
  const bindProofHash = latestPaidRun?.bindTxHash || latestPaidReceipt?.x402?.bindingTxHash || latestPaidReceipt?.transactionHash;
  const guardProofHash = latestGuardRun?.txHash || latestGuardReceipt?.transactionHash;
  const syncPending = loading && !configured;

  return (
    <section className={`floatPanel floatPanelV2${compact ? " floatPanelCompact" : ""}`} id="shadow-float">
      <div className="floatHeroShell">
        <div className="floatHeroCopy">
          <p className="eyebrow">Shadow Float · external proof live</p>
          {compact ? (
            <h2>Signed agents spend first. Shadow records the debt.</h2>
          ) : (
            <h1>Signed agents spend first. Shadow records the debt.</h1>
          )}
          <p className="floatLede">
            Shadow Float gives autonomous agents a bounded revocable spending line backed by verified onchain behavior.
            The agent signs what it wants to buy; Shadow fronts the approved x402 payment, opens debt, and blocks overreach
            before treasury USDC moves.
          </p>
          <div className="floatHeroActions">
            {primaryProofHash ? (
              <a className="floatPrimaryAction" href={txUrl(primaryProofHash as `0x${string}`)} target="_blank" rel="noreferrer">
                Open latest x402 proof
              </a>
            ) : (
              <a className="floatPrimaryAction" href="#float-receipts">
                Open receipt rail
              </a>
            )}
            <a className="floatSecondaryAction" href="#float-loop">
              Watch autonomous loop
            </a>
          </div>
        </div>
        <aside className="floatProofCard" aria-label="Shadow Float live proof">
          <div className="floatProofCardHeader">
            <span>live proof</span>
            <strong>{configured ? `${state?.receiptCount || "0"} receipts` : "syncing"}</strong>
          </div>
          <div className="floatProofCardMoment">
            <span>good agent</span>
            <strong>pays x402</strong>
            <small>{primaryProofHash ? shortAddress(primaryProofHash) : "waiting for settlement"}</small>
          </div>
          <div className="floatProofCardMoment blocked">
            <span>overreach</span>
            <strong>blocked first</strong>
            <small>{guardProofHash ? shortAddress(guardProofHash) : "no treasury spend"}</small>
          </div>
          <div className="floatProofCardFooter">
            <span>{configured ? `treasury ${formatFloatUSDC(state?.treasuryBalanceUSDC)} USDC` : "treasury syncing"}</span>
            <span>chain 5042002</span>
          </div>
        </aside>
      </div>

      <div className="floatStatusRow">
        <div className={`floatStatus ${configured ? "configured" : "pending"}`}>
          <span className="floatStatusDot" />
          {configured ? "live Float reads" : syncPending ? "syncing live proof" : "configuration pending"}
          {loading && <small>syncing</small>}
          {updated && <small>updated {updated}</small>}
        </div>
        <span>real Arc USDC</span>
        <span>x402 settlement bound onchain</span>
        <span>operator, external, and onboarding proofs stay separated</span>
      </div>

      {!compact && <FloatWalletProof state={state} loading={loading} />}
      {!compact && <FloatProofRunway state={state} />}

      <div className="floatHeadlineStats">
        <FloatHeadlineStat
          label="external signed x402"
          value={`${externalSigned?.cycles || 0}`}
          detail={`${formatFloatUSDC(externalSigned?.providerPaidUSDC)} provider paid`}
          tone="allow"
        />
        <FloatHeadlineStat
          label="external lifecycles closed"
          value={`${externalSigned?.lifecycleClosedCount || 0}`}
          detail={`${formatFloatUSDC(externalSigned?.repaidUSDC)} repaid`}
          tone="allow"
        />
        <FloatHeadlineStat
          label="operator loop cycles"
          value={`${agentLoop?.cycles || 0}`}
          detail={`${agentLoop?.paidCount || 0} paid · ${agentLoop?.skipCount || 0} skipped`}
        />
        <FloatHeadlineStat
          label="operator loop settled"
          value={formatFloatUSDC(agentLoop?.providerPaidUSDC)}
          detail="separate from external signed usage"
          tone="allow"
        />
        <FloatHeadlineStat
          label="blocked before spend"
          value={formatFloatUSDC(state?.totalBlockedUSDC)}
          detail="total refused before funds moved"
          tone="block"
        />
        <FloatHeadlineStat
          label="risky denied"
          value={formatFloatUSDC(state?.totalDeniedUSDC)}
          detail="no spendable line opened"
          tone="block"
        />
      </div>

      <FloatStandingBoardPanel board={standingBoard} alpha={state?.alpha} beta={state?.beta} compact={compact} />
      {!compact && <FloatExternalSignedPanel state={state} />}

      {!compact && (
        <div className="floatProofRail" aria-label="Shadow Float proof path">
          {proofSteps.map((step) => (
            <div className="floatProofStep" key={step.title}>
              <span>{step.label}</span>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </div>
          ))}
        </div>
      )}

      <div className="floatHeroGrid">
        <article className="floatAgentCard primary">
          <div className="floatCardHeader">
            <span>Agent Alpha</span>
            <code>{state?.alpha ? shortAddress(state.alpha) : "pending"}</code>
          </div>
          <h3>{alpha?.status || "ELIGIBLE"}</h3>
          <div className="floatLineStats">
            <FloatFact label="line limit" value={formatFloatUSDC(alpha?.creditLimitUSDC)} />
            <FloatFact label="available" value={formatFloatUSDC(alpha?.availableCreditUSDC)} />
            <FloatFact label="active debt" value={formatFloatUSDC(alpha?.activeDebtUSDC)} />
            <FloatFact label="score" value={alpha ? alpha.score.toString() : "9300"} />
          </div>
          <p>
            Alpha can spend only through the approved x402 provider endpoint. A successful call binds the settlement hash,
            opens debt, and repayment refreshes the available line.
          </p>
        </article>

        <article className="floatAgentCard blocked">
          <div className="floatCardHeader">
            <span>Agent Beta</span>
            <code>{state?.beta ? shortAddress(state.beta) : "pending"}</code>
          </div>
          <h3>{beta?.status || "DENIED"}</h3>
          <div className="floatLineStats">
            <FloatFact label="line limit" value={formatFloatUSDC(beta?.creditLimitUSDC)} />
            <FloatFact label="available" value={formatFloatUSDC(beta?.availableCreditUSDC)} />
            <FloatFact label="active debt" value={formatFloatUSDC(beta?.activeDebtUSDC)} />
            <FloatFact label="score" value={beta ? beta.score.toString() : "2100"} />
          </div>
          <p>Beta has block/slash-style history and cannot turn reputation into spendable USDC.</p>
        </article>
      </div>

      <div className="floatMetricGrid">
        <FloatMetric label="receipts" value={state?.receiptCount || "pending"} />
        <FloatMetric label="treasury" value={formatFloatUSDC(state?.treasuryBalanceUSDC)} />
        <FloatMetric label="provider paid" value={formatFloatUSDC(state?.totalProviderPaidUSDC)} tone="allow" />
        <FloatMetric label="debt + fee" value={formatFloatUSDC(state?.totalDebtOpenedUSDC)} tone="allow" />
        <FloatMetric label="fees accrued" value={formatFloatUSDC(state?.totalFeesAccruedUSDC)} tone="allow" />
        <FloatMetric label="repaid" value={formatFloatUSDC(state?.totalRepaidUSDC)} tone="allow" />
        <FloatMetric label="blocked" value={formatFloatUSDC(state?.totalBlockedUSDC)} tone="block" />
        <FloatMetric label="denied" value={formatFloatUSDC(state?.totalDeniedUSDC)} tone="block" />
        <FloatMetric label="defaulted" value={formatFloatUSDC(state?.totalDefaultedUSDC)} tone="block" />
        <FloatMetric
          label="receipt chain"
          value={
            state?.lastChecksum &&
            state.lastChecksum !== "0x0000000000000000000000000000000000000000000000000000000000000000"
              ? "valid"
              : "pending"
          }
        />
      </div>

      {!compact && <FloatProofChecksPanel state={state} />}

      <FloatLoopPanel state={state} compact={compact} />

      <div className="floatGrid">
        <article className="floatBox">
          <div className="floatBoxHeader">
            <span>approved x402 provider</span>
            <small>{state?.provider ? shortAddress(state.provider) : "waiting"}</small>
          </div>
          <div className="floatProviderFacts">
            <FloatFact label="endpoint hash" value={shortHash(state?.providerMandate?.endpointHash)} />
            <FloatFact label="max/request" value={formatFloatUSDC(state?.providerMandate?.maxPerRequestUSDC)} />
            <FloatFact label="daily cap" value={formatFloatUSDC(state?.providerMandate?.dailyLimitUSDC)} />
            <FloatFact label="active" value={state?.providerMandate?.active ? "yes" : "pending"} />
          </div>
        </article>

        <article className="floatBox">
          <div className="floatBoxHeader">
            <span>proof links</span>
            <small>deterministic policy</small>
          </div>
          <div className="floatProofLinks">
            {primaryProofHash && (
              <a href={txUrl(primaryProofHash as `0x${string}`)} target="_blank" rel="noreferrer">
                x402 settlement <strong>{shortAddress(primaryProofHash)}</strong>
              </a>
            )}
            {bindProofHash && (
              <a href={txUrl(bindProofHash as `0x${string}`)} target="_blank" rel="noreferrer">
                Float bind <strong>{shortAddress(bindProofHash)}</strong>
              </a>
            )}
            {guardProofHash && (
              <a href={txUrl(guardProofHash as `0x${string}`)} target="_blank" rel="noreferrer">
                block proof <strong>{shortAddress(guardProofHash)}</strong>
              </a>
            )}
            {latestExternalRun?.requestHash && (
              <a href={`/api/float-tools?action=verify&hash=${latestExternalRun.requestHash}`} target="_blank" rel="noreferrer">
                signed external verify <strong>{shortHash(latestExternalRun.requestHash)}</strong>
              </a>
            )}
            {state?.float && (
              <a href={`https://testnet.arcscan.app/address/${state.float}`} target="_blank" rel="noreferrer">
                ShadowFloat <strong>{shortAddress(state.float)}</strong>
              </a>
            )}
          </div>
        </article>
      </div>

      {!compact && (
        <article className="floatReceipts" id="float-receipts">
          <div className="floatBoxHeader">
            <span>latest Float receipts</span>
            <small>{receipts.length ? `${receipts.length} indexed` : "waiting for proof run"}</small>
          </div>
          <div className="floatReceiptList">
            {receipts.length ? (
              receipts.slice(0, 10).map((receipt) => (
                <div
                  className={`floatReceipt ${
                    receipt.receiptType.includes("BLOCK") || receipt.receiptType.includes("DENIED") ? "blocked" : "allowed"
                  }`}
                  key={`${receipt.receiptId}-${receipt.transactionHash}`}
                >
                  <a className="floatReceiptPrimary" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer">
                    <span>#{receipt.receiptId}</span>
                    <strong>{receipt.receiptType}</strong>
                    <code>{receipt.receiptType === "DEBT_OPENED" ? `${formatFloatUSDC(receipt.debtOpenedUSDC)} debt` : `${formatFloatUSDC(receipt.amountUSDC)} USDC`}</code>
                    <small>{receipt.reason}</small>
                  </a>
                  <div className="floatReceiptDetails">
                    <small>provider {formatFloatUSDC(receipt.providerAmountUSDC || receipt.amountUSDC)}</small>
                    <small>fee {formatFloatUSDC(receipt.feeUSDC)}</small>
                    <small>debt opened {formatFloatUSDC(receipt.debtOpenedUSDC)}</small>
                    <small>debt after {formatFloatUSDC(receipt.debtAfterUSDC)}</small>
                  </div>
                  {receipt.x402 && receipt.receiptType === "SPEND_ALLOWED" && (
                    <a className="floatX402Link" href={txUrl(receipt.x402.x402Hash)} target="_blank" rel="noreferrer">
                      paid via x402 · {shortAddress(receipt.x402.x402Hash)}
                    </a>
                  )}
                </div>
              ))
            ) : (
              <div className="floatEmpty">No Float receipts are indexed for this deployment yet.</div>
            )}
          </div>
        </article>
      )}

      {error && <div className="leptonError">Float read failed: {error}</div>}

      {!compact && (
        <FloatJudgePath state={state} />
      )}

      {!compact && (
        <div className="floatBoundaries">
          <span>testnet USDC line, not a lending market</span>
          <span>agent chooses the spend; Shadow enforces the mandate</span>
          <span>x402 settlement tx is bound on-chain</span>
          <span>external signed and onboarding-assisted proofs stay labeled separately</span>
        </div>
      )}
    </section>
  );
}

function FloatWalletProof({ state, loading }: { state: FloatState | null; loading: boolean }) {
  const proof = state?.walletProof;
  const exactHistory = Boolean(proof?.historicalBeforeBalanceAvailable);
  const pending = loading && !proof;
  const showUSDC = (value?: string | bigint | null) => (pending ? "syncing" : formatFloatUSDC(value));
  return (
    <article className="floatWalletProof" aria-label="Agent wallet shortfall proof">
      <div className="floatBoxHeader">
        <span>insufficient-wallet proof</span>
        <small>{exactHistory ? "historical snapshot" : "current balance + receipts"}</small>
      </div>
      <div className="floatWalletProofCopy">
        <strong>The agent does not need to pre-fund the x402 spend.</strong>
        <p>
          Shadow fronts the provider payment from the Float path, then assigns debt to the agent&apos;s line. Historical
          pre-spend wallet balance is not stored by the contract, so the page shows current wallet balance and the live
          x402/debt receipts instead of inventing a before snapshot.
        </p>
      </div>
      <div className="floatWalletProofGrid">
        <FloatFact label="agent wallet USDC" value={showUSDC(proof?.agentWalletUSDC)} />
        <FloatFact label="x402 required" value={showUSDC(proof?.requiredX402AmountUSDC)} />
        <FloatFact label="current shortfall" value={showUSDC(proof?.walletShortfallUSDC)} />
        <FloatFact label="Float capacity" value={showUSDC(proof?.floatAvailableCapacityUSDC)} />
        <FloatFact label="facilitator paid" value={showUSDC(proof?.facilitatorPaidUSDC)} />
        <FloatFact label="debt assigned" value={showUSDC(proof?.debtAssignedUSDC)} />
      </div>
      <div className="floatWalletProofLinks">
        {proof?.x402Hash && (
          <a href={txUrl(proof.x402Hash)} target="_blank" rel="noreferrer">
            x402 settlement {shortAddress(proof.x402Hash)}
          </a>
        )}
        {proof?.bindTxHash && (
          <a href={txUrl(proof.bindTxHash)} target="_blank" rel="noreferrer">
            Float bind {shortAddress(proof.bindTxHash)}
          </a>
        )}
        <a href="/api/float" target="_blank" rel="noreferrer">
          live Float API
        </a>
      </div>
    </article>
  );
}

function FloatProofRunway({ state }: { state: FloatState | null }) {
  const receipts = state?.receipts || [];
  const pointers = state?.proofPointers;
  const latestExternalRun = (state?.loopRuns || []).find((run) => run.source === "external-signed" && run.requestHash);
  const x402Receipt = pointers?.x402BoundReceipt || receipts.find((receipt) => receipt.x402);
  const grantReceipt = pointers?.grantReceipt || receipts.find((receipt) => receipt.receiptType === "FLOAT_GRANTED");
  const providerPaidReceipt = pointers?.providerPaidReceipt || (x402Receipt?.requestHash
    ? receipts.find((receipt) => receipt.receiptType === "PROVIDER_PAID" && receipt.requestHash === x402Receipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "PROVIDER_PAID"));
  const debtReceipt = pointers?.debtReceipt || (x402Receipt?.requestHash
    ? receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED" && receipt.requestHash === x402Receipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED"));
  const repayReceipt = pointers?.repaymentReceipt || receipts.find((receipt) => receipt.receiptType === "REPAID");
  const overspendReceipt = pointers?.overspendReceipt || receipts.find((receipt) => receipt.receiptType === "SPEND_BLOCKED" && receipt.reason === "AMOUNT_TOO_HIGH");
  const denialReceipt = pointers?.denialReceipt || receipts.find((receipt) => receipt.receiptType === "CREDIT_DENIED");
  const walletProof = state?.walletProof;
  const rows = [
    {
      title: "Agent wallet insufficient",
      status: walletProof ? "live" : "pending",
      amount: formatFloatUSDC(walletProof?.walletShortfallUSDC),
      receipt: "BALANCE_CHECK",
      href: "/api/float",
      meaning: "Current wallet balance is shown separately from Float capacity; no fake historical balance is claimed.",
    },
    {
      title: "Behavior-backed line granted",
      status: grantReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(grantReceipt?.amountUSDC || state?.alphaLine?.creditLimitUSDC),
      receipt: "FLOAT_GRANTED",
      href: grantReceipt?.transactionHash ? txUrl(grantReceipt.transactionHash) : "/api/float",
      meaning: "The line exists onchain and is operator-reviewed from observed behavior.",
    },
    {
      title: "x402 payment required",
      status: state?.providerMandate?.active ? "live" : "pending",
      amount: formatFloatUSDC(walletProof?.requiredX402AmountUSDC),
      receipt: "HTTP_402",
      href: "/api/reasoning-x402",
      meaning: "The provider endpoint demands USDC before returning the paid resource.",
    },
    {
      title: "Shadow pays provider",
      status: providerPaidReceipt || x402Receipt ? "proven" : "pending",
      amount: formatFloatUSDC(providerPaidReceipt?.amountUSDC || x402Receipt?.x402?.amountUSDC),
      receipt: "PROVIDER_PAID",
      href: x402Receipt?.x402?.x402Hash ? txUrl(x402Receipt.x402.x402Hash) : providerPaidReceipt?.transactionHash ? txUrl(providerPaidReceipt.transactionHash) : "/api/float",
      meaning: "The facilitator fronts real Arc USDC to the x402 provider.",
    },
    {
      title: "Float binds settlement",
      status: x402Receipt?.x402 ? "proven" : "pending",
      amount: formatFloatUSDC(x402Receipt?.x402?.amountUSDC),
      receipt: "X402PaymentBound",
      href: x402Receipt?.x402?.bindingTxHash ? txUrl(x402Receipt.x402.bindingTxHash) : "/api/float",
      meaning: "The x402 settlement hash is bound to the Float request hash onchain.",
    },
    {
      title: "Debt opens",
      status: debtReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(debtReceipt?.debtOpenedUSDC),
      receipt: "DEBT_OPENED",
      href: debtReceipt?.transactionHash ? txUrl(debtReceipt.transactionHash) : "/api/float",
      meaning: "Debt includes provider amount plus the testnet fee, so accounting is explicit.",
    },
    {
      title: "Repayment restores capacity",
      status: repayReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(repayReceipt?.amountUSDC),
      receipt: "REPAID",
      href: repayReceipt?.transactionHash ? txUrl(repayReceipt.transactionHash) : "/api/float",
      meaning: "Repayment reduces debt and reopens available capacity.",
    },
    {
      title: "Overspend blocked",
      status: overspendReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(overspendReceipt?.amountUSDC),
      receipt: "SPEND_BLOCKED",
      href: overspendReceipt?.transactionHash ? txUrl(overspendReceipt.transactionHash) : "/api/float",
      meaning: "A request above the line is refused before provider or treasury funds move.",
    },
    {
      title: "Risky agent denied",
      status: denialReceipt ? "proven" : "pending",
      amount: formatFloatUSDC(denialReceipt?.amountUSDC),
      receipt: "CREDIT_DENIED",
      href: denialReceipt?.transactionHash ? txUrl(denialReceipt.transactionHash) : "/api/float",
      meaning: "A denied line cannot turn into spendable USDC.",
    },
  ];

  return (
    <article className="floatRunway" aria-label="Float proof runway">
      <div className="floatBoxHeader">
        <span>Float proof runway</span>
        <small>the loop in 10 seconds</small>
      </div>
      <div className="floatRunwayRows">
        {rows.map((row, index) => (
          <a className={`floatRunwayRow ${row.status}`} href={row.href} target="_blank" rel="noreferrer" key={row.title}>
            <span className="floatRunwayIndex">{index + 1}</span>
            <span className="floatRunwayStatus">{row.status}</span>
            <span className="floatRunwayMain">
              <strong>{row.title}</strong>
              <small>{row.meaning}</small>
            </span>
            <code>{row.receipt}</code>
            <span className="floatRunwayAmount">{row.amount} USDC</span>
          </a>
        ))}
      </div>
      {latestExternalRun?.requestHash && (
        <a className="floatRunwayVerify" href={`/api/float-tools?action=verify&hash=${latestExternalRun.requestHash}`} target="_blank" rel="noreferrer">
          Verify signed external intent {shortHash(latestExternalRun.requestHash)}
        </a>
      )}
    </article>
  );
}

function FloatProofChecksPanel({ state }: { state: FloatState | null }) {
  const checks = state?.proofChecks || {};
  const entries = Object.entries(checks).filter(([, value]) => typeof value === "boolean") as Array<[string, boolean]>;
  const trustBoundary = typeof checks.trustBoundary === "string" ? checks.trustBoundary : null;
  return (
    <article className="floatProofChecks" aria-label="Float proof checks">
      <div className="floatBoxHeader">
        <span>API proof checks</span>
        <small>{entries.filter(([, ok]) => ok).length}/{entries.length || 0} passing</small>
      </div>
      <div className="floatProofCheckGrid">
        {entries.map(([key, ok]) => (
          <a className={`floatProofCheck ${ok ? "pass" : "pending"}`} href="/api/float" target="_blank" rel="noreferrer" key={key}>
            <span>{ok ? "PASS" : "PENDING"}</span>
            <strong>{humanizeFloatKey(key)}</strong>
          </a>
        ))}
      </div>
      {trustBoundary && <p>{trustBoundary}</p>}
    </article>
  );
}

function FloatJudgePath({ state }: { state: FloatState | null }) {
  const receipts = state?.receipts || [];
  const pointers = state?.proofPointers;
  const x402Receipt = pointers?.x402BoundReceipt || receipts.find((receipt) => receipt.x402);
  const debtReceipt = pointers?.debtReceipt || (x402Receipt?.requestHash
    ? receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED" && receipt.requestHash === x402Receipt.requestHash)
    : receipts.find((receipt) => receipt.receiptType === "DEBT_OPENED"));
  const repayReceipt = pointers?.repaymentReceipt || receipts.find((receipt) => receipt.receiptType === "REPAID");
  const overspendReceipt = pointers?.overspendReceipt || receipts.find((receipt) => receipt.receiptType === "SPEND_BLOCKED" && receipt.reason === "AMOUNT_TOO_HIGH");
  const denialReceipt = pointers?.denialReceipt || receipts.find((receipt) => receipt.receiptType === "CREDIT_DENIED");
  const latestExternalRun = (state?.loopRuns || []).find((run) => run.source === "external-signed" && run.requestHash);
  const links = [
    { label: "Open live proof", href: "/api/float" },
    { label: "Check reserve", href: "/api/float" },
    x402Receipt?.x402?.x402Hash ? { label: "Check x402 settlement", href: txUrl(x402Receipt.x402.x402Hash) } : null,
    x402Receipt?.x402?.bindingTxHash ? { label: "Check x402 bind", href: txUrl(x402Receipt.x402.bindingTxHash) } : null,
    debtReceipt?.transactionHash ? { label: "Check debt", href: txUrl(debtReceipt.transactionHash) } : null,
    repayReceipt?.transactionHash ? { label: "Check repayment", href: txUrl(repayReceipt.transactionHash) } : null,
    overspendReceipt?.transactionHash ? { label: "Check overspend block", href: txUrl(overspendReceipt.transactionHash) } : null,
    denialReceipt?.transactionHash ? { label: "Check denial", href: txUrl(denialReceipt.transactionHash) } : null,
    latestExternalRun?.requestHash ? { label: "Check signed external", href: `/api/float-tools?action=verify&hash=${latestExternalRun.requestHash}` } : null,
  ].filter((link): link is { label: string; href: string } => Boolean(link));
  return (
    <article className="floatJudgePath" aria-label="Judge verification path">
      <div className="floatBoxHeader">
        <span>judge path</span>
        <small>one-click checks plus command</small>
      </div>
      <div className="floatJudgeLinks">
        {links.map((link) => (
          <a href={link.href} target="_blank" rel="noreferrer" key={link.label}>
            {link.label}
          </a>
        ))}
      </div>
      <code>npm run float:verify-live</code>
    </article>
  );
}

function FloatStandingBoardPanel({
  board,
  alpha,
  beta,
  compact,
}: {
  board?: FloatStandingBoard;
  alpha?: Address;
  beta?: Address;
  compact: boolean;
}) {
  const agents = board?.agents || [];
  const visibleAgents = compact ? agents.slice(0, 3) : agents.slice(0, 8);
  const counts = board?.counts || {};
  const alphaApi = alpha ? `/api/float-tools?action=agent&address=${alpha}` : "/api/float";

  return (
    <article className="floatStandingBoard" aria-label="Shadow Float agent standing board">
      <div className="floatBoxHeader">
        <span>agent standing board</span>
        <small>
          {counts.invited || 0} invited · {counts["self-test"] || 0} self-test · {counts.lab || 0} lab · {counts.demo || 0} demo
        </small>
      </div>
      <div className="floatStandingIntro">
        <div>
          <strong>Behavior becomes queryable capacity.</strong>
          <p>Other agents can read standing before asking Shadow to front USDC for an x402 call.</p>
        </div>
        <a href={alphaApi} target="_blank" rel="noreferrer">
          Standing API
        </a>
      </div>
      <div className="floatStandingRows">
        {visibleAgents.length ? (
          visibleAgents.map((agent, index) => (
            <a
              className={`floatStandingRow ${agent.label}`}
              href={`/api/float-tools?action=agent&address=${agent.agent}`}
              key={agent.agent}
              target="_blank"
              rel="noreferrer"
            >
              <span className="floatStandingRank">#{index + 1}</span>
              <span className="floatStandingIdentity">
                <strong>{shortAddress(agent.agent)}</strong>
                <small>{agent.label}</small>
              </span>
              <span className="floatStandingStatus">{agent.status}</span>
              <span className="floatStandingMetric">
                <small>score</small>
                <strong>{agent.score}</strong>
              </span>
              <span className="floatStandingMetric">
                <small>line</small>
                <strong>{formatFloatUSDC(agent.creditLimitUSDC)}</strong>
              </span>
              <span className="floatStandingMetric">
                <small>available</small>
                <strong>{formatFloatUSDC(agent.availableCreditUSDC)}</strong>
              </span>
              <span className="floatStandingMetric">
                <small>debt</small>
                <strong>{formatFloatUSDC(agent.activeDebtUSDC)}</strong>
              </span>
            </a>
          ))
        ) : (
          <div className="floatStandingEmpty">Standing rows appear after the Float contract read returns agent lines.</div>
        )}
        {!compact && !counts.invited && (
          <div className="floatStandingExternalSlot">
            <span>invited slot</span>
            <strong>waiting for first builder line</strong>
            <small>Signed usage is counted separately only after a builder authorizes an x402 intent.</small>
          </div>
        )}
        {!compact && beta && !agents.some((agent) => agent.agent.toLowerCase() === beta.toLowerCase()) && (
          <a className="floatStandingRow demo" href={`/api/float-tools?action=agent&address=${beta}`} target="_blank" rel="noreferrer">
            <span className="floatStandingRank">demo</span>
            <span className="floatStandingIdentity">
              <strong>{shortAddress(beta)}</strong>
              <small>demo</small>
            </span>
            <span className="floatStandingStatus">queryable</span>
            <span className="floatStandingMetric">
              <small>API</small>
              <strong>open</strong>
            </span>
          </a>
        )}
      </div>
    </article>
  );
}

function FloatExternalSignedPanel({ state }: { state: FloatState | null }) {
  const externalRuns = (state?.loopRuns || []).filter((run) => run.source === "external-signed" && run.requestHash);
  const obolRuns = externalRuns.filter((run) => classifyExternalSignedRun(run).kind === "obol");
  const builderRuns = externalRuns.filter((run) => classifyExternalSignedRun(run).kind !== "obol");
  const sortedRuns = [...obolRuns, ...builderRuns];
  const summary = state?.sourceBreakdown?.externalSigned;
  const externalRepays = (state?.receipts || []).filter((receipt) => receipt.receiptType === "REPAID");

  return (
    <article className="floatExternalPanel" aria-label="External signed Shadow Float spends">
      <div className="floatBoxHeader">
        <span>external signed spends</span>
        <small>
          {summary?.cycles || 0} signed · {summary?.lifecycleClosedCount || 0} repaid ·{" "}
          {formatFloatUSDC(summary?.providerPaidUSDC)} USDC settled
        </small>
      </div>
      <div className="floatExternalIntro">
        <div>
          <strong>Outside agents sign; Shadow fronts the x402 payment.</strong>
          <p>
            These rows show spend intents signed against the live Float contract. Obol is shown separately as an arms-length
            buyer agent; other builder agents are labeled without partner language.
          </p>
        </div>
        <a href="/api/float" target="_blank" rel="noreferrer">
          Live API
        </a>
      </div>
      <div className="floatExternalRows">
        {sortedRuns.length ? (
          sortedRuns.map((run) => {
            const label = classifyExternalSignedRun(run);
            const requestHash = run.requestHash || "";
            const agent = run.agent || run.intent?.agent;
            const amount = run.amountUSDC || run.intent?.amountUSDC;
            const repayReceipt = agent
              ? externalRepays.find((receipt) => receipt.agent?.toLowerCase() === agent.toLowerCase())
              : undefined;
            const repayTxHash = run.repayTxHash || repayReceipt?.transactionHash;
            return (
              <div className={`floatExternalRow ${label.kind}`} key={requestHash || run.id}>
                <div className="floatExternalIdentity">
                  <span>{label.eyebrow}</span>
                  <strong>{label.title}</strong>
                  <small>{agent ? shortAddress(agent) : "agent hidden"}</small>
                </div>
                <div className="floatExternalReason">
                  <strong>{run.outcome || "SIGNED"}</strong>
                  <p>{run.intent?.reason || run.reason || "Signed external Float intent."}</p>
                </div>
                <div className="floatExternalAmount">
                  <span>amount</span>
                  <strong>{formatFloatUSDC(amount)} USDC</strong>
                  <small>{repayTxHash ? "debt repaid · line restored" : "debt open unless repaid separately"}</small>
                </div>
                <div className="floatExternalLinks">
                  {requestHash && (
                    <a href={`/api/float-tools?action=verify&hash=${requestHash}`} target="_blank" rel="noreferrer">
                      verify {shortHash(requestHash)}
                    </a>
                  )}
                  {run.x402Hash && (
                    <a href={txUrl(run.x402Hash)} target="_blank" rel="noreferrer">
                      x402 {shortAddress(run.x402Hash)}
                    </a>
                  )}
                  {run.bindTxHash && (
                    <a href={txUrl(run.bindTxHash)} target="_blank" rel="noreferrer">
                      bind {shortAddress(run.bindTxHash)}
                    </a>
                  )}
                  {repayTxHash && (
                    <a href={txUrl(repayTxHash)} target="_blank" rel="noreferrer">
                      repay {shortAddress(repayTxHash)}
                    </a>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="floatExternalEmpty">
            Signed external spends appear here after an outside agent signs a Float intent and Shadow binds it onchain.
          </div>
        )}
      </div>
    </article>
  );
}

function classifyExternalSignedRun(run: FloatLoopRun): { kind: "obol" | "builder"; eyebrow: string; title: string } {
  const agent = (run.agent || run.intent?.agent || "").toLowerCase();
  const reason = (run.intent?.reason || run.reason || "").toLowerCase();
  if (agent === OBOL_SIGNER || reason.includes("obol")) {
    return { kind: "obol", eyebrow: "arms-length buyer agent", title: "Obol signed Float intent" };
  }
  return { kind: "builder", eyebrow: "invited builder agent", title: "External signed intent" };
}

function FloatLoopPanel({ state, compact }: { state: FloatState | null; compact: boolean }) {
  const summary = state?.sourceBreakdown?.agentLoop;
  const runs = state?.loopRuns || [];
  const latest = runs[0];
  const hasRuns = Boolean(summary?.cycles);

  return (
    <article className="floatLoopPanel" id="float-loop">
      <div className="floatBoxHeader">
        <span>autonomous float loop</span>
        <small>{hasRuns ? `${summary?.cycles || 0} labeled cycles` : "no scheduled cycle indexed"}</small>
      </div>
      <div className="floatLoopStats">
        <FloatFact label="agent-loop paid" value={`${summary?.paidCount || 0}`} />
        <FloatFact label="blocked" value={`${summary?.blockedCount || 0}`} />
        <FloatFact label="denied" value={`${summary?.deniedCount || 0}`} />
        <FloatFact label="repaid" value={`${summary?.repaidCount || 0}`} />
        <FloatFact label="skipped" value={`${summary?.skipCount || 0}`} />
        <FloatFact label="quote-only exits" value={`${summary?.fallbacks || 0}`} />
      </div>
      <div className="floatLoopSplit">
        <div>
          <span>agent-loop x402 settled</span>
          <strong>{formatFloatUSDC(summary?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>operator x402 settled</span>
          <strong>{formatFloatUSDC(state?.sourceBreakdown?.demoAdmin?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>signed external x402</span>
          <strong>{formatFloatUSDC(state?.sourceBreakdown?.externalSigned?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>assisted onboarding</span>
          <strong>{formatFloatUSDC(state?.sourceBreakdown?.assisted?.providerPaidUSDC)}</strong>
        </div>
      </div>
      {latest ? (
        <div className={`floatLoopLatest ${latest.outcome?.includes("BLOCK") || latest.outcome === "DENIED" ? "blocked" : ""}`}>
          <div>
            <span>{latest.action || "UNKNOWN"}</span>
            <strong>{latest.outcome || "pending"}</strong>
            <small>
              {latest.model || "model unknown"}
              {latest.fellBack ? " · conservative route" : ""}
            </small>
          </div>
          <p>{latest.rationale || "No rationale recorded."}</p>
          <div className="floatLoopLinks">
            {latest.x402Hash && (
              <a href={txUrl(latest.x402Hash)} target="_blank" rel="noreferrer">
                x402 {shortAddress(latest.x402Hash)}
              </a>
            )}
            {latest.bindTxHash && (
              <a href={txUrl(latest.bindTxHash)} target="_blank" rel="noreferrer">
                bind {shortAddress(latest.bindTxHash)}
              </a>
            )}
            {latest.repayTxHash && (
              <a href={txUrl(latest.repayTxHash)} target="_blank" rel="noreferrer">
                repay {shortAddress(latest.repayTxHash)}
              </a>
            )}
            {latest.txHash && (
              <a href={txUrl(latest.txHash)} target="_blank" rel="noreferrer">
                receipt {shortAddress(latest.txHash)}
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="floatLoopEmpty">
          The x402-bound proof is live. No scheduled agent-loop receipt is indexed yet.
        </div>
      )}
      {!compact && hasRuns && (
        <div className="floatLoopRunList">
          {runs.slice(0, 5).map((run, index) => (
            <div className="floatLoopRun" key={`${run.id || index}-${run.outcome || "run"}`}>
              <span>{run.action || "UNKNOWN"}</span>
              <strong>{run.outcome || "pending"}</strong>
              <small>{run.at ? new Date(run.at).toLocaleString() : "time pending"}</small>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function FloatHeadlineStat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`floatHeadlineStat${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function FloatMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`floatMetric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function FloatFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="floatFact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatFloatUSDC(value?: string | bigint | null): string {
  if (value === undefined || value === null || value === "") return "0";
  try {
    const raw = typeof value === "bigint" ? value : BigInt(value);
    return formatUSDC(raw);
  } catch {
    return "0";
  }
}

function shortHash(value?: string | null): string {
  if (!value || value.length < 14) return "pending";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function humanizeFloatKey(value: string): string {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}

function normalizeBytes32(hex: string): Hash {
  let v = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  v = v.toLowerCase();
  if (v.length > 64) v = v.slice(0, 64);
  if (v.length < 64) v = v.padStart(64, "0");
  return `0x${v}` as Hash;
}

async function switchToArc() {
  if (!window.ethereum) return;
  const arcTestnetParams = {
    chainId: "0x4cef52",
    chainName: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: ["https://rpc.testnet.arc.network"],
    blockExplorerUrls: ["https://testnet.arcscan.app"],
  };
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: arcTestnetParams.chainId }],
    });
  } catch (error: unknown) {
    const code = (error as { code?: number })?.code;
    const message = String((error as { message?: string })?.message || "").toLowerCase();
    if (code === 4902 || message.includes("unrecognized") || message.includes("add the chain")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [arcTestnetParams],
      });
      return;
    }
    throw error;
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <article className="card">
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function Header({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="sectionHeader">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function HowItWorks() {
  const steps = [
    {
      num: "01",
      tone: "policy",
      title: "Choose a source agent",
      body: "Browse source reputation from real onchain receipts. CatArb, LobsterRisk, MomentumOtter, each with public copy and block history.",
    },
    {
      num: "02",
      tone: "policy",
      title: "Set delegation policy",
      body: "Deposit USDC into the router. Set max per intent, daily cap, allowed asset, and minimum slippage. Your rules sit onchain, not in a backend.",
    },
    {
      num: "03",
      tone: "outcome",
      title: "Copy or refuse every intent, onchain",
      body: "When the source agent publishes, Shadow either copies the swap or refuses it with an onchain receipt that names the exact policy field. No surprises, no off chain matcher.",
    },
  ];
  return (
    <section className="howItWorks">
      <p className="eyebrow">how Shadow works</p>
      <h2 className="howTitle">Three steps from picking a source to a verifiable receipt.</h2>
      <div className="howSteps">
        {steps.map((step) => (
          <div className={`howStep howStep--${step.tone}`} key={step.num}>
            <span>{step.num}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FollowFlow({
  sources,
  selectedSource,
  onSelectSource,
  selectedPreset,
  onSelectPreset,
  depositAmount,
  onDepositChange,
  onFollow,
  following,
  action,
  account,
  userBalance,
  userFollows,
  connectWallet,
}: {
  sources: SourceAgent[];
  selectedSource: Address | null;
  onSelectSource: (address: Address) => void;
  selectedPreset: PresetKey;
  onSelectPreset: (key: PresetKey) => void;
  depositAmount: string;
  onDepositChange: (value: string) => void;
  onFollow: () => Promise<void>;
  following: boolean;
  action: ActionState;
  account?: Address;
  userBalance: bigint;
  userFollows: Set<string>;
  connectWallet: () => Promise<void>;
}) {
  const selectedName =
    sources.find((s) => s.address.toLowerCase() === selectedSource?.toLowerCase())?.name || "a source";
  const preset = PRESETS[selectedPreset];
  return (
    <section className="followFlow" id="start">
      <header className="followHeader">
        <p className="eyebrow">start following · web2-readable</p>
        <h2>Choose an agent. Set your risk. Done in four taps.</h2>
        <p className="lede">
          You stay in your own wallet. Shadow holds your USDC in escrow and only spends it when an agent&apos;s intent
          fits the rules you set. Raise or lower those rules whenever you want.
        </p>
      </header>

      <div className="followStep">
        <span className="stepNum">1</span>
        <div className="stepBody">
          <h3>Pick your agent</h3>
          <p className="stepHint">These are the live AI source agents on Arc. You can change later.</p>
          <div className="sourceChoices">
            {sources.length === 0 && <Empty text="No source agents registered yet." />}
            {sources.map((source) => {
              const isSelected = selectedSource?.toLowerCase() === source.address.toLowerCase();
              const isFollowed = userFollows.has(source.address.toLowerCase());
              return (
                <button
                  key={source.address}
                  className={`sourceChoice ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelectSource(source.address)}
                  type="button"
                >
                  <div className="sourceChoiceTop">
                    <strong>{source.name}</strong>
                    {isFollowed && <span className="sourceTag">following</span>}
                  </div>
                  <span className="sourceChoiceAddr">{shortAddress(source.address)}</span>
                  <span className="sourceChoiceMeta">
                    {source.followerCount.toString()} follow records · registry score {(source.reputationScore / 100).toFixed(0)}%
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="followStep">
        <span className="stepNum">2</span>
        <div className="stepBody">
          <h3>Pick your risk rule</h3>
          <p className="stepHint">This is the rule the router will check on every intent. Anything outside it gets blocked, on-chain.</p>
          <div className="presetChoices">
            {(Object.keys(PRESETS) as PresetKey[]).map((key) => {
              const p = PRESETS[key];
              const isSelected = selectedPreset === key;
              return (
                <button
                  key={key}
                  className={`presetChoice ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelectPreset(key)}
                  type="button"
                >
                  <strong>{p.label}</strong>
                  <span className="presetTagline">{p.tagline}</span>
                  <dl className="presetStats">
                    <div>
                      <dt>max/intent</dt>
                      <dd>{p.maxAmountPerIntent} USDC</dd>
                    </div>
                    <div>
                      <dt>daily cap</dt>
                      <dd>{p.dailyCap} USDC</dd>
                    </div>
                    <div>
                      <dt>min slippage</dt>
                      <dd>{p.minBpsOut} bps</dd>
                    </div>
                    <div>
                      <dt>max risk</dt>
                      <dd>L{p.maxRiskLevel}</dd>
                    </div>
                  </dl>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="followStep">
        <span className="stepNum">3</span>
        <div className="stepBody">
          <h3>Deposit USDC</h3>
          <p className="stepHint">
            This is the budget for mirroring. It sits in escrow until your rule lets an intent through. You can withdraw any
            unused balance any time. Need testnet USDC?{" "}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer noopener">
              Grab some from Circle&apos;s faucet
            </a>
            .
          </p>
          <div className="depositRow">
            <input
              className="depositInput"
              type="text"
              inputMode="decimal"
              value={depositAmount}
              onChange={(event) => onDepositChange(event.target.value)}
              placeholder="0.5"
            />
            <span className="depositUnit">USDC</span>
          </div>
        </div>
      </div>

      <div className="followSummary">
        <span className="followSummaryLabel">What you&apos;re about to do</span>
        <p className="followSummaryBody">
          Follow <strong>{selectedName}</strong> with the <strong>{preset.label.toLowerCase()}</strong> rule. Any of its
          intents up to <strong>{preset.maxAmountPerIntent} USDC</strong> per intent get copied to you. Anything over
          that, or anything riskier than <strong>L{preset.maxRiskLevel}</strong>, gets blocked on-chain.
        </p>
      </div>
      <div className="followAction">
        {!account ? (
          <button className="followCta" onClick={connectWallet} type="button">
            connect wallet to continue
          </button>
        ) : (
          <button className="followCta" onClick={onFollow} disabled={following} type="button">
            {following ? "submitting…" : `Follow ${selectedName} now`}
          </button>
        )}
        <div className={action.error ? "followStatus error" : "followStatus"}>
          <strong>{action.label}</strong>
          {action.tx && (
            <a href={txUrl(action.tx)} target="_blank" rel="noreferrer noopener">
              {shortAddress(action.tx)}
            </a>
          )}
          {action.error && <span>{action.error}</span>}
        </div>
        {account && (
          <div className="followWallet">
            <span>
              wallet <strong>{shortAddress(account)}</strong>
            </span>
            <span>
              router balance <strong>{formatUSDC(userBalance)} USDC</strong>
            </span>
            <span>
              following <strong>{userFollows.size}</strong> of {sources.length}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function ManagePanel({
  sources,
  userBalance,
  userFollows,
  withdrawAmount,
  onWithdrawChange,
  onWithdraw,
  onUnfollow,
  managing,
}: {
  sources: SourceAgent[];
  userBalance: bigint;
  userFollows: Set<string>;
  withdrawAmount: string;
  onWithdrawChange: (value: string) => void;
  onWithdraw: () => Promise<void>;
  onUnfollow: (source: Address) => Promise<void>;
  managing: boolean;
}) {
  const followedSources = sources.filter((source) => userFollows.has(source.address.toLowerCase()));
  return (
    <section className="managePanel">
      <header className="sectionHeader">
        <p className="eyebrow">manage your follows</p>
        <h2>Withdraw idle balance or stop mirroring a source.</h2>
      </header>

      <div className="manageGrid">
        <div className="manageCard">
          <p className="eyebrow">router balance</p>
          <strong className="manageBalance">{formatUSDC(userBalance)} USDC</strong>
          <p className="manageHint">Pull idle USDC back to your wallet at any time. Mirroring stops only when the source publishes more intents than your balance covers.</p>
          <div className="depositRow">
            <input
              className="depositInput"
              type="text"
              inputMode="decimal"
              value={withdrawAmount}
              onChange={(event) => onWithdrawChange(event.target.value)}
              placeholder={formatUSDC(userBalance)}
              disabled={managing || userBalance === 0n}
            />
            <span className="depositUnit">USDC</span>
          </div>
          <div className="manageActions">
            <button
              className="manageButton"
              type="button"
              onClick={() => onWithdrawChange(formatUSDC(userBalance))}
              disabled={managing || userBalance === 0n}
            >
              max
            </button>
            <button
              className="manageButton primary"
              type="button"
              onClick={onWithdraw}
              disabled={managing || userBalance === 0n}
            >
              {managing ? "submitting…" : "withdraw"}
            </button>
          </div>
        </div>

        <div className="manageCard">
          <p className="eyebrow">followed sources</p>
          <strong className="manageBalance">{followedSources.length} active</strong>
          <p className="manageHint">Unfollow flips the policy to inactive. The router skips that source for any later intent until you follow again.</p>
          <div className="unfollowList">
            {followedSources.length === 0 && <span className="empty">No active policies on this wallet.</span>}
            {followedSources.map((source) => (
              <div className="unfollowRow" key={source.address}>
                <div className="unfollowMeta">
                  <strong>{source.name}</strong>
                  <span>{shortAddress(source.address)}</span>
                </div>
                <button
                  className="manageButton"
                  type="button"
                  onClick={() => onUnfollow(source.address)}
                  disabled={managing}
                >
                  unfollow
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function LatestReasoningPanel({ data }: { data: ReasoningResponse | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  if (!data || !data.configured) {
    return null;
  }

  if (!data.packet) {
    return (
      <section className="reasoningPanel empty">
        <div className="reasoningHeader">
          <p className="eyebrow">latest agent reasoning</p>
          <h2>Waiting for the next cron tick.</h2>
        </div>
        <p className="reasoningEmpty">No reasoning packets stored yet. The next published intent will appear here with its full rationale and a content-derived intentHash you can verify on chain.</p>
      </section>
    );
  }

  const packet = data.packet;
  const secondsSince = Math.max(0, Math.floor(now / 1000 - packet.createdAt));
  const confidencePct = (packet.confidenceBps / 100).toFixed(2);
  const shortHash = `${packet.intentHash.slice(0, 10)}…${packet.intentHash.slice(-6)}`;
  return (
    <section className="reasoningPanel">
      <div className="reasoningHeader">
        <div>
          <p className="eyebrow">latest agent reasoning</p>
          <h2>{packet.sourceName} just published an intent.</h2>
        </div>
        <span className={`reasoningBadge ${packet.decision}`}>{packet.decision.toUpperCase()}</span>
      </div>
      <p className="reasoningRationale">{packet.rationale}</p>
      <dl className="reasoningGrid">
        <div>
          <dt>source</dt>
          <dd>{shortAddress(packet.sourceAgent as `0x${string}`)}</dd>
        </div>
        <div>
          <dt>intent hash</dt>
          <dd className="mono">{shortHash}</dd>
        </div>
        <div>
          <dt>amount</dt>
          <dd>{packet.amountUSDC} USDC</dd>
        </div>
        <div>
          <dt>min out</dt>
          <dd>{packet.minAmountOut} ARCETH</dd>
        </div>
        <div>
          <dt>live quote</dt>
          <dd>{packet.liveQuote} ARCETH</dd>
        </div>
        <div>
          <dt>confidence</dt>
          <dd>{confidencePct}%</dd>
        </div>
        <div>
          <dt>risk level</dt>
          <dd>L{packet.riskLevel}</dd>
        </div>
        <div>
          <dt>pool depth</dt>
          <dd>{packet.reserveUSDC} USDC</dd>
        </div>
      </dl>
      <p className="reasoningFooter">
        <span>created {secondsSince}s ago</span>
        <span className="mono">intentHash = keccak256(source, amount, minOut, liveQuote, risk, name, rationale)</span>
      </p>
    </section>
  );
}

type DerivedRefusal = {
  label: string;
  detail: string;
  rawReason: string;
};

function derivePilotRefusal(
  receipt: ReceiptLog,
  intent: IntentLog | undefined,
  reasoning: ReasoningResponse | null,
): DerivedRefusal | null {
  const packet = reasoning?.packet;
  if (receipt.status !== "blocked" || !intent || !packet) return null;
  if (packet.intentHash.toLowerCase() !== intent.intentHash.toLowerCase()) return null;
  if (receipt.reason === "insufficient balance") return null;

  return {
    label: pilotRefusalLabel(receipt.reason, packet.decision),
    detail: pilotRefusalDetail(receipt.reason, packet.rationale),
    rawReason: receipt.reason,
  };
}

function pilotRefusalLabel(rawReason: string, decision: ReasoningPacket["decision"]) {
  if (decision === "skip") return "Pilot veto: source intent skipped";
  if (rawReason === "slippage too tight") return "Pilot veto: live quote failed policy";
  if (rawReason === "amount too high" || rawReason === "daily cap exceeded") return "Pilot veto: follower budget rejected";
  if (rawReason === "risk too high") return "Pilot veto: risk tier rejected";
  return "Pilot-labeled refusal";
}

function pilotRefusalDetail(rawReason: string, rationale: string) {
  const cleanRationale = rationale.trim().replace(/\s+/g, " ");
  const trimmedRationale = cleanRationale.length > 116 ? `${cleanRationale.slice(0, 113)}...` : cleanRationale;
  return trimmedRationale || `Reasoning packet attached to this ${rawReason} receipt.`;
}

function LiveFeed({
  receipts,
  intents,
  closes,
  sourceNameByAddress,
  reasoning,
  latestBlock,
  fetchedAt,
  loading,
  totalReceipts,
  account,
  closingIntentId,
  onClosePosition,
}: {
  receipts: ReceiptLog[];
  intents: IntentLog[];
  closes: PositionCloseLog[];
  sourceNameByAddress: Map<string, string>;
  reasoning: ReasoningResponse | null;
  latestBlock: bigint;
  fetchedAt: number;
  loading: boolean;
  totalReceipts: number;
  account?: Address;
  closingIntentId: bigint | null;
  onClosePosition: (intentId: bigint) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "copied" | "blocked">("all");
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const secondsSince = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const accountKey = account?.toLowerCase();
  const closedByFollowerIntent = new Set(closes.map((close) => `${close.follower.toLowerCase()}:${close.intentId.toString()}`));
  const latestCloses = closes
    .slice()
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
    .slice(0, 4);

  const intentByKey = useMemo(() => {
    const map = new Map<string, IntentLog>();
    for (const intent of intents) {
      map.set(`${intent.sourceAgent.toLowerCase()}:${intent.intentId.toString()}`, intent);
    }
    return map;
  }, [intents]);

  const sourceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of receipts) {
      const key = r.sourceAgent.toLowerCase();
      if (!map.has(key)) map.set(key, sourceNameByAddress.get(key) || shortAddress(r.sourceAgent));
    }
    return Array.from(map.entries());
  }, [receipts, sourceNameByAddress]);

  const reasonOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of receipts) if (r.status === "blocked") set.add(r.reason);
    return Array.from(set);
  }, [receipts]);

  const filteredReceipts = useMemo(() => {
    return receipts.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (sourceFilter !== "all" && r.sourceAgent.toLowerCase() !== sourceFilter) return false;
      if (reasonFilter !== "all" && r.reason !== reasonFilter) return false;
      return true;
    });
  }, [receipts, statusFilter, sourceFilter, reasonFilter]);
  return (
    <section className="liveFeed" id="live-feed">
      <div className="liveFeedHeader">
        <div>
          <p className="eyebrow">
            <span className={`livePulse ${loading ? "loading" : ""}`} />
            recent-window activity · auto refresh
          </p>
          <h2>Recent onchain receipts across every source.</h2>
        </div>
        <div className="liveFeedMeta">
          <div>
            <dt>latest block</dt>
            <dd>{latestBlock ? latestBlock.toString() : "…"}</dd>
          </div>
          <div>
            <dt>last fetch</dt>
            <dd>{secondsSince}s ago</dd>
          </div>
          <div>
            <dt>window receipts</dt>
            <dd>{totalReceipts}</dd>
          </div>
        </div>
      </div>
      <div className="liveFeedFilters" role="group" aria-label="Receipt filters">
        <div className="liveFeedFilterGroup">
          <span className="liveFeedFilterLabel">Outcome</span>
          {(["all", "copied", "blocked"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              className={`liveFeedFilterBtn${statusFilter === opt ? " active" : ""}`}
              onClick={() => setStatusFilter(opt)}
            >
              {opt === "all" ? "all" : opt}
            </button>
          ))}
        </div>
        {sourceOptions.length > 1 && (
          <div className="liveFeedFilterGroup">
            <span className="liveFeedFilterLabel">Agent</span>
            <button
              type="button"
              className={`liveFeedFilterBtn${sourceFilter === "all" ? " active" : ""}`}
              onClick={() => setSourceFilter("all")}
            >
              all
            </button>
            {sourceOptions.map(([addr, name]) => (
              <button
                key={addr}
                type="button"
                className={`liveFeedFilterBtn${sourceFilter === addr ? " active" : ""}`}
                onClick={() => setSourceFilter(addr)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        {statusFilter !== "copied" && reasonOptions.length > 0 && (
          <div className="liveFeedFilterGroup">
            <span className="liveFeedFilterLabel">Block reason</span>
            <button
              type="button"
              className={`liveFeedFilterBtn${reasonFilter === "all" ? " active" : ""}`}
              onClick={() => setReasonFilter("all")}
            >
              all
            </button>
            {reasonOptions.map((reason) => (
              <button
                key={reason}
                type="button"
                className={`liveFeedFilterBtn${reasonFilter === reason ? " active" : ""}`}
                onClick={() => setReasonFilter(reason)}
              >
                {reason}
              </button>
            ))}
          </div>
        )}
        <span className="liveFeedFilterCount">
          {filteredReceipts.length} of {receipts.length}
        </span>
      </div>
      <div className="liveFeedList">
        {filteredReceipts.length === 0 && (
          <div className="empty">
            {receipts.length === 0
              ? "No receipts yet. Cron fires every 10 minutes."
              : "No receipts match these filters."}
          </div>
        )}
        {filteredReceipts.map((receipt, index) => {
          const sourceName = sourceNameByAddress.get(receipt.sourceAgent.toLowerCase()) || shortAddress(receipt.sourceAgent);
          const blocksAgo = latestBlock && receipt.blockNumber ? Number(latestBlock - receipt.blockNumber) : 0;
          const receiptKey = `${receipt.follower.toLowerCase()}:${receipt.intentId.toString()}`;
          const linkedIntent = intentByKey.get(`${receipt.sourceAgent.toLowerCase()}:${receipt.intentId.toString()}`);
          const pilotRefusal = derivePilotRefusal(receipt, linkedIntent, reasoning);
          const canClose =
            receipt.status === "copied" &&
            Boolean(accountKey) &&
            receipt.follower.toLowerCase() === accountKey &&
            !closedByFollowerIntent.has(receiptKey);
          const isFresh = index === 0;
          return (
            <article className={`liveFeedRow ${receipt.status}${isFresh ? " fresh" : ""}`} key={`${receipt.transactionHash}-${receipt.follower}`}>
              <span className={`liveBadge ${receipt.status}`}>{receipt.status === "copied" ? "COPIED" : "BLOCKED"}</span>
              <div className="liveFeedSource">
                <strong>{sourceName}</strong>
                <span>intent {receipt.intentId.toString()}</span>
              </div>
              <div className="liveFeedFollower">
                <span>follower</span>
                <strong>{shortAddress(receipt.follower)}</strong>
              </div>
              <div className="liveFeedAmount">
                {receipt.status === "copied" ? (
                  <>
                    <strong>{formatUSDC(receipt.usdcAmount)} USDC</strong>
                    <span>for {formatAsset(receipt.assetAmountOut)} ARCETH</span>
                    {receipt.gatewaySettlement?.status === "settled" && (
                      <span className="gatewaySettlementLine">
                        fee {receipt.gatewaySettlement.feeUSDC} USDC settled · Gateway
                      </span>
                    )}
                  </>
                ) : (
                  pilotRefusal ? (
                    <div className="refusalStack">
                      <strong className="pilotRefusalLabel">{pilotRefusal.label}</strong>
                      <span>{pilotRefusal.detail}</span>
                      <span className="rawOnchainReason">raw onchain reason: {pilotRefusal.rawReason}</span>
                    </div>
                  ) : (
                    <>
                      <strong>{receipt.reason}</strong>
                      <span>{formatUSDC(receipt.usdcAmount)} USDC requested</span>
                    </>
                  )
                )}
              </div>
              <a className="liveFeedAge" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer noopener">
                block {receipt.blockNumber.toString()}
                <span>{blocksAgo > 0 ? `${blocksAgo} blocks ago` : "just now"}</span>
              </a>
              {canClose && (
                <button
                  className="closePositionButton"
                  type="button"
                  onClick={() => onClosePosition(receipt.intentId)}
                  disabled={closingIntentId === receipt.intentId}
                >
                  {closingIntentId === receipt.intentId ? "closing..." : "close position"}
                </button>
              )}
            </article>
          );
        })}
      </div>
      <div className="closeFeed">
        <div className="closeFeedHeader">
          <p className="eyebrow">realized close loop</p>
          <h3>Copied positions can round trip back into router USDC.</h3>
        </div>
        {latestCloses.length === 0 ? (
          <div className="empty">No PositionClosed events yet. Close one copied receipt to complete the realized PnL loop.</div>
        ) : (
          <div className="closeFeedList">
            {latestCloses.map((close) => {
              const sourceName = sourceNameByAddress.get(close.sourceAgent.toLowerCase()) || shortAddress(close.sourceAgent);
              const pnl = Number(close.pnlBps) / 100;
              return (
                <article className="closeFeedRow" key={`${close.transactionHash}-${close.follower}-${close.intentId.toString()}`}>
                  <div>
                    <strong>{sourceName}</strong>
                    <span>intent {close.intentId.toString()} closed by {shortAddress(close.follower)}</span>
                  </div>
                  <div>
                    <strong>{formatUSDC(close.usdcIn)} → {formatUSDC(close.usdcOut)} USDC</strong>
                    <span className={pnl >= 0 ? "pnlPositive" : "pnlNegative"}>{pnl.toFixed(2)}% realized PnL</span>
                  </div>
                  <a href={txUrl(close.transactionHash)} target="_blank" rel="noreferrer noopener">
                    {shortAddress(close.transactionHash)}
                  </a>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function VerifyResultPanel({ result }: { result: VerifyResponse }) {
  const verdictClass = result.ok ? "pass" : "fail";
  return (
    <article className={`liveVerifyResult ${verdictClass}`}>
      <header className="liveVerifyVerdict">
        <strong>{result.ok ? "PASS" : "FAIL"}</strong>
        {result.cached && <span className="cached">cached · next run in {result.retryAfter}s</span>}
      </header>
      <dl className="liveVerifyMeta">
        <div>
          <dt>tx</dt>
          <dd>
            <a href={txUrl(result.tx)} target="_blank" rel="noreferrer noopener">
              {shortAddress(result.tx)}
            </a>
          </dd>
        </div>
        {result.intentHash && (
          <div>
            <dt>reasoning hash</dt>
            <dd>{shortAddress(result.intentHash)}</dd>
          </div>
        )}
        <div>
          <dt>block</dt>
          <dd>{result.blockNumber}</dd>
        </div>
        <div>
          <dt>amountUSDC</dt>
          <dd>{result.amountUSDC}</dd>
        </div>
        <div>
          <dt>live quote</dt>
          <dd>{result.liveQuote} ARCETH</dd>
        </div>
        <div>
          <dt>minAmountOut</dt>
          <dd>{result.minAmountOut} ARCETH</dd>
        </div>
      </dl>
      <div className="liveVerifyOutcomes">
        <div className={`liveOutcome ${result.followerA.status === "BLOCKED" ? "blocked" : "copied"}`}>
          <strong>Follower A · {result.followerA.status}</strong>
          <span>reason: {result.followerA.reason}</span>
          <span>scaled min {result.scaledMinA} ARCETH</span>
        </div>
        <div className={`liveOutcome ${result.followerB.status === "COPIED" ? "copied" : "blocked"}`}>
          <strong>Follower B · {result.followerB.status}</strong>
          <span>
            {result.followerB.status === "COPIED"
              ? `received ${result.followerB.assetOut} ARCETH`
              : `reason: ${result.followerB.reason}`}
          </span>
          <span>scaled min {result.scaledMinB} ARCETH</span>
        </div>
      </div>
    </article>
  );
}

function SpotlightCard({
  verdict,
  kind,
  label,
  follower,
  receipt,
  detail,
}: {
  verdict: "BLOCKED" | "COPIED";
  kind: "blocked" | "copied";
  label: string;
  follower: Address;
  receipt: ReceiptLog;
  detail: string;
}) {
  return (
    <article className={`spotlightCard ${kind}`}>
      <div className="spotlightCardStamp">
        <span className="spotlightCardStampMark">{kind === "copied" ? "✓" : "✕"}</span>
        <span className="spotlightCardStampText">{verdict}</span>
      </div>
      <p className="spotlightCardLabel">{label}</p>
      <p className="spotlightCardFollower">{shortAddress(follower)}</p>
      <dl className="spotlightStats">
        <div>
          <dt>amount</dt>
          <dd className="spotlightCardAmount">
            {kind === "copied" ? formatUSDC(receipt.usdcAmount) : "…"}
            {kind === "copied" && <span className="spotlightCardAmountUnit">USDC</span>}
          </dd>
        </div>
        {receipt.status === "copied" && (
          <div>
            <dt>asset out</dt>
            <dd>{formatAsset(receipt.assetAmountOut)} ARCETH</dd>
          </div>
        )}
        {receipt.status === "copied" && receipt.mirrorFeeUSDC > 0n && (
          <div>
            <dt>mirror fee</dt>
            <dd>{formatUSDC(receipt.mirrorFeeUSDC)} USDC</dd>
          </div>
        )}
        {receipt.status === "copied" && receipt.gatewaySettlement?.status === "settled" && (
          <div>
            <dt>Gateway</dt>
            <dd>{receipt.gatewaySettlement.feeUSDC} USDC settled</dd>
          </div>
        )}
        {receipt.status === "blocked" && (
          <div>
            <dt>rule fired</dt>
            <dd>{receipt.reason}</dd>
          </div>
        )}
      </dl>
      <p className="spotlightDetail">{detail}</p>
      <a className="spotlightLink" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer noopener">
        on-chain receipt · {shortAddress(receipt.transactionHash)} →
      </a>
    </article>
  );
}

function totalMirrored(receipts: ReceiptLog[]): bigint {
  return receipts.reduce((total, receipt) => total + receipt.usdcAmount, 0n);
}

function totalKickbacks(state: ShadowState | null): bigint {
  return state?.sources.reduce((total, source) => total + source.kickbackUSDC, 0n) || 0n;
}

function BuilderFeesBanner({ state }: { state: ShadowState | null }) {
  const totalFees = totalKickbacks(state);
  const sourceCount = state?.sources.length || 0;
  const topSource = useMemo(() => {
    if (!state) return null;
    return [...state.sources].sort((a, b) =>
      a.kickbackUSDC === b.kickbackUSDC ? 0 : a.kickbackUSDC < b.kickbackUSDC ? 1 : -1,
    )[0];
  }, [state]);
  return (
    <section className="builderFees">
      <div className="builderFeesMain">
        <p className="eyebrow">source fees accrued onchain</p>
        <h2>
          <span className="builderFeesAmount">{formatUSDC(totalFees)}</span>
          <span className="builderFeesUnit">USDC</span>
        </h2>
        <p className="builderFeesCaption">
          70% of every mirror fee accrues to the source agent that routed the flow, settled by{" "}
          <code>MirrorRouter</code> at the receipt event from {sourceCount === 1 ? "one source" : `${sourceCount} sources`}.
          No off-chain accounting.
        </p>
        <p className="builderFeesReference">
          Shadow calls these <strong>mirror fees</strong>: source agents that route useful intent flow earn a share of the routed fee at the same moment followers receive copied or blocked receipts.
        </p>
      </div>
      {topSource && totalFees > 0n && (
        <div className="builderFeesTop">
          <p>top earner</p>
          <strong>{topSource.name}</strong>
          <span>{formatUSDC(topSource.kickbackUSDC)} USDC</span>
        </div>
      )}
    </section>
  );
}

const PILOT_STAGES: Array<{ label: string; at: number }> = [
  { label: "Reading onchain reputation for every source agent", at: 0 },
  { label: "Asking deepseek to allocate your deposit across the best fits", at: 2.5 },
  { label: "Normalizing weights and matching presets to risk", at: 18 },
  { label: "Hashing decision and preparing onchain attestation", at: 22 },
];

function PilotThinking() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 120);
    return () => clearInterval(id);
  }, []);
  const cappedPct = Math.min(95, (elapsed / 25) * 100);
  const activeIdx = PILOT_STAGES.reduce((acc, st, i) => (elapsed >= st.at ? i : acc), 0);
  return (
    <div className="pilotThinking" role="status" aria-live="polite">
      <div className="pilotThinkingHeader">
        <span className="pilotThinkingDot" />
        <strong>Pilot is reasoning</strong>
        <span className="pilotThinkingClock">{elapsed.toFixed(1)}s</span>
      </div>
      <div className="pilotThinkingBar">
        <span style={{ width: `${cappedPct}%` }} />
      </div>
      <ol className="pilotThinkingSteps">
        {PILOT_STAGES.map((st, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <li
              key={st.label}
              className={`pilotThinkingStep ${done ? "done" : ""} ${active ? "active" : ""}`}
            >
              <span className="pilotThinkingMark" aria-hidden>
                {done ? "✓" : active ? "" : ""}
              </span>
              <span>{st.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="pilotThinkingNote">
        Bankr LLM round trips take 20 to 25 seconds for structured allocations. Heuristic fallback runs if the model
        stalls.
      </p>
    </div>
  );
}

function PilotCard({
  amount,
  onAmountChange,
  risk,
  onRiskChange,
  plan,
  loading,
  error,
  executing,
  onRun,
  onExecute,
  sourcesCount,
}: {
  amount: string;
  onAmountChange: (v: string) => void;
  risk: PilotRisk;
  onRiskChange: (v: PilotRisk) => void;
  plan: PilotPlan | null;
  loading: boolean;
  error: string | null;
  executing: boolean;
  onRun: () => Promise<void>;
  onExecute: () => Promise<void>;
  sourcesCount: number;
}) {
  const riskOptions: Array<{ key: PilotRisk; label: string; sub: string }> = [
    { key: "low", label: "Low", sub: "Conservative slices, single source." },
    { key: "balanced", label: "Balanced", sub: "Diversify across 2 sources." },
    { key: "high", label: "High", sub: "Up to 3 sources, aggressive presets." },
  ];
  return (
    <section className="pilot" id="pilot">
      <header className="pilotHeader">
        <p className="eyebrow">AI pilot</p>
        <h2>Tell the AI your size and risk. It picks, weights, and watches.</h2>
        <p className="pilotLede">
          The Pilot reads every source agent's onchain reputation, allocates your USDC across the best fits, and writes
          watch signals you can act on. You stop manually picking and become a depositor with a goal.
        </p>
      </header>

      <div className="pilotControls">
        <label className="pilotField">
          <span>Deposit (USDC)</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder="1"
          />
        </label>
        <div className="pilotRiskGroup" role="radiogroup" aria-label="Risk profile">
          {riskOptions.map((opt) => (
            <button
              key={opt.key}
              className={`pilotRiskOption ${risk === opt.key ? "selected" : ""}`}
              onClick={() => onRiskChange(opt.key)}
              type="button"
              role="radio"
              aria-checked={risk === opt.key}
            >
              <strong>{opt.label}</strong>
              <span>{opt.sub}</span>
            </button>
          ))}
        </div>
        <button
          className="pilotRunBtn"
          onClick={onRun}
          disabled={loading || sourcesCount === 0}
          type="button"
        >
          {loading ? "asking the pilot…" : plan ? "regenerate plan" : "generate plan"}
        </button>
      </div>

      {loading && <PilotThinking />}

      {error && <div className="pilotError">pilot error: {error}</div>}

      {plan && (
        <div className="pilotPlan">
          <div className="pilotPlanHeader">
            <p className="pilotHeadline">{plan.headline}</p>
            <div className="pilotMeta">
              <span className="pilotConfidence">
                confidence <strong>{(plan.confidenceBps / 100).toFixed(0)}%</strong>
              </span>
              <span className="pilotModel">
                {plan.fellBack ? "heuristic fallback" : `model · ${plan.model}`}
              </span>
            </div>
          </div>

          <p className="pilotRationale">{plan.rationale}</p>

          <div className="pilotAllocation">
            {plan.allocation.map((slice) => (
              <article className="pilotSlice" key={slice.sourceAddress}>
                <header>
                  <strong>{slice.name}</strong>
                  <span className="pilotSlicePct">{(slice.weightBps / 100).toFixed(0)}%</span>
                </header>
                <div className="pilotSliceBar">
                  <span style={{ width: `${slice.weightBps / 100}%` }} />
                </div>
                <dl>
                  <div>
                    <dt>allocate</dt>
                    <dd>{slice.amountUSDC || "0"} USDC</dd>
                  </div>
                  <div>
                    <dt>preset</dt>
                    <dd className={`pilotPreset pilotPreset--${slice.preset}`}>{slice.preset}</dd>
                  </div>
                </dl>
                {slice.reason && <p className="pilotSliceReason">{slice.reason}</p>}
              </article>
            ))}
          </div>

          {plan.watchSignals.length > 0 && (
            <div className="pilotWatch">
              <p className="eyebrow">watch signals · the pilot will revisit if</p>
              <ul>
                {plan.watchSignals.map((sig, i) => (
                  <li key={i}>{sig}</li>
                ))}
              </ul>
            </div>
          )}

          <footer className="pilotFooter">
            <div className="pilotDecision">
              <span className="eyebrow">decision hash</span>
              <code>{plan.decisionHash}</code>
            </div>
            <button
              className="pilotExecBtn"
              onClick={onExecute}
              disabled={executing || plan.allocation.length === 0}
              type="button"
            >
              {executing ? "executing plan…" : "execute plan onchain"}
            </button>
          </footer>

          {plan.fellBack && plan.fellBackReason && (
            <p className="pilotFallbackNote">
              LLM unavailable ({plan.fellBackReason}); allocation produced by deterministic heuristic. Set
              BANKR_LLM_KEY to enable model reasoning.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

type SourceHealth = {
  source: SourceAgent;
  status: "healthy" | "watch" | "stop";
  recentCopies: number;
  recentBlocks: number;
  recentCopyRateBps: number;
  recentPnlAvgBps: number | null;
  signals: string[];
};

const HEALTH_WINDOW = 8;

function assessFollowedSources(
  state: ShadowState,
  account: Address,
  userFollows: Set<string>,
): SourceHealth[] {
  const acct = account.toLowerCase();
  return state.sources
    .filter((src) => userFollows.has(src.address.toLowerCase()))
    .map((source) => {
      const srcKey = source.address.toLowerCase();
      const myReceipts = state.receipts
        .filter((r) => r.sourceAgent.toLowerCase() === srcKey && r.follower.toLowerCase() === acct)
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, HEALTH_WINDOW);
      const recentCopies = myReceipts.filter((r) => r.status === "copied").length;
      const recentBlocks = myReceipts.filter((r) => r.status === "blocked").length;
      const totalRecent = recentCopies + recentBlocks;
      const recentCopyRateBps = totalRecent === 0 ? 0 : Math.round((recentCopies / totalRecent) * 10_000);

      const myCloses = state.positionCloses.filter(
        (c) => c.sourceAgent.toLowerCase() === srcKey && c.follower.toLowerCase() === acct,
      );
      const recentCloses = myCloses
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, HEALTH_WINDOW);
      const recentPnlAvgBps =
        recentCloses.length === 0
          ? null
          : Number(recentCloses.reduce((sum, c) => sum + c.pnlBps, 0n)) / recentCloses.length;

      const signals: string[] = [];
      let status: SourceHealth["status"] = "healthy";

      if (totalRecent === 0) {
        signals.push(`No recent receipts in the last ${HEALTH_WINDOW} intents for your wallet on this source.`);
      } else if (recentCopyRateBps < 5_000) {
        status = "watch";
        signals.push(
          `Only ${(recentCopyRateBps / 100).toFixed(0)}% of recent intents copied for your policy. Loosen minBpsOut or raise daily cap.`,
        );
      }
      if (recentPnlAvgBps !== null) {
        if (recentPnlAvgBps < -200) {
          status = "stop";
          signals.push(
            `Recent realized PnL is ${recentPnlAvgBps.toFixed(0)} bps over ${recentCloses.length} closes. Consider unfollowing.`,
          );
        } else if (recentPnlAvgBps < 0) {
          status = "watch";
          signals.push(
            `Recent realized PnL is ${recentPnlAvgBps.toFixed(0)} bps over ${recentCloses.length} closes. Watch the next close.`,
          );
        }
      }

      return {
        source,
        status,
        recentCopies,
        recentBlocks,
        recentCopyRateBps,
        recentPnlAvgBps,
        signals,
      };
    });
}

function PilotMonitor({
  state,
  account,
  userFollows,
  plan,
  onRerun,
  loading,
}: {
  state: ShadowState;
  account: Address;
  userFollows: Set<string>;
  plan: PilotPlan | null;
  onRerun: () => Promise<void>;
  loading: boolean;
}) {
  const assessments = useMemo(
    () => assessFollowedSources(state, account, userFollows),
    [state, account, userFollows],
  );
  if (assessments.length === 0) return null;
  const anyWatch = assessments.some((a) => a.status !== "healthy");
  const planAge = plan ? Math.max(0, Math.floor(Date.now() / 1000) - plan.generatedAt) : null;
  return (
    <section className="pilotMonitor">
      <header className="pilotMonitorHeader">
        <div>
          <p className="eyebrow">AI monitor · fresh look at your follows</p>
          <h2>The pilot watches every source you follow against live state.</h2>
          <p className="pilotMonitorLede">
            Each card reweighs the last {HEALTH_WINDOW} intents and any closed positions touching your wallet. When a
            slice drifts off plan, the monitor flags it and offers a re evaluation that bakes the latest receipts back
            into the next pilot decision.
          </p>
        </div>
        <button
          className="pilotMonitorRerun"
          onClick={onRerun}
          disabled={loading}
          type="button"
        >
          {loading ? "re-evaluating…" : anyWatch ? "re-evaluate plan" : "ask for a fresh plan"}
        </button>
      </header>

      <div className="pilotMonitorGrid">
        {assessments.map((a) => (
          <article className={`pilotMonitorCard pilotMonitorCard--${a.status}`} key={a.source.address}>
            <header>
              <strong>{a.source.name}</strong>
              <span className={`pilotMonitorBadge pilotMonitorBadge--${a.status}`}>{statusLabel(a.status)}</span>
            </header>
            <dl>
              <div>
                <dt>recent copies</dt>
                <dd>
                  {a.recentCopies}
                  <span className="pilotMonitorMuted"> / {a.recentCopies + a.recentBlocks}</span>
                </dd>
              </div>
              <div>
                <dt>copy rate</dt>
                <dd>{a.recentCopies + a.recentBlocks === 0 ? "…" : `${(a.recentCopyRateBps / 100).toFixed(0)}%`}</dd>
              </div>
              <div>
                <dt>recent PnL avg</dt>
                <dd>{a.recentPnlAvgBps === null ? "…" : `${a.recentPnlAvgBps.toFixed(0)} bps`}</dd>
              </div>
            </dl>
            {a.signals.length > 0 && (
              <ul className="pilotMonitorSignals">
                {a.signals.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>

      {plan && planAge !== null && (
        <footer className="pilotMonitorFooter">
          <span>
            anchored plan ·{" "}
            <code>
              {plan.decisionHash.slice(0, 10)}…{plan.decisionHash.slice(-6)}
            </code>{" "}
            · {ageLabel(planAge)} ago · confidence {(plan.confidenceBps / 100).toFixed(0)}%
          </span>
        </footer>
      )}
    </section>
  );
}

function statusLabel(status: SourceHealth["status"]): string {
  if (status === "healthy") return "healthy";
  if (status === "watch") return "watch";
  return "stop";
}

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function SplitMomentFallback() {
  return (
    <section className="spotlight spotlight--fallback" id="split">
      <p className="eyebrow">adapter one · same intent · two outcomes</p>
      <h2>One source intent lands. Policy decides whether capital moves.</h2>
      <p className="spotlightSummary">
        A source agent on Arc just published a 0.02 USDC intent. Two followers were watching with different rules.
        One had room. One didn&apos;t. This is the original receipt pattern now extended into Float and protocol mandates.
      </p>
      <div className="spotlightGrid">
        <article className="spotlightCard copied spotlightCard--demo">
          <div className="spotlightCardStamp">
            <span className="spotlightCardStampMark">✓</span>
            <span className="spotlightCardStampText">COPIED</span>
          </div>
          <p className="spotlightCardLabel">Copied follower · policy let it through</p>
          <p className="spotlightCardFollower">0x7A3F…3AcD</p>
          <dl className="spotlightStats">
            <div>
              <dt>amount</dt>
              <dd className="spotlightCardAmount">0.02 <span className="spotlightCardAmountUnit">USDC</span></dd>
            </div>
            <div>
              <dt>max per intent</dt>
              <dd>0.05 USDC</dd>
            </div>
            <div>
              <dt>slippage rule</dt>
              <dd>≥ 70 bps out</dd>
            </div>
          </dl>
          <p className="spotlightDetail">Within size, slippage, and daily cap. Swap went through, receipt on chain.</p>
        </article>
        <div className="spotlightVs" aria-hidden="true">
          <span className="spotlightVsLine" />
          <span className="spotlightVsLabel">VS</span>
          <span className="spotlightVsLine" />
        </div>
        <article className="spotlightCard blocked spotlightCard--demo">
          <div className="spotlightCardStamp">
            <span className="spotlightCardStampMark">✕</span>
            <span className="spotlightCardStampText">BLOCKED</span>
          </div>
          <p className="spotlightCardLabel">Blocked follower · policy refused</p>
          <p className="spotlightCardFollower">0x495c…8695</p>
          <dl className="spotlightStats">
            <div>
              <dt>amount</dt>
              <dd className="spotlightCardAmount">…</dd>
            </div>
            <div>
              <dt>max per intent</dt>
              <dd>0.01 USDC</dd>
            </div>
            <div>
              <dt>rule fired</dt>
              <dd>amount_too_high</dd>
            </div>
          </dl>
          <p className="spotlightDetail">Block receipt on chain, no debit. Follower stays exactly where they were.</p>
        </article>
      </div>
      <p className="spotlightFootnote">
        Live receipts populate this card once the next cron fires. The block reason on real receipts is whichever rule your
        policy hit first.
      </p>
    </section>
  );
}

function Shadow2ProofStrip({
  floatState,
  leptonState,
  copiedCount,
  blockedCount,
}: {
  floatState: FloatState | null;
  leptonState: LeptonState | null;
  copiedCount: number;
  blockedCount: number;
}) {
  const agentLoop = floatState?.sourceBreakdown?.agentLoop;
  const mirrorLoaded = copiedCount + blockedCount > 0;
  const cards = [
    {
      label: "Shadow Float",
      metric: agentLoop?.cycles !== undefined ? `${agentLoop.cycles}` : "syncing",
      unit: "agent-loop cycles",
      title: "Behavior becomes spending power",
      body: "A verified agent receives a bounded USDC spending line, buys approved x402 resources, opens debt, and gets blocked when it overreaches.",
      to: "/float",
      tone: "float",
    },
    {
      label: "Mandate Engine",
      metric: leptonState?.receiptCount !== undefined ? leptonState.receiptCount.toString() : "syncing",
      unit: "mandate receipts",
      title: "Capital moves only after policy clears",
      body: "The same engine gates swap-style and vault-style actions with ALLOW/BLOCK receipts and bonded enforcement.",
      to: "/lepton",
      tone: "mandate",
    },
    {
      label: "Mirror Adapter",
      metric: mirrorLoaded ? `${copiedCount}/${blockedCount}` : "syncing",
      unit: "copied / blocked",
      title: "The first production-style proof",
      body: "Copy trading stays visible as historical demand proof: one source intent, per-user policy, no cascade revert.",
      to: "/receipts",
      tone: "mirror",
    },
  ];

  return (
    <section className="shadow2Strip" aria-label="Shadow 2.0 proof surfaces">
      <div className="shadow2StripHeader">
        <p className="eyebrow">Shadow Float proof map</p>
        <h2>The Float product, with prior proof surfaces underneath.</h2>
      </div>
      <div className="shadow2StripGrid">
        {cards.map((card) => (
          <Link className={`shadow2ProofCard shadow2ProofCard--${card.tone}`} to={card.to} key={card.label}>
            <span className="shadow2ProofLabel">{card.label}</span>
            <strong className="shadow2ProofMetric">{card.metric}</strong>
            <span className="shadow2ProofUnit">{card.unit}</span>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
            <span className="shadow2ProofLink">open proof →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function ShadowMark() {
  return (
    <svg className="shadowMark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" className="shadowMarkBack" />
      <rect x="11" y="11" width="16" height="16" rx="2" className="shadowMarkFront" />
      <rect x="15" y="15" width="8" height="8" className="shadowMarkCore" />
    </svg>
  );
}

function HeroDiagram() {
  return (
    <div className="heroLedger" aria-hidden="true">
      <div className="heroLedgerHeader">
        <span className="heroLedgerHeaderTitle">
          <span className="heroLedgerHeaderDot" />
          Shadow Float · live path
        </span>
        <span className="heroLedgerLive">
          <span className="heroLedgerLiveDot" />
          Arc · x402 bound
        </span>
      </div>

      <div className="heroLedgerIntent">
        <span className="heroLedgerIntentLabel">Agent request</span>
        <div className="heroLedgerIntentBody">
          <span className="agentTag">Obol</span>
          <span className="heroLedgerIntentVerb">buy</span>
          <span className="heroLedgerIntentNumber">x402 data</span>
          <span className="heroLedgerIntentArrow">→</span>
          <span className="heroLedgerIntentNumber">0.01&nbsp;USDC</span>
        </div>
      </div>

      <div className="heroLedgerSplit">
        <div className="heroLedgerCell copied">
          <div className="heroLedgerCellHead">
            <span className="heroLedgerCellStatus">
              <span className="heroLedgerCellDot" />
              PAID
            </span>
            <span className="heroLedgerCellAddr">x402 provider</span>
          </div>
          <div className="heroLedgerCellMain">+0.01</div>
          <div className="heroLedgerCellUnit">USDC settled to provider</div>
          <div className="heroLedgerCellMeta">
            <span className="heroLedgerCellMetaLabel">receipt</span>
            <span className="heroLedgerCellMetaValue">x402 hash bound · debt opened · mandate still valid</span>
          </div>
        </div>
        <div className="heroLedgerCell blocked">
          <div className="heroLedgerCellHead">
            <span className="heroLedgerCellStatus">
              <span className="heroLedgerCellDot" />
              BLOCKED
            </span>
            <span className="heroLedgerCellAddr">premium request</span>
          </div>
          <div className="heroLedgerCellMain">0.00</div>
          <div className="heroLedgerCellUnit">USDC moved from treasury</div>
          <div className="heroLedgerCellMeta">
            <span className="heroLedgerCellMetaLabel">policy rule</span>
            <span className="heroLedgerCellMetaValue">amount&nbsp;&gt;&nbsp;line · blocked before spend</span>
          </div>
        </div>
      </div>

      <div className="heroLedgerProof">
        <span className="heroLedgerProofLabel">Float receipt</span>
        <span className="heroLedgerProofHash">external signature + x402 + debt</span>
        <span className="heroLedgerProofSep" />
        <span className="heroLedgerProofChain">chain&nbsp;5042002</span>
        <span className="heroLedgerProofVerify">verified onchain</span>
      </div>
    </div>
  );
}

function SiteFooter() {
  const sections: Array<{ title: string; links: Array<{ label: string; href: string }> }> = [
    {
      title: "Product",
      links: [
        { label: "Home", href: "/" },
        { label: "Shadow Float", href: "/float" },
        { label: "Treasury / M1", href: "/treasury" },
        { label: "Roadmap", href: "/roadmap" },
      ],
    },
    {
      title: "Verify",
      links: [
        { label: "Proof page", href: "/proof" },
        { label: "Live API", href: "/api/float" },
        { label: "Arc explorer", href: "https://testnet.arcscan.app" },
      ],
    },
    {
      title: "Builders",
      links: [
        { label: "Builder guide", href: "/builders" },
        { label: "Standing API", href: "/api/float" },
        { label: "Source on GitHub", href: "https://github.com/dolepee/shadow" },
      ],
    },
    {
      title: "Prior Shadow",
      links: [
        { label: "Archive", href: "/archive" },
        { label: "Agent history", href: "/agents" },
        { label: "Mandate engine", href: "/lepton" },
      ],
    },
  ];

  return (
    <footer className="siteFooter">
      <div className="siteFooterTop">
        <div className="siteFooterBrand">
          <Link className="brand brandFooter" to="/" aria-label="Shadow">
            <ShadowMark />
            <span>Shadow</span>
          </Link>
          <p className="siteFooterTagline">
            Behavior-backed x402 spending lines on Arc, with a verified Treasury/M1 mandate extension.
          </p>
          <div className="siteFooterBadge">
            <span className="heroBadgeDot" />
            live on arc testnet · chain 5042002
          </div>
        </div>
        <div className="siteFooterColumns">
          {sections.map((s) => (
            <div className="siteFooterColumn" key={s.title}>
              <span className="siteFooterColumnTitle">{s.title}</span>
              {s.links.map((l) => {
                if (l.href.startsWith("http") || l.href.startsWith("/api")) {
                  return (
                    <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                    </a>
                  );
                }
                return (
                  <Link key={l.label} to={l.href}>
                    {l.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="siteFooterBottom">
        <span>Built for Canteen × Circle Lepton · 2026</span>
        <span>Shadow Float · Treasury/M1 is the verified extension</span>
      </div>
    </footer>
  );
}

function HomeProofOverview({
  state,
  loading,
  error,
}: {
  state: FloatState | null;
  loading: boolean;
  error: string | null;
}) {
  const externalSigned = state?.sourceBreakdown?.externalSigned;
  const externalRepay = state?.receipts?.find(
    (receipt) =>
      receipt.receiptType === "REPAID" &&
      receipt.agent?.toLowerCase() !== state.alpha?.toLowerCase() &&
      receipt.agent?.toLowerCase() !== state.beta?.toLowerCase(),
  );
  const proofChecks = state?.proofChecks || {};
  const greenChecks = Object.values(proofChecks).filter((value) => value === true).length;
  const totalChecks = Object.values(proofChecks).filter((value) => typeof value === "boolean").length;
  const latestExternalVerify = state?.proofPointers?.latestExternalVerify;
  const x402Hash = state?.proofPointers?.x402BoundReceipt?.x402?.x402Hash || state?.walletProof?.x402Hash;
  const repayHash = externalRepay?.transactionHash || state?.proofPointers?.repaymentReceipt?.transactionHash;
  const lifecycleClosedCount = externalSigned?.lifecycleClosedCount ?? (externalRepay ? 1 : 0);
  const loaded = Boolean(state?.configured);

  const cards = [
    {
      eyebrow: "external signed use",
      value: loaded ? `${externalSigned?.cycles ?? 0}` : "live",
      label: "signed x402 spends",
      body: "Builders sign intents with their own agents; Shadow fronts the provider payment and binds the receipt.",
      href: latestExternalVerify?.verifyUrl || "/proof",
      external: Boolean(latestExternalVerify?.verifyUrl),
    },
    {
      eyebrow: "repay lifecycle",
      value: loaded ? `${lifecycleClosedCount}` : "syncing",
      label: lifecycleClosedCount === 1 ? "external lifecycle closed" : "external lifecycles closed",
      body: lifecycleClosedCount
        ? "Signed external agents repaid their Float debt and restored their full lines onchain."
        : "Borrow, spend, and repay are indexed as separate receipts so the lifecycle is auditable.",
      href: repayHash ? txUrl(repayHash) : "/proof",
      external: Boolean(repayHash),
    },
    {
      eyebrow: "proof checks",
      value: totalChecks ? `${greenChecks}/${totalChecks}` : "green",
      label: "live verifier checks",
      body: "Reserve, receipt count, x402 bind, debt, repayment, overspend, and denial checks are exposed through the API.",
      href: "/proof",
    },
    {
      eyebrow: "contract receipts",
      value: loaded ? state?.receiptCount || "0" : "syncing",
      label: "indexed receipts",
      body: "Every grant, spend, fee, debt, block, denial, and repayment is read from Arc testnet logs.",
      href: x402Hash ? txUrl(x402Hash) : "/api/float",
      external: Boolean(x402Hash),
    },
  ];

  return (
    <section className="homeProofOverview" aria-label="Shadow Float live product proof">
      <div className="homeProofHeader">
        <div>
          <p className="eyebrow">live product proof</p>
          <h2>External agents can spend first, then settle the debt trail.</h2>
        </div>
        <div className={`homeProofStatus ${error ? "error" : loading ? "syncing" : "live"}`}>
          <span className="homeProofStatusDot" />
          {error ? "proof API degraded" : loading ? "syncing live receipts" : "proof API live"}
        </div>
      </div>
      <div className="homeProofGrid">
        {cards.map((card) => {
          const content = (
            <>
              <span>{card.eyebrow}</span>
              <strong>{card.value}</strong>
              <em>{card.label}</em>
              <p>{card.body}</p>
            </>
          );
          return card.external ? (
            <a className="homeProofCard" href={card.href} target="_blank" rel="noreferrer" key={card.eyebrow}>
              {content}
            </a>
          ) : (
            <Link className="homeProofCard" to={card.href} key={card.eyebrow}>
              {content}
            </Link>
          );
        })}
      </div>
      <div className="homeProofLinks">
        <Link to="/proof">Open proof page</Link>
        <a href="/api/float" target="_blank" rel="noreferrer">Read live API</a>
        <a href="https://github.com/dolepee/shadow" target="_blank" rel="noreferrer">View repository</a>
      </div>
    </section>
  );
}

function HeroMetrics({ state }: { state: FloatState | null }) {
  const externalSigned = state?.sourceBreakdown?.externalSigned;
  const items: Array<{ label: string; value: string }> = [
    { label: "signed external draws", value: (externalSigned?.cycles || 0).toLocaleString() },
    { label: "x402 provider paid", value: `${formatFloatUSDC(state?.totalProviderPaidUSDC)} USDC` },
    { label: "active debt", value: `${formatFloatUSDC(state?.totalDebtOpenedUSDC ? BigInt(state.totalDebtOpenedUSDC) - BigInt(state.totalRepaidUSDC || "0") : undefined)} USDC` },
    { label: "Float receipts", value: state?.receiptCount?.toString() ?? "0" },
  ];

  const hasLiveData = Boolean(state?.configured) && Boolean(state?.receiptCount && Number(state.receiptCount) > 0);

  if (!hasLiveData) {
    return (
      <div className="heroMetrics heroMetrics--syncing" role="group" aria-label="Syncing live Arc data">
        <span className="heroMetricsSyncDot" />
        <span className="heroMetricsSyncLabel">Live Float receipts</span>
        <span className="heroMetricsSyncHint">syncing x402, debt, block, and repayment receipts on chain 5042002</span>
      </div>
    );
  }

  return (
    <div className="heroMetricsWrap" role="group" aria-label="Live Shadow Float numbers from Arc testnet">
      <div className="heroMetrics">
        {items.map((m) => (
          <div className="heroMetric" key={m.label}>
            <span className="heroMetricValue">{m.value}</span>
            <span className="heroMetricLabel">{m.label}</span>
          </div>
        ))}
      </div>
      <span className="heroMetricsNote">
        live from the ShadowFloat contract and Arc receipt logs; testnet fee mechanics, not revenue claims
      </span>
    </div>
  );
}

function TractionStrip({ state }: { state: ShadowState | null }) {
  const metrics = state?.lifetime;
  const recent = state?.recentWindow;

  const metricsList: Array<{ label: string; value: string; sub: string }> = [
    {
      label: "Follower wallets",
      value: metrics?.followerWallets.toLocaleString() ?? "0",
      sub: "since launch, snapshot-anchored",
    },
    {
      label: "USDC mirrored",
      value: metrics ? formatUSDC(metrics.mirroredUsdcAtomic) : "0",
      sub: `${metrics?.copied.toLocaleString() ?? "0"} copied · ${metrics?.blocked.toLocaleString() ?? "0"} blocked`,
    },
    {
      label: "Source agents",
      value: metrics?.sourceAgents.toLocaleString() ?? "0",
      sub: "registered source agents",
    },
    {
      label: "Receipts onchain",
      value: metrics?.receipts.toLocaleString() ?? "0",
      sub: "copy and block, no offchain truth",
    },
    {
      label: "Positions closed",
      value: metrics?.closedPositions.toLocaleString() ?? "0",
      sub: "realized close receipts",
    },
  ];

  const hasAnyTraction = Boolean(metrics && metrics.receipts > 0);

  if (!hasAnyTraction) {
    return null;
  }

  return (
    <section className="traction" aria-label="Live traction">
      <div className="tractionHeader">
        <p className="eyebrow">the full picture · lifetime floor plus live deltas</p>
        <span className="tractionDot" /> <span className="tractionLive">snapshot anchored</span>
      </div>
      <div className="tractionGrid">
        {metricsList.map((m) => (
          <article className="tractionCard" key={m.label}>
            <span className="tractionLabel">{m.label}</span>
            <strong className="tractionValue">{m.value}</strong>
            <span className="tractionSub">{m.sub}</span>
          </article>
        ))}
      </div>
      <p className="tractionFootnote">
        Lifetime totals use the May 24, 2026 submission snapshot as a floor, then add receipts after block{" "}
        {metrics?.snapshotBlock}. The live feed is intentionally recent-window only
        {recent
          ? ` (${recent.receipts.toLocaleString()} receipts from blocks ${recent.fromBlock}-${recent.toBlock}${
              recent.historyTruncated ? ", pruned history hidden" : ""
            })`
          : ""}
        .
      </p>
    </section>
  );
}

function TechnicalPrimitive({ state }: { state: ShadowState | null }) {
  const copiedReceipts = state?.receipts.filter((r) => r.status === "copied").length || 0;
  const blockedReceipts = state?.receipts.filter((r) => r.status === "blocked").length || 0;
  const closedPositions = state?.positionCloses.length || 0;
  const sourcesRegistered = state?.sources.length || 0;
  const cards = [
    {
      eyebrow: "primitive · per follower slippage",
      title: "Two outcomes, one transaction",
      body: "Every follower carries their own minBpsOut policy onchain. The router fans out one source intent and decides copy or block per follower in the same call. No cascade reverts, no off chain matcher.",
      metric: `${copiedReceipts} copied · ${blockedReceipts} blocked`,
      contract: "ShadowRouter.fanOut",
    },
    {
      eyebrow: "primitive · ERC 8004-style source reference",
      title: "Source agents are first class onchain",
      body: "Each source agent registers an onchain identity with a public address, name, and fee split. Reputation is computable from chain state alone, no centralized leaderboard.",
      metric: `${sourcesRegistered} source agent${sourcesRegistered === 1 ? "" : "s"} registered`,
      contract: "ShadowRegistry.registerSource",
    },
    {
      eyebrow: "primitive · canonical receipts",
      title: "MirrorReceipt is the source of truth",
      body: "Both copied and blocked outcomes emit onchain receipts with usdcAmount, minBps applied, and the kickback paid. Every decision is independently verifiable by reading chain state.",
      metric: `${copiedReceipts + blockedReceipts} receipts indexed`,
      contract: "MirrorReceipt event",
    },
    {
      eyebrow: "primitive · onchain PnL",
      title: "PositionClosed carries pnlBps",
      body: "When a follower closes a mirrored position, the router emits PositionClosed with the realized pnlBps. Source agent track records resolve directly from chain logs.",
      metric: `${closedPositions} position${closedPositions === 1 ? "" : "s"} closed`,
      contract: "PositionClosed event",
    },
  ];
  return (
    <section className="primitive" id="technical">
      <header className="primitiveHeader">
        <p className="eyebrow">why Shadow</p>
        <h2>The novelty is the reusable receipt engine, not the adapter.</h2>
        <p className="primitiveLede">
          The original router turns one AI intent into per-follower outcomes, but Shadow 2.0 carries the same pattern into
          float, x402 spend control, and protocol mandates. Every surface below is useful because it creates verifiable
          behavior that later capital can trust.
        </p>
      </header>
      <div className="primitiveGrid">
        {cards.map((card) => (
          <article className="primitiveCard" key={card.title}>
            <p className="eyebrow">{card.eyebrow}</p>
            <h3>{card.title}</h3>
            <p className="primitiveBody">{card.body}</p>
            <footer className="primitiveFooter">
              <span className="primitiveMetric">{card.metric}</span>
              <code className="primitiveContract">{card.contract}</code>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function LeptonM1Panel({
  state,
  loading,
  error,
  compact = false,
}: {
  state: LeptonState | null;
  loading: boolean;
  error: string | null;
  compact?: boolean;
}) {
  const configured = Boolean(isLeptonConfigured && state?.configured);
  const addressRows = [
    { label: "MandateRegistry", value: leptonAddresses.mandateRegistry },
    { label: "MandateAttestor", value: leptonAddresses.mandateAttestor },
    { label: "BondedEnforcer", value: leptonAddresses.bondedEnforcer },
    { label: "V4StyleArcAdapter", value: leptonAddresses.v4StyleAdapter },
    { label: "MandateVaultSink", value: state?.liquiditySink },
    { label: "MorphoStyleAdapter", value: leptonAddresses.morphoStyleAdapter },
    { label: "MorphoVaultSink", value: state?.morphoVaultSink },
  ];
  const proofSteps = [
    "Circle wallet is the scoped capital account",
    "MandateRegistry checks USDC, target, size, day cap, risk, expiry, and slippage",
    "MandateAttestor records ALLOW or BLOCK against the action hash",
    "V4StyleArcAdapter is swap-only and moves USDC only after an ALLOW receipt",
    "MandateVaultSink records the receipt-linked deposit",
    "Committed missing receipts can be challenged against the enforcer bond",
  ];
  const adapterSurfaces = [
    {
      name: "Uniswap v4-style swaps",
      status: configured ? "live proof" : "deploy pending",
      detail: "Pool-key execution refs bind currency pair, fee tier, tick spacing, hooks, and route salt.",
    },
    {
      name: "Morpho-style vault deposits",
      status: configured && state?.morphoConfigured ? "live proof" : "deploy pending",
      detail: "Deposit-only adapter gates USDC before vault movement through the same bonded enforcer.",
    },
  ];
  const circlePasskeyProof = {
    smartAccount: "0x6994ebdef63aa0e665e3c781ed54e2e181869a7a" as Address,
    txHash: "0x98b8b175d4ec8bf6d457d653383932e69d74300bd0b8a7e324e0cae3ac35a529" as `0x${string}`,
    mandateId: "2",
    amount: "0.01 USDC",
  };
  const morphoProof = {
    adapter: "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5" as Address,
    vault: "0x110f79c5617797b199d3d6e2abb855c34fbc5e58" as Address,
    mandateId: "3",
    allowTx: "0x9836e74ee95907847fac464f3a65554cf314adab9efe7141f4644022b3e09c17" as `0x${string}`,
    blockTx: "0x7d3dddd89dc50ea5b410564c7f1134ce1350fd3687e8cefec74192d9e9b4bd23" as `0x${string}`,
  };
  const updated = state ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <section className={`leptonPanel${compact ? " leptonPanelCompact" : ""}`} id="lepton-m1">
      <div className="leptonHeader">
        <div>
          <p className="eyebrow">Lepton M1 · protocol mandates</p>
          <h2>Mandates decide before USDC moves.</h2>
          <p className="leptonLede">
            The reusable primitive is simple: register a mandate, evaluate the action before USDC moves, write an ALLOW or
            BLOCK receipt, and keep the enforcer accountable across swap and vault-style adapters.
          </p>
        </div>
        <div className={`leptonStatus ${configured ? "configured" : "pending"}`}>
          <span className="leptonStatusDot" />
          {configured ? "live contract reads" : "deploy pending"}
          {loading && <small>syncing</small>}
        </div>
      </div>

      <div className="leptonMetricGrid">
        <LeptonMetric label="mandates" value={configured ? state!.mandateCount.toString() : "pending"} />
        <LeptonMetric label="receipts" value={configured ? state!.receiptCount.toString() : "pending"} />
        <LeptonMetric label="adapter bond" value={configured ? `${formatUSDC(state!.adapterBondUSDC)} USDC` : "pending"} />
        <LeptonMetric
          label="vault bond"
          value={
            configured && state!.morphoAdapterBondUSDC !== undefined
              ? `${formatUSDC(state!.morphoAdapterBondUSDC)} USDC`
              : "pending"
          }
        />
        <LeptonMetric label="minimum bond" value={configured ? `${formatUSDC(state!.minBondUSDC)} USDC` : "pending"} />
        <LeptonMetric label="allowed USDC" value={configured ? formatUSDC(state!.executedUSDC) : "0"} tone="allow" />
        <LeptonMetric
          label="vault recorded"
          value={configured && state!.vaultDepositedUSDC !== undefined ? formatUSDC(state!.vaultDepositedUSDC) : "pending"}
          tone="allow"
        />
        <LeptonMetric
          label="morpho allowed"
          value={configured && state!.morphoDepositedUSDC !== undefined ? formatUSDC(state!.morphoDepositedUSDC) : "pending"}
          tone="allow"
        />
        <LeptonMetric label="blocked USDC" value={configured ? formatUSDC(state!.blockedUSDC) : "0"} tone="block" />
        <LeptonMetric
          label="morpho blocked"
          value={configured && state!.morphoBlockedUSDC !== undefined ? formatUSDC(state!.morphoBlockedUSDC) : "pending"}
          tone="block"
        />
      </div>

      <div className="leptonGrid">
        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>contracts</span>
            {updated && <small>updated {updated}</small>}
          </div>
          <div className="leptonAddressList">
            {addressRows.map((row) => (
              <div className="leptonAddressRow" key={row.label}>
                <span>{row.label}</span>
                <code>{row.value ? shortAddress(row.value) : "not deployed"}</code>
              </div>
            ))}
          </div>
        </article>

        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>receipt chain</span>
            <small>{configured ? `next #${state!.nextReceiptId.toString()}` : "waiting for deploy"}</small>
          </div>
          <ol className="leptonProofList">
            {proofSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </article>

        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>protocol adapters</span>
            <small>one mandate engine</small>
          </div>
          <div className="leptonSurfaceList">
            {adapterSurfaces.map((surface) => (
              <div className="leptonSurfaceRow" key={surface.name}>
                <div>
                  <strong>{surface.name}</strong>
                  <p>{surface.detail}</p>
                </div>
                <code>{surface.status}</code>
              </div>
            ))}
          </div>
        </article>
      </div>

      {!compact && (
        <article className="leptonPasskeyProof">
          <div className="leptonBoxHeader">
            <span>Circle passkey proof</span>
            <small>sponsored UserOp</small>
          </div>
          <div className="leptonProofFacts">
            <div>
              <span>Smart account</span>
              <code title={circlePasskeyProof.smartAccount}>{shortAddress(circlePasskeyProof.smartAccount)}</code>
            </div>
            <div>
              <span>Mandate</span>
              <strong>#{circlePasskeyProof.mandateId}</strong>
            </div>
            <div>
              <span>Allowed</span>
              <strong>{circlePasskeyProof.amount}</strong>
            </div>
            <div>
              <span>Proof tx</span>
              <a href={txUrl(circlePasskeyProof.txHash)} target="_blank" rel="noreferrer">
                {shortAddress(circlePasskeyProof.txHash)}
              </a>
            </div>
          </div>
          <p>
            Circle Gas Station sponsored one passkey-owned account to approve USDC, create a Lepton mandate, and execute
            the allowed adapter action that raised the receipt count and vault-recorded USDC.
          </p>
        </article>
      )}

      {!compact && (
        <article className="leptonPasskeyProof">
          <div className="leptonBoxHeader">
            <span>Morpho-style vault proof</span>
            <small>live adapter</small>
          </div>
          <div className="leptonProofFacts">
            <div>
              <span>Adapter</span>
              <code title={morphoProof.adapter}>{shortAddress(morphoProof.adapter)}</code>
            </div>
            <div>
              <span>Mandate</span>
              <strong>#{morphoProof.mandateId}</strong>
            </div>
            <div>
              <span>Allowed / blocked</span>
              <strong>
                {configured && state!.morphoDepositedUSDC !== undefined && state!.morphoBlockedUSDC !== undefined
                  ? `${formatUSDC(state!.morphoDepositedUSDC)} / ${formatUSDC(state!.morphoBlockedUSDC)} USDC`
                  : "0.1 / 0.3 USDC"}
              </strong>
            </div>
            <div>
              <span>Proof txs</span>
              <a href={txUrl(morphoProof.allowTx)} target="_blank" rel="noreferrer">
                allow
              </a>
              {" / "}
              <a href={txUrl(morphoProof.blockTx)} target="_blank" rel="noreferrer">
                block
              </a>
            </div>
          </div>
          <p>
            The second protocol surface uses the same bonded enforcer as the v4-style adapter: one deposit-shaped action
            moved USDC after an ALLOW receipt, and one oversized deposit wrote a BLOCK receipt without moving funds.
          </p>
        </article>
      )}

      {error && <div className="leptonError">Lepton read failed: {error}</div>}

      {!compact && (
        <div className="leptonBoundaries">
          <span>v4-style adapter, not a claimed Uniswap hook</span>
          <span>Morpho-style adapter, not a claimed Morpho partnership</span>
          <span>objective missing-receipt slashing only</span>
          <span>deterministic policy; no LLM override</span>
        </div>
      )}
    </section>
  );
}

function LeptonMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`leptonMetric${tone ? ` ${tone}` : ""}`}>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function score(value: number): string {
  return `${(value / 100).toFixed(0)}%`;
}

type TraderPersona = { tagline: string; accent: string; tone: "cat" | "lobster" | "otter" | "neutral" };

function traderPersona(name: string): TraderPersona {
  const key = name.toLowerCase();
  if (key.includes("cat")) {
    return {
      tagline: "Spot arbitrage on the USDC / ARCETH pool",
      accent: "#c8ff5a",
      tone: "cat",
    };
  }
  if (key.includes("lobster")) {
    return {
      tagline: "Risk managed copy with tighter slippage",
      accent: "#ffb347",
      tone: "lobster",
    };
  }
  if (key.includes("otter") || key.includes("momentum")) {
    return {
      tagline: "LLM reasoned momentum, regime read every intent",
      accent: "#6ad1ff",
      tone: "otter",
    };
  }
  return { tagline: "Onchain source", accent: "#d8ff79", tone: "neutral" };
}

const SIGNAL_LABEL: Record<AgentSignal, string> = {
  healthy: "Healthy",
  watch: "Watch",
  stop: "Stop",
  warming: "Warming up",
};

function SignalBadge({ level, reason, compact = false }: { level: AgentSignal; reason?: string; compact?: boolean }) {
  return (
    <span className={`signalBadge signalBadge--${level}${compact ? " signalBadge--compact" : ""}`} title={reason}>
      <span className="signalBadgeDot" />
      {SIGNAL_LABEL[level]}
    </span>
  );
}

function SignalStrip({ rows }: { rows: EarnedReputation[] }) {
  if (rows.length === 0) return null;
  const signals = rows.map((row) => ({ row, ...agentSignal(row) }));
  return (
    <div className="signalStrip" role="group" aria-label="Per agent trust signal">
      <div className="signalStripHeader">
        <span className="signalStripDot" />
        <strong>Signal monitor</strong>
        <span className="signalStripHint">
          Shadow does not just copy agents. It watches when an agent stops being worth copying. Computed live from receipts and closes.
        </span>
      </div>
      <div className="signalStripGrid">
        {signals.map(({ row, level, reason }) => (
          <div className={`signalStripItem signalStripItem--${level}`} key={row.source.address}>
            <SignalBadge level={level} compact />
            <span className="signalStripName">{row.source.name}</span>
            <span className="signalStripReason">{reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EarnedReputationPanel({ rows, onFollow }: { rows: EarnedReputation[]; onFollow?: (addr: Address) => void }) {
  if (rows.length === 0) {
    return (
      <section className="reputationPanel reputationPanelEmpty">
        <Header eyebrow="meet the agents" title="Source agents appear when the registry syncs." />
        <p className="reputationCaption">
          Shadow keeps this page useful even before live source rows arrive: the reputation model is receipt-first, not
          profile-first.
        </p>
        <div className="emptyProofGrid" aria-label="Reputation inputs">
          <span>copied intents</span>
          <span>blocked attempts</span>
          <span>repayments</span>
          <span>x402-bound receipts</span>
        </div>
      </section>
    );
  }
  const totalIntents = rows.reduce((sum, r) => sum + r.intentsPublished, 0);
  const totalCopies = rows.reduce((sum, r) => sum + r.copyCount, 0);
  const totalRouted = rows.reduce((sum, r) => sum + r.routedUSDC, 0n);
  return (
    <section className="reputationPanel" id="sources">
      <Header eyebrow="meet the agents" title="AI source agents you can follow. Profiles, not metrics." />
      <p className="reputationCaption">
        These three agents publish intents on Arc every 10 minutes. Each card shows what their intents actually did,
        who copied, who got blocked, and what they earned. Nothing self-reported.
      </p>
      <SignalStrip rows={rows} />
      <div className="reputationTotals">
        <span>{totalIntents} intents published</span>
        <span>{totalCopies} copies executed</span>
        <span>{formatUSDC(totalRouted)} USDC routed through followers</span>
      </div>
      <div className="reputationGrid">
        {rows.map((row, index) => {
          const persona = traderPersona(row.source.name);
          const signal = agentSignal(row);
          return (
          <article className={`reputationCard reputationCard--${persona.tone}`} key={row.source.address} style={{ ["--trader-accent" as string]: persona.accent }}>
            <header className="reputationCardHeader">
              <span className="reputationRank">#{index + 1}</span>
              <div className="reputationName">
                <strong>{row.source.name}</strong>
                <span className="reputationTagline">{persona.tagline}</span>
                <span className="reputationAddr">{shortAddress(row.source.address)}</span>
              </div>
              <div className="reputationHeaderRight">
                <SignalBadge level={signal.level} reason={signal.reason} />
                <span className="reputationRegistry">
                  registry score {score(row.source.reputationScore)}
                </span>
              </div>
            </header>
            <p className="reputationSignalReason">{signal.reason}</p>
            {row.lastIntent && (
              <div className="reputationLastIntent">
                <span className="reputationLastIntentLabel">Last intent</span>
                <span className="reputationLastIntentValue">
                  swap <strong>{formatUSDC(row.lastIntent.amountUSDC)} USDC</strong> · risk L{row.lastIntent.riskLevel}
                </span>
                <span className="reputationLastIntentBlock">block {row.lastIntent.blockNumber.toString()}</span>
              </div>
            )}
            <div className="reputationStats">
              <ReputationStat label="intents" value={String(row.intentsPublished)} />
              <ReputationStat
                label="copy rate"
                value={
                  row.copyCount + row.blockCount === 0
                    ? "…"
                    : `${(row.copyRateBps / 100).toFixed(1)}%`
                }
                subtext={`${row.copyCount} copied / ${row.blockCount} blocked`}
              />
              <ReputationStat
                label="USDC routed"
                value={formatUSDC(row.routedUSDC)}
              />
              <ReputationStat
                label="source fees earned"
                value={formatUSDC(row.source.kickbackUSDC)}
                subtext={`${formatUSDC(row.mirrorFeesUSDC)} USDC mirror fees · 70% accrued to source`}
              />
              <ReputationStat
                label="follow records"
                value={row.source.followerCount.toString()}
              />
              <ReputationStat
                label="realized PnL"
                value={
                  row.realizedPnlAvgBps === null
                    ? "no closes"
                    : `${(row.realizedPnlAvgBps / 100).toFixed(2)}%`
                }
                subtext={
                  row.closedCount === 0 ? "…" : `avg over ${row.closedCount} closed positions`
                }
                tone={
                  row.realizedPnlAvgBps === null
                    ? undefined
                    : row.realizedPnlAvgBps >= 0
                      ? "positive"
                      : "negative"
                }
              />
            </div>
            {onFollow && (
              <button
                className="reputationFollowCta"
                type="button"
                onClick={() => onFollow(row.source.address)}
              >
                Follow {row.source.name}
                <span className="reputationFollowArrow">→</span>
              </button>
            )}
          </article>
          );
        })}
      </div>
    </section>
  );
}

function ReputationStat({
  label,
  value,
  subtext,
  tone,
}: {
  label: string;
  value: string;
  subtext?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className={`reputationStat${tone ? ` tone-${tone}` : ""}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      {subtext && <span>{subtext}</span>}
    </div>
  );
}

function CircleStackPanel() {
  return (
    <section id="circle-stack" className="circleStackPanel">
      <Header
        eyebrow="circle stack on arc"
        title="Circle is tiered by its real role in Float"
      />
      <p className="circleStackCaption">
        Float&apos;s core draw path uses Arc USDC, x402, and EIP-3009 today. Gateway-batched x402 is the next interop
        milestone: Shadow completed an interoperability test with an independent Gateway-batched Arc x402 seller, while
        per-transfer onchain settlement binding into Float receipts remains the next milestone. Circle Modular Wallets and
        Gas Station are proven onboarding capability, not the current Float draw path.
      </p>
      <div className="circleStackGrid">
        <article className="circleTierCard primary">
          <span>load-bearing now</span>
          <strong>Arc USDC · x402 · EIP-3009</strong>
          <p>Every current Float draw settles on Arc USDC over x402 using EIP-3009 authorization.</p>
        </article>
        <article className="circleTierCard">
          <span>next milestone</span>
          <strong>Gateway-batched x402</strong>
          <p>
            Lab interop reached an independent Gateway-batched Arc x402 seller; the missing piece is a resolver that binds
            per-transfer settlement into Float receipts.
          </p>
        </article>
        <article className="circleTierCard">
          <span>onboarding capability</span>
          <strong>Modular Wallets · Gas Station</strong>
          <p>Shadow has demonstrated passkey-based, gas-sponsored onboarding that can be applied to Float agents.</p>
        </article>
      </div>
      <div className="circleStackGrid circleStackGridSolo">
        <ModularWalletCard />
      </div>
    </section>
  );
}

function FloatEconomicsPanel() {
  return (
    <section className="floatEconomicsPanel" aria-label="Shadow Float treasury economics roadmap">
      <Header eyebrow="treasury economics · roadmap" title="Mainnet Float needs reserved capital, not hot-funded agents" />
      <div className="floatEconomicsGrid">
        <article>
          <span>treasury capital</span>
          <p>
            At scale, operators or liquidity providers fund the treasury. Granted capacity stays capped by reserves, so
            the system does not promise more available Float than it can front.
          </p>
        </article>
        <article>
          <span>defaults</span>
          <p>
            Defaults reduce or freeze future capacity and route the agent back through review. The live testnet proves
            default accounting; the mainnet bad-debt model is roadmap.
          </p>
        </article>
        <article>
          <span>fees</span>
          <p>
            Each approved draw can accrue a small fee into the agent&apos;s debt. Repayment returns principal plus fee,
            funding treasury sustainability and default reserves.
          </p>
        </article>
        <article>
          <span>why mainnet needs it</span>
          <p>
            Agents should not keep every wallet hot-funded just to buy data, compute, or APIs. Float lets them spend inside
            a bounded, revocable line while budget settlement catches up.
          </p>
        </article>
      </div>
      <p className="floatEconomicsNote">
        Current testnet numbers prove mechanics only: treasury fronting, x402 settlement, debt, fee accrual, repayment, and
        block/deny behavior. They are not meaningful revenue.
      </p>
    </section>
  );
}

type ModularWalletState =
  | { kind: "idle" }
  | { kind: "configMissing"; reason: string }
  | { kind: "registering" }
  | { kind: "loggingIn" }
  | { kind: "deriving" }
  | { kind: "ready"; address: Address; mode: "Register" | "Login" }
  | { kind: "funding"; address: Address }
  | { kind: "funded"; address: Address; tx?: string; alreadyFunded?: boolean }
  | { kind: "sending"; stage: string; address: Address }
  | { kind: "sent"; address: Address; userOpHash: string; txHash?: string; mode?: "follow" | "lepton"; mandateId?: bigint; amountUSDC?: bigint }
  | { kind: "error"; message: string; address?: Address };

const CREDENTIAL_STORAGE_KEY = "shadow:circleModularCredential";

const SOURCE_AGENTS: ReadonlyArray<{
  address: Address;
  name: string;
  tagline: string;
}> = [
  {
    address: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
    name: "CatArb",
    tagline: "spot arbitrage on USDC / ARCETH",
  },
  {
    address: "0xFF3BDb60E16538333C9A290BB80bE52b3b82D2f3" as Address,
    name: "LobsterRisk",
    tagline: "risk managed copy, tighter slippage",
  },
  {
    address: "0xe2f079d0aBe68a9CA0A9875e254fD976EaC0696B" as Address,
    name: "MomentumOtter",
    tagline: "LLM reasoned momentum, regime read per intent",
  },
];

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const mod = b64.length % 4;
  const padded = mod === 0 ? b64 : b64 + "=".repeat(4 - mod);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ModularWalletCard() {
  const clientKey = (import.meta.env.VITE_CIRCLE_CLIENT_KEY || "").trim();
  const clientUrl = (import.meta.env.VITE_CIRCLE_CLIENT_URL || "").trim();

  const initial: ModularWalletState =
    !clientKey || !clientUrl
      ? {
          kind: "configMissing",
          reason:
            "Set VITE_CIRCLE_CLIENT_KEY and VITE_CIRCLE_CLIENT_URL in your env (Circle Console → Modular Wallets) to enable passkey onboarding + Gas Station.",
        }
      : { kind: "idle" };

  const [state, setState] = useState<ModularWalletState>(initial);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState(0);
  const selectedSource = SOURCE_AGENTS[selectedSourceIndex];
  const [followerPolicy, setFollowerPolicy] = useState<{
    active: boolean;
    maxPerIntent: bigint;
    dailyCap: bigint;
    spentToday: bigint;
  } | null>(null);

  const trackedAddress: Address | undefined = (state as any).address;
  useEffect(() => {
    if (!trackedAddress || !addresses.router) {
      setFollowerPolicy(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const policy = (await publicClient.readContract({
          address: addresses.router!,
          abi: routerAbi,
          functionName: "getPolicy",
          args: [trackedAddress, selectedSource.address],
        })) as readonly [bigint, bigint, Address, number, number, bigint, bigint, boolean];
        if (cancelled) return;
        setFollowerPolicy({
          active: policy[7],
          maxPerIntent: policy[0],
          dailyCap: policy[1],
          spentToday: policy[5],
        });
      } catch {
        if (!cancelled) setFollowerPolicy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trackedAddress, state.kind, selectedSource.address]);

  useEffect(() => {
    if (state.kind !== "ready" || !addresses.usdc) return;
    const addr = state.address;
    let cancelled = false;
    void (async () => {
      try {
        const balance = (await publicClient.readContract({
          address: addresses.usdc!,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [addr],
        })) as bigint;
        if (cancelled) return;
        if (balance >= parseUnits("0.04", 6)) {
          setState({ kind: "funded", address: addr, alreadyFunded: true });
        }
      } catch {
        // leave state as ready; user can still click Fund manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.kind, (state as any).address]);

  async function loadCredential(): Promise<WebAuthnCredential | null> {
    try {
      const raw =
        localStorage.getItem(CREDENTIAL_STORAGE_KEY) ??
        sessionStorage.getItem(CREDENTIAL_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as WebAuthnCredential;
    } catch {
      return null;
    }
  }

  function persistCredential(cred: WebAuthnCredential) {
    try {
      localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(cred));
    } catch {
      try {
        sessionStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(cred));
      } catch {
        // Both stores blocked (private mode + quota). Credential reconstructable via Login.
      }
    }
  }

  async function withSmartAccount(cred: WebAuthnCredential) {
    const modularTransport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
    const client = createClient({
      chain: arcTestnet,
      transport: modularTransport,
    }) as any;
    const owner = toWebAuthnAccount({ credential: cred, rpId: cred.rpId });
    const smartAccount = await toCircleSmartAccount({ client, owner });
    const bundler = createBundlerClient({
      account: smartAccount,
      chain: arcTestnet,
      transport: modularTransport,
      paymaster: true,
      paymasterContext: {},
      userOperation: {
        estimateFeesPerGas: async () => {
          const prices: any = await getUserOperationGasPrice(client);
          const tier = prices?.medium ?? prices?.high ?? prices?.low;
          return {
            maxFeePerGas: BigInt(tier.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tier.maxPriorityFeePerGas),
          };
        },
      },
    } as any);
    return { smartAccount, bundler };
  }

  async function onRegister() {
    setState({ kind: "registering" });
    let restoreCreate: (() => void) | null = null;
    try {
      const existing = await loadCredential();
      let excludeId: Uint8Array | null = null;
      if (existing?.id) {
        try {
          excludeId = base64UrlToBytes(existing.id);
        } catch {
          excludeId = null;
        }
      }
      if (excludeId) {
        const originalCreate = navigator.credentials.create.bind(
          navigator.credentials,
        );
        const id = excludeId;
        (navigator.credentials as any).create = async (opts: any) => {
          if (opts?.publicKey) {
            opts.publicKey.excludeCredentials = [
              ...(opts.publicKey.excludeCredentials ?? []),
              { type: "public-key", id },
            ];
          }
          return originalCreate(opts);
        };
        restoreCreate = () => {
          (navigator.credentials as any).create = originalCreate;
        };
      }

      const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
      const credential = await toWebAuthnCredential({
        transport: passkeyTransport,
        mode: WebAuthnMode.Register,
        username: `shadow-${Date.now()}`,
      });
      persistCredential(credential);
      setState({ kind: "deriving" });
      const { smartAccount } = await withSmartAccount(credential);
      setState({ kind: "ready", address: smartAccount.address, mode: "Register" });
    } catch (err: any) {
      const msg = err?.message || String(err);
      const name = err?.name || "";
      const explicitDuplicate =
        name === "InvalidStateError" ||
        /InvalidStateError|already.*passkey|already.*registered|already.*enrolled/i.test(
          msg,
        );
      const browserDedupCloak =
        name === "NotAllowedError" ||
        /timed out or was not allowed|talking to the credential manager|operation.*not allowed/i.test(
          msg,
        );
      const blockedByExisting =
        restoreCreate !== null && (explicitDuplicate || browserDedupCloak);
      setState({
        kind: "error",
        message: blockedByExisting
          ? "This device already has a Shadow passkey (or the prompt was cancelled). Tap Login to use the existing passkey, or register from a different device for a new account."
          : explicitDuplicate
            ? "This device already has a Shadow passkey. Tap Login to use it, or register from a different device for a new account."
            : msg,
      });
    } finally {
      restoreCreate?.();
    }
  }

  async function onLogin() {
    setState({ kind: "loggingIn" });
    try {
      const stored = await loadCredential();
      const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
      const credential = stored
        ? stored
        : await toWebAuthnCredential({
            transport: passkeyTransport,
            mode: WebAuthnMode.Login,
          });
      persistCredential(credential);
      setState({ kind: "deriving" });
      const { smartAccount } = await withSmartAccount(credential);
      setState({ kind: "ready", address: smartAccount.address, mode: "Login" });
    } catch (err: any) {
      setState({ kind: "error", message: err?.message || String(err) });
    }
  }

  async function onFund() {
    const addr =
      state.kind === "ready" || state.kind === "funded" || state.kind === "sent" || state.kind === "error"
        ? (state as any).address
        : undefined;
    if (!addr) return;
    setState({ kind: "funding", address: addr });
    try {
      const demoCode = ((import.meta as any).env?.VITE_SHADOW_DEMO_CODE as string | undefined) || "";
      const res = await fetch("/api/fund-smart-account", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shadow-demo-code": demoCode },
        body: JSON.stringify({ address: addr, demoCode }),
      });
      const json = (await res.json()) as {
        funded?: boolean;
        skipped?: boolean;
        cached?: boolean;
        tx?: string;
        previousTx?: string;
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error || `fund failed (HTTP ${res.status})`);
      }
      setState({
        kind: "funded",
        address: addr,
        tx: json.tx || json.previousTx,
        alreadyFunded: Boolean(json.skipped || json.cached),
      });
    } catch (err: any) {
      setState({
        kind: "error",
        message: err?.shortMessage || err?.message || "fund failed",
        address: addr,
      });
    }
  }

  async function onSponsoredFollow() {
    if (state.kind !== "ready" && state.kind !== "funded") return;
    const accountAddress = state.address;
    if (!addresses.router || !addresses.usdc || !addresses.arceth) {
      setState({
        kind: "error",
        message: "Shadow router/usdc/arceth env not set; cannot onboard follower.",
        address: accountAddress,
      });
      return;
    }
    setState({ kind: "sending", stage: "loading passkey credential", address: accountAddress });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      setState({ kind: "sending", stage: "encoding follow batch", address: accountAddress });
      const { smartAccount, bundler } = await withSmartAccount(credential);

      const depositAmount = parseUnits("0.04", 6);
      const maxAmountPerIntent = parseUnits("0.02", 6);
      const dailyCap = parseUnits("0.04", 6);
      const minBpsOut = 9500;
      const maxRiskLevel = 2;

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [addresses.router as Address, depositAmount],
      });
      const depositData = encodeFunctionData({
        abi: routerAbi,
        functionName: "depositUSDC",
        args: [depositAmount],
      });
      const followData = encodeFunctionData({
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource.address,
          maxAmountPerIntent,
          dailyCap,
          addresses.arceth as Address,
          maxRiskLevel,
          minBpsOut,
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor", address: accountAddress });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [
          { to: addresses.usdc as Address, value: 0n, data: approveData },
          { to: addresses.router as Address, value: 0n, data: depositData },
          { to: addresses.router as Address, value: 0n, data: followData },
        ],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for receipt", address: accountAddress });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({
        kind: "sent",
        address: accountAddress,
        userOpHash,
        txHash: receipt?.receipt?.transactionHash,
        mode: "follow",
      });
    } catch (err: any) {
      const parts: string[] = [];
      let current: any = err;
      let depth = 0;
      while (current && depth < 8) {
        const msg = current.shortMessage || current.message;
        if (msg && !parts.includes(msg)) parts.push(msg);
        if (current.details && typeof current.details === "string" && !parts.includes(current.details)) {
          parts.push(current.details);
        }
        if (current.metaMessages && Array.isArray(current.metaMessages)) {
          for (const m of current.metaMessages) {
            if (typeof m === "string" && !parts.includes(m)) parts.push(m);
          }
        }
        current = current.cause;
        depth += 1;
      }
      const raw = parts.join(" | ") || String(err);
      console.error("[sponsoredFollow] full error chain", err);
      const insufficient = /transfer amount exceeds balance|insufficient.*balance/i.test(raw);
      setState({
        kind: "error",
        message: insufficient
          ? `Smart account needs USDC first. Click "Fund smart account" (deployer sends 0.05 USDC) and retry.`
          : raw,
        address: accountAddress,
      });
    }
  }

  async function onSponsoredLeptonMandate() {
    const accountAddress = (state as any).address as Address | undefined;
    if (!accountAddress || state.kind === "funding" || state.kind === "sending") return;
    if (!addresses.usdc || !isLeptonConfigured || !leptonAddresses.mandateRegistry || !leptonAddresses.v4StyleAdapter) {
      setState({
        kind: "error",
        message: "Lepton registry/adapter/usdc addresses are not configured.",
        address: accountAddress,
      });
      return;
    }

    setState({ kind: "sending", stage: "loading passkey credential", address: accountAddress });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      const { smartAccount, bundler } = await withSmartAccount(credential);
      const smartAddress = smartAccount.address as Address;
      const amountUSDC = parseUnits("0.01", 6);
      const dailyCap = parseUnits("0.02", 6);

      setState({ kind: "sending", stage: "checking passkey USDC balance", address: smartAddress });
      const balance = (await publicClient.readContract({
        address: addresses.usdc as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [smartAddress],
      })) as bigint;
      if (balance < amountUSDC) {
        throw new Error(`Smart account needs at least ${formatUSDC(amountUSDC)} USDC. Click "Fund smart account" and retry.`);
      }

      setState({ kind: "sending", stage: "reading next mandate id", address: smartAddress });
      const mandateId = (await publicClient.readContract({
        address: leptonAddresses.mandateRegistry,
        abi: mandateRegistryAbi,
        functionName: "nextMandateId",
      })) as bigint;
      const now = Math.floor(Date.now() / 1000);

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [leptonAddresses.v4StyleAdapter, amountUSDC],
      });
      const createMandateData = encodeFunctionData({
        abi: mandateRegistryAbi,
        functionName: "createMandate",
        args: [
          smartAddress,
          addresses.usdc as Address,
          leptonAddresses.v4StyleAdapter,
          1,
          amountUSDC,
          dailyCap,
          3,
          9_900,
          keccak256(stringToBytes(`shadow-lepton-passkey-${smartAddress}-${now}`)),
        ],
      });
      const actionData = encodeFunctionData({
        abi: v4StyleArcAdapterAbi,
        functionName: "beforeSwapStyleAction",
        args: [
          {
            mandateId,
            actor: smartAddress,
            circleAccount: smartAddress,
            settlementAsset: addresses.usdc as Address,
            target: leptonAddresses.v4StyleAdapter,
            actionType: 1,
            amountUSDC,
            riskLevel: 2,
            minBpsOut: 9_950,
            expiry: BigInt(now + 86_400),
            intentHash: keccak256(stringToBytes(`shadow-lepton-passkey-allow-${now}`)),
            executionRef: keccak256(stringToBytes("circle-passkey-lepton-allow")),
          },
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor Lepton batch", address: smartAddress });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [
          { to: addresses.usdc as Address, value: 0n, data: approveData },
          { to: leptonAddresses.mandateRegistry, value: 0n, data: createMandateData },
          { to: leptonAddresses.v4StyleAdapter, value: 0n, data: actionData },
        ],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for Lepton receipt", address: smartAddress });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({
        kind: "sent",
        address: smartAddress,
        userOpHash,
        txHash: receipt?.receipt?.transactionHash,
        mode: "lepton",
        mandateId,
        amountUSDC,
      });
    } catch (err: any) {
      const parts: string[] = [];
      let current: any = err;
      let depth = 0;
      while (current && depth < 8) {
        const msg = current.shortMessage || current.message;
        if (msg && !parts.includes(msg)) parts.push(msg);
        if (current.details && typeof current.details === "string" && !parts.includes(current.details)) {
          parts.push(current.details);
        }
        if (current.metaMessages && Array.isArray(current.metaMessages)) {
          for (const m of current.metaMessages) {
            if (typeof m === "string" && !parts.includes(m)) parts.push(m);
          }
        }
        current = current.cause;
        depth += 1;
      }
      console.error("[sponsoredLeptonMandate] full error chain", err);
      setState({
        kind: "error",
        message: parts.join(" | ") || String(err),
        address: accountAddress,
      });
    }
  }

  async function onTunePolicy() {
    const addr = (state as any).address as Address | undefined;
    if (!addr) return;
    if (!addresses.router || !addresses.arceth) {
      setState({ kind: "error", message: "router/arceth env not set", address: addr });
      return;
    }
    setState({ kind: "sending", stage: "loading passkey credential", address: addr });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      setState({ kind: "sending", stage: "encoding looser minBpsOut", address: addr });
      const { smartAccount, bundler } = await withSmartAccount(credential);

      const maxAmountPerIntent = parseUnits("0.02", 6);
      const dailyCap = parseUnits("0.04", 6);
      const minBpsOut = 9000;
      const maxRiskLevel = 2;

      const followData = encodeFunctionData({
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource.address,
          maxAmountPerIntent,
          dailyCap,
          addresses.arceth as Address,
          maxRiskLevel,
          minBpsOut,
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor tune", address: addr });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [{ to: addresses.router as Address, value: 0n, data: followData }],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for receipt", address: addr });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({ kind: "sent", address: addr, userOpHash, txHash: receipt?.receipt?.transactionHash });
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.error("[tunePolicy] error", err);
      setState({ kind: "error", message: msg, address: addr });
    }
  }

  return (
    <div className="modularCard">
      <div className="modularHeader">
        <span className="modularBadge">Modular Wallets · MSCA · ERC-4337</span>
        <h3>One click follower onboarding, gas sponsored by Circle</h3>
      </div>
      {followerPolicy && (
        <div className="modularStatusRow">
          <span className={followerPolicy.active ? "modularChipOk" : "modularChipMuted"}>
            Sponsored onboards: {followerPolicy.active ? 1 : 0}
          </span>
          {followerPolicy.active && (
            <>
              <span className="modularChipOk">Following {selectedSource.name}</span>
              <span className="modularChipMuted">0 ETH gas from your wallet</span>
            </>
          )}
        </div>
      )}
      {state.kind === "configMissing" ? (
        <p className="modularEmpty">{(state as any).reason}</p>
      ) : (
        <>
          <p className="modularBody">
            Create a Circle MSCA owned by your device passkey, fund it with 0.05
            USDC (one click below), then approve, deposit, and call{" "}
            <code>followSource</code> on the source agent you pick in a single batched
            UserOp with <code>paymaster: true</code>. The smart account becomes a real
            Shadow follower with its own minBpsOut policy. Circle Gas Station pays the
            gas, so a new follower can start mirroring on Arc without ever holding
            native gas first.
          </p>
          <div className="modularButtons">
            <button
              type="button"
              className="modularBtnPrimary"
              onClick={onRegister}
              disabled={state.kind === "registering" || state.kind === "loggingIn" || state.kind === "deriving" || state.kind === "sending"}
            >
              {state.kind === "registering" ? "Registering…" : "Register passkey"}
            </button>
            <button
              type="button"
              className="modularBtnSecondary"
              onClick={onLogin}
              disabled={state.kind === "registering" || state.kind === "loggingIn" || state.kind === "deriving" || state.kind === "sending"}
            >
              {state.kind === "loggingIn" ? "Logging in…" : "Login with passkey"}
            </button>
          </div>
          {state.kind === "deriving" && <p className="modularInfo">Deriving smart account address…</p>}
          {(state.kind === "ready" ||
            state.kind === "funding" ||
            state.kind === "funded" ||
            state.kind === "sending" ||
            state.kind === "sent" ||
            (state.kind === "error" && (state as any).address)) && (
            <div className="modularAccount">
              <p>
                <span>Smart account</span>{" "}
                <code title={(state as any).address}>{(state as any).address}</code>{" "}
                <button
                  type="button"
                  className="modularCopyBtn"
                  onClick={() => navigator.clipboard?.writeText((state as any).address)}
                  title="Copy address"
                >
                  copy
                </button>
              </p>
              <div className="modularSourcePicker">
                <span className="modularSourcePickerLabel">Source agent:</span>
                {SOURCE_AGENTS.map((src, i) => (
                  <button
                    key={src.address}
                    type="button"
                    className={
                      i === selectedSourceIndex
                        ? "modularBtnPrimary"
                        : "modularBtnSecondary"
                    }
                    onClick={() => setSelectedSourceIndex(i)}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                    title={src.tagline}
                  >
                    {src.name}
                  </button>
                ))}
              </div>
              <div className="modularButtons">
                <button
                  type="button"
                  className="modularBtnSecondary"
                  onClick={onFund}
                  disabled={state.kind === "funding" || state.kind === "sending"}
                >
                  {state.kind === "funding"
                    ? "Funding…"
                    : state.kind === "funded"
                      ? state.alreadyFunded
                        ? "Already funded ✓"
                        : "Funded ✓, re-fund"
                      : "Fund smart account (0.05 USDC)"}
                </button>
                {followerPolicy?.active ? (
                  <span className="modularChipOk modularAlreadyFollowing">
                    Already following {selectedSource.name} ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    className="modularBtnPrimary"
                    onClick={onSponsoredFollow}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                  >
                    {state.kind === "sending"
                      ? `Following… ${state.stage}`
                      : `Follow ${selectedSource.name} (approve, deposit, followSource, sponsored)`}
                  </button>
                )}
                {(followerPolicy?.active || state.kind === "sent") && (
                  <button
                    type="button"
                    className="modularBtnSecondary"
                    onClick={onTunePolicy}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                  >
                    {state.kind === "sending"
                      ? `Updating slippage… ${state.stage}`
                      : "Accept up to 10% slippage (was 5%, sponsored)"}
                  </button>
                )}
                <button
                  type="button"
                  className="modularBtnPrimary"
                  onClick={onSponsoredLeptonMandate}
                  disabled={state.kind === "sending" || state.kind === "funding"}
                  title="Create a Lepton mandate and execute an allowed USDC movement through the bonded adapter"
                >
                  {state.kind === "sending"
                    ? `Lepton… ${state.stage}`
                    : "Run Lepton mandate proof (sponsored)"}
                </button>
              </div>
              {state.kind === "funded" && state.tx && (
                <p className="modularInfo">
                  Faucet tx{" "}
                  <a href={txUrl(state.tx as `0x${string}`)} target="_blank" rel="noreferrer">
                    {state.tx.slice(0, 10)}…
                  </a>
                  . Now click follow {selectedSource.name}. Circle Gas Station
                  sponsors all three calls in one batched UserOp.
                </p>
              )}
            </div>
          )}
          {state.kind === "sent" && (
            <p className="modularOk">
              <strong>Zero gas paid by your wallet.</strong>{" "}
              {state.mode === "lepton" ? (
                <>
                  Circle Gas Station sponsored the Lepton batch: approve USDC,
                  create mandate #{state.mandateId?.toString()}, then execute{" "}
                  {state.amountUSDC ? formatUSDC(state.amountUSDC) : "0.01"} USDC
                  through the bonded adapter with an ALLOW receipt and vault record.{" "}
                </>
              ) : (
                <>
                  Circle Gas Station sponsored the entire batched UserOp (approve + deposit +
                  followSource). Smart account is now a live {selectedSource.name}{" "}
                  follower with its own minBpsOut policy.{" "}
                </>
              )}
              {state.txHash ? (
                <a href={txUrl(state.txHash as `0x${string}`)} target="_blank" rel="noreferrer">
                  view batched tx
                </a>
              ) : (
                <span>UserOp hash: <code>{state.userOpHash.slice(0, 10)}…</code></span>
              )}
            </p>
          )}
          {state.kind === "error" && <p className="modularErr">{state.message}</p>}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
