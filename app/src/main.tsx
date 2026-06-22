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
import "./styles.css";

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
  source?: "agent-loop";
  action?: string;
  outcome?: string;
  at?: string;
  amountUSDC?: string;
  x402Hash?: `0x${string}`;
  bindTxHash?: `0x${string}`;
  repayTxHash?: `0x${string}`;
  txHash?: `0x${string}`;
  requestHash?: string;
  reason?: string;
  rationale?: string;
  model?: string;
  fellBack?: boolean;
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
    external?: FloatSourceSummary;
  };
  loopRuns?: FloatLoopRun[];
  receipts?: FloatReceiptState[];
  latestBlock?: string;
  fetchedAt?: number;
  missing?: string[];
  degraded?: boolean;
  error?: string;
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
              shadow 2.0 · live on arc testnet
            </div>
            <h1>Float for agents. Mandates for capital. Receipts for proof.</h1>
            <p className="lede">
              Shadow 2.0 lets trusted agents buy approved x402 resources before their own wallet is funded, while mandates
              block overreach before treasury USDC moves. Every approval, refusal, and repayment becomes an Arc receipt.
            </p>
            <div className="heroActions">
              <Link to="/float" className="heroCtaPrimary">
                Open Shadow Float
                <span className="heroCtaArrow">→</span>
              </Link>
              <Link to="/lepton" className="heroCtaSecondary">
                View mandate engine
              </Link>
            </div>
            <ul className="heroTrust" aria-label="Built on">
              <li><span className="heroTrustDot heroTrustDot--signal" />Arc testnet</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />real USDC</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />x402 settlement</li>
              <li><span className="heroTrustDot heroTrustDot--signal" />onchain receipts</li>
            </ul>
          </div>
          <HeroDiagram />
        </div>
        <HeroMetrics state={state} />
      </section>

      <Shadow2ProofStrip
        floatState={floatState}
        leptonState={leptonState}
        copiedCount={copiedReceipts.length}
        blockedCount={blockedReceipts.length}
      />

      {spotlight ? (
        <section className="spotlight" id="split">
          <p className="eyebrow">adapter one · historical proof · live on Arc</p>
          <h2>Copy trading was the first adapter. The primitive is policy before capital moves.</h2>
          <p className="spotlightSummary">
            {sourceNameByAddress.get(spotlight.intent.sourceAgent.toLowerCase()) || shortAddress(spotlight.intent.sourceAgent)}{" "}
            wanted to swap {formatUSDC(spotlight.intent.amountUSDC)} USDC. Two followers were looking. One had room for it;
            the other&apos;s risk rule said no. That same allow/block pattern now powers Float and protocol mandates.
          </p>
          <div className="spotlightGrid">
            <SpotlightCard
              verdict="COPIED"
              kind="copied"
              label="Copied follower · policy let it through"
              follower={spotlight.copied.follower}
              receipt={spotlight.copied}
              detail="Within size, slippage, and daily cap. Swap went through. Mirror fee debited from this follower."
            />
            <div className="spotlightVs" aria-hidden="true">
              <span className="spotlightVsLine" />
              <span className="spotlightVsLabel">VS</span>
              <span className="spotlightVsLine" />
            </div>
            <SpotlightCard
              verdict="BLOCKED"
              kind="blocked"
              label="Blocked follower · policy refused"
              follower={spotlight.blocked.follower}
              receipt={spotlight.blocked}
              detail={`Reason on chain: "${spotlight.blocked.reason}". Nothing was spent. The block is its own receipt.`}
            />
          </div>

          <div className="liveVerify">
            <div className="liveVerifyHeader">
              <p className="eyebrow">don&apos;t trust the screenshot</p>
              <p className="liveVerifyLede">
                Publish a fresh intent right now. We sign as CatArb, pick a slippage that lands between the two followers&apos;
                minimums, then print the on-chain receipts here. New transaction every click.
              </p>
            </div>
            <button className="liveVerifyButton" onClick={runVerify} disabled={verifying}>
              {verifying ? "publishing intent…" : "run live test"}
            </button>
            {verifyError && <div className="liveVerifyError">error: {verifyError}</div>}
            {verifyResult && <VerifyResultPanel result={verifyResult} />}
          </div>
        </section>
      ) : (
        <SplitMomentFallback />
      )}

      <TractionStrip state={state} />

      <section className="pageNext">
        <Link to="/float" className="pageNextCard pageNextCardPrimary">
          <span className="pageNextEyebrow">float</span>
          <span className="pageNextTitle">Behavior-backed USDC spending lines for agents</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/lepton" className="pageNextCard">
          <span className="pageNextEyebrow">mandates</span>
          <span className="pageNextTitle">Protocol-facing enforcement before capital moves</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/agents" className="pageNextCard">
          <span className="pageNextEyebrow">agents</span>
          <span className="pageNextTitle">Source-agent history that feeds reputation</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/receipts" className="pageNextCard">
          <span className="pageNextEyebrow">receipts</span>
          <span className="pageNextTitle">Read the proof rail across every surface</span>
          <span className="pageNextArrow">→</span>
        </Link>
      </section>
    </>
  );

  const agentsPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">agents · behavior history</p>
        <h1 className="pageTitle">The old source agents now become Shadow&apos;s reputation substrate.</h1>
        <p className="pageLede">
          Shadow 2.0 does not ask you to trust a profile. It reads behavior: who got copied, who got blocked, who repaid,
          and which receipts prove the agent deserves a line or a mandate.
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
        <h1 className="pageTitle">The mirroring surface remains as proof of policy enforcement.</h1>
        <p className="pageLede">
          This was Shadow&apos;s first working adapter: a follower sets size, slippage, daily cap, and risk limits; the router
          either executes or writes the refusal. Float and mandates reuse the same discipline.
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
        <h1 className="pageTitle">Float, mandates, and mirror actions all resolve into receipts.</h1>
        <p className="pageLede">
          Read this page as the audit layer. Spend allowed, x402 bound, repayment, blocked overreach, copied intent, refused
          mirror, and mandate proof all point back to Arc testnet events.
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

  const floatPage = (
    <>
      <FloatPanel state={floatState} loading={floatLoading} error={floatError} />
      <CircleStackPanel />
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
          <NavLink to="/agents" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Agents
          </NavLink>
          <NavLink to="/follow" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Follow
          </NavLink>
          <NavLink to="/receipts" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Receipts
          </NavLink>
          <NavLink to="/lepton" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Mandates
          </NavLink>
          <NavLink to="/float" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Float
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
          <Link to="/float" className="navCta">
            Float proof
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
        <Route path="/float" element={floatPage} />
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
  const agentLoop = state?.sourceBreakdown?.agentLoop;
  const external = state?.sourceBreakdown?.external;
  const runs = state?.loopRuns || [];
  const latestPaidRun = runs.find((run) => run.x402Hash || run.bindTxHash);
  const latestGuardRun = runs.find(
    (run) => run.outcome?.includes("BLOCK") || run.outcome?.includes("DENIED") || run.action === "PREMIUM",
  );
  const latestPaidReceipt =
    receipts.find((receipt) => receipt.x402) || receipts.find((receipt) => receipt.receiptType === "SPEND_ALLOWED");
  const latestGuardReceipt = receipts.find(
    (receipt) => receipt.receiptType.includes("BLOCK") || receipt.receiptType.includes("DENIED"),
  );
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

  return (
    <section className={`floatPanel floatPanelV2${compact ? " floatPanelCompact" : ""}`} id="shadow-float">
      <div className="floatHeroShell">
        <div className="floatHeroCopy">
          <p className="eyebrow">Shadow 2.0 · behavior-backed float</p>
          <h2>Verified behavior becomes spendable USDC.</h2>
          <p className="floatLede">
            Shadow Float gives autonomous agents a tiny revocable spending line backed by verified onchain behavior. The
            agent chooses what to buy; Shadow enforces the mandate, pays approved x402 providers, opens debt, and blocks
            overreach before capital moves.
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
            <span>treasury {formatFloatUSDC(state?.treasuryBalanceUSDC)} USDC</span>
            <span>chain 5042002</span>
          </div>
        </aside>
      </div>

      <div className="floatStatusRow">
        <div className={`floatStatus ${configured ? "configured" : "pending"}`}>
          <span className="floatStatusDot" />
          {configured ? "live Float reads" : "deploy pending"}
          {loading && <small>syncing</small>}
          {updated && <small>updated {updated}</small>}
        </div>
        <span>real Arc USDC</span>
        <span>x402 settlement bound onchain</span>
        <span>demo/admin, agent-loop, and external counters stay separate</span>
      </div>

      <div className="floatHeadlineStats">
        <FloatHeadlineStat
          label="agent-loop cycles"
          value={`${agentLoop?.cycles || 0}`}
          detail={`${agentLoop?.paidCount || 0} paid · ${agentLoop?.skipCount || 0} skipped`}
        />
        <FloatHeadlineStat
          label="x402 settled by loop"
          value={formatFloatUSDC(agentLoop?.providerPaidUSDC)}
          detail="real provider payments"
          tone="allow"
        />
        <FloatHeadlineStat
          label="blocked by mandate"
          value={formatFloatUSDC(agentLoop?.blockedUSDC)}
          detail="before funds moved"
          tone="block"
        />
        <FloatHeadlineStat label="external agents" value={`${external?.cycles || 0}`} detail="kept separate from demo" />
      </div>

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
            <FloatFact label="credit line" value={formatFloatUSDC(alpha?.creditLimitUSDC)} />
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
            <FloatFact label="credit line" value={formatFloatUSDC(beta?.creditLimitUSDC)} />
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
        <FloatMetric label="debt opened" value={formatFloatUSDC(state?.totalDebtOpenedUSDC)} tone="allow" />
        <FloatMetric label="repaid" value={formatFloatUSDC(state?.totalRepaidUSDC)} tone="allow" />
        <FloatMetric label="blocked" value={formatFloatUSDC(state?.totalBlockedUSDC)} tone="block" />
        <FloatMetric label="denied" value={formatFloatUSDC(state?.totalDeniedUSDC)} tone="block" />
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
                    <code>{formatFloatUSDC(receipt.amountUSDC)} USDC</code>
                    <small>{receipt.reason}</small>
                  </a>
                  {receipt.x402 && receipt.receiptType === "SPEND_ALLOWED" && (
                    <a className="floatX402Link" href={txUrl(receipt.x402.x402Hash)} target="_blank" rel="noreferrer">
                      paid via x402 · {shortAddress(receipt.x402.x402Hash)}
                    </a>
                  )}
                </div>
              ))
            ) : (
              <div className="floatEmpty">Run the Float proof script after deployment to populate live receipts.</div>
            )}
          </div>
        </article>
      )}

      {error && <div className="leptonError">Float read failed: {error}</div>}

      {!compact && (
        <div className="floatBoundaries">
          <span>testnet USDC line, not a lending market</span>
          <span>agent chooses the spend; Shadow enforces the mandate</span>
          <span>x402 settlement tx is bound on-chain</span>
          <span>demo/admin and agent-driven cycles stay labeled separately</span>
        </div>
      )}
    </section>
  );
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
        <small>{hasRuns ? `${summary?.cycles || 0} labeled cycles` : "waiting for first cron"}</small>
      </div>
      <div className="floatLoopStats">
        <FloatFact label="agent-loop paid" value={`${summary?.paidCount || 0}`} />
        <FloatFact label="blocked" value={`${summary?.blockedCount || 0}`} />
        <FloatFact label="denied" value={`${summary?.deniedCount || 0}`} />
        <FloatFact label="repaid" value={`${summary?.repaidCount || 0}`} />
        <FloatFact label="skipped" value={`${summary?.skipCount || 0}`} />
        <FloatFact label="fallbacks" value={`${summary?.fallbacks || 0}`} />
      </div>
      <div className="floatLoopSplit">
        <div>
          <span>agent-loop x402 settled</span>
          <strong>{formatFloatUSDC(summary?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>demo/admin x402 settled</span>
          <strong>{formatFloatUSDC(state?.sourceBreakdown?.demoAdmin?.providerPaidUSDC)}</strong>
        </div>
        <div>
          <span>external agents</span>
          <strong>{state?.sourceBreakdown?.external?.cycles || 0}</strong>
        </div>
      </div>
      {latest ? (
        <div className={`floatLoopLatest ${latest.outcome?.includes("BLOCK") || latest.outcome === "DENIED" ? "blocked" : ""}`}>
          <div>
            <span>{latest.action || "UNKNOWN"}</span>
            <strong>{latest.outcome || "pending"}</strong>
            <small>
              {latest.model || "model unknown"}
              {latest.fellBack ? " · fallback" : ""}
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
          The x402-bound proof is live. The autonomous cron has not written its first labeled loop run yet.
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
      body: "A verified agent receives a tiny USDC line, buys approved x402 resources, opens debt, and gets blocked when it overreaches.",
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
        <p className="eyebrow">Shadow 2.0 proof map</p>
        <h2>One enforcement primitive. Three live surfaces.</h2>
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
          <span className="agentTag">Alpha</span>
          <span className="heroLedgerIntentVerb">buy</span>
          <span className="heroLedgerIntentNumber">x402 data</span>
          <span className="heroLedgerIntentArrow">→</span>
          <span className="heroLedgerIntentNumber">0.001&nbsp;USDC</span>
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
          <div className="heroLedgerCellMain">+0.001</div>
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
        <span className="heroLedgerProofHash">x402 + debt + block</span>
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
        { label: "Shadow Float", href: "/float" },
        { label: "Mandate engine", href: "/lepton" },
        { label: "Receipt rail", href: "/receipts#float-receipts" },
      ],
    },
    {
      title: "Proof",
      links: [
        { label: "Agent behavior", href: "/agents#sources" },
        { label: "Mirror adapter", href: "/follow" },
        { label: "Circle stack", href: "/float#circle-stack" },
      ],
    },
    {
      title: "Resources",
      links: [
        { label: "Source on GitHub", href: "https://github.com/dolepee/shadow" },
        { label: "Arc explorer", href: "https://testnet.arcscan.app" },
        { label: "Chain ID 5042002", href: "https://testnet.arcscan.app" },
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
            Behavior-backed USDC float, mandate enforcement, and receipt proof for autonomous agents on Arc.
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
                if (l.href.startsWith("http")) {
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
        <span>Shadow · float, mandates, receipts</span>
      </div>
    </footer>
  );
}

function HeroMetrics({ state }: { state: ShadowState | null }) {
  const lifetime = state?.lifetime;

  const items: Array<{ label: string; value: string }> = [
    { label: "blocked by policy", value: lifetime?.blocked.toLocaleString() ?? "0" },
    { label: "copies executed", value: lifetime?.copied.toLocaleString() ?? "0" },
    { label: "USDC mirrored", value: lifetime ? formatUSDC(lifetime.mirroredUsdcAtomic) : "0" },
    { label: "onboarded followers", value: lifetime?.followerWallets.toLocaleString() ?? "0" },
  ];

  const hasLiveData =
    Boolean(lifetime) && (lifetime!.copied > 0 || lifetime!.blocked > 0 || lifetime!.followerWallets > 0 || lifetime!.mirroredUsdcAtomic > 0n);

  if (!hasLiveData) {
    return (
      <div className="heroMetrics heroMetrics--syncing" role="group" aria-label="Syncing live Arc data">
        <span className="heroMetricsSyncDot" />
        <span className="heroMetricsSyncLabel">Live Arc receipts</span>
        <span className="heroMetricsSyncHint">update as agents publish intents on chain 5042002</span>
      </div>
    );
  }

  return (
    <div className="heroMetricsWrap" role="group" aria-label="Snapshot-anchored lifetime numbers from Arc testnet">
      <div className="heroMetrics">
        {items.map((m) => (
          <div className="heroMetric" key={m.label}>
            <span className="heroMetricValue">{m.value}</span>
            <span className="heroMetricLabel">{m.label}</span>
          </div>
        ))}
      </div>
      <span className="heroMetricsNote">
        since launch, snapshot-anchored at {lifetime?.snapshotAt}; recent feed remains windowed
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
    adapter: "0x805db94a0b94c0d937063291ddaafb41690f5dee" as Address,
    vault: "0x0e157aeaffbebe59becb7b93007015a06c5dec90" as Address,
    mandateId: "3",
    allowTx: "0x477f9378f0f8d68302d5cfa7149026e6597fadd2a9939ade4931efe72e0031cc" as `0x${string}`,
    blockTx: "0xcc72f59c00df7109b2140d9a30053930592df29eb72827223a8283088c12bef9" as `0x${string}`,
  };
  const updated = state ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <section className={`leptonPanel${compact ? " leptonPanelCompact" : ""}`} id="lepton-m1">
      <div className="leptonHeader">
        <div>
          <p className="eyebrow">Lepton M1 · protocol mandates</p>
          <h2>The mandate engine behind Shadow 2.0.</h2>
          <p className="leptonLede">
            Shadow started with copy-trading, but the reusable primitive is broader: register a mandate, evaluate the
            action before USDC moves, write an ALLOW or BLOCK receipt, and keep the enforcer accountable across swap and
            vault-style adapters.
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
      <section className="reputationPanel">
        <Header eyebrow="meet the agents" title="AI source agents you can follow" />
        <p className="reputationEmpty">No agents registered yet.</p>
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
        title="Passkey-controlled USDC actions, sponsored by Circle Gas Station"
      />
      <p className="circleStackCaption">
        The card below uses <code>@circle-fin/modular-wallets-core</code> to mint a passkey
        owned smart account and then run sponsored USDC actions on Arc. It can onboard as
        a Shadow follower, or use the new Lepton mandate engine to create a
        Circle-wallet-scoped mandate and execute an allowed adapter action in one batched
        UserOp. Circle Gas Station pays the gas; the wallet stays self-custodial.
      </p>
      <div className="circleStackGrid circleStackGridSolo">
        <ModularWalletCard />
      </div>
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
