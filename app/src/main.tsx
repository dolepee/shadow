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
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
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
  arcTestnet,
  computeEarnedReputation,
  erc20Abi,
  fetchShadowState,
  formatAsset,
  formatUSDC,
  isConfigured,
  pilotAttestorAbi,
  publicClient,
  routerAbi,
  shortAddress,
  txUrl,
  type EarnedReputation,
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
      setAction({ label: "follow blocked", error: "Pick a trader." });
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
      setPilotError("No traders registered yet.");
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
              live on arc testnet · chain 5042002
            </div>
            <h1>Follow AI trading agents. Keep your risk limits on-chain.</h1>
            <p className="lede">
              Pick an agent and set your rules. When it trades, Shadow either{" "}
              <strong className="lede--copy">copies the swap to you</strong> or{" "}
              <strong className="lede--block">blocks it because your policy says so</strong>. Every outcome is a receipt on Arc.
            </p>
            <div className="heroActions">
              <Link to="/follow" className="heroCtaPrimary">
                Start following
                <span className="heroCtaArrow">→</span>
              </Link>
              <a href="#split" className="heroCtaSecondary">
                Watch receipt split
              </a>
            </div>
            <ul className="heroTrust" aria-label="Built on">
              <li><span className="heroTrustDot heroTrustDot--signal" />Arc testnet</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />USDC escrow</li>
              <li><span className="heroTrustDot heroTrustDot--proof" />Policy router</li>
              <li><span className="heroTrustDot heroTrustDot--signal" />On-chain receipts</li>
            </ul>
          </div>
          <HeroDiagram />
        </div>
        <HeroMetrics state={state} />
      </section>

      {spotlight ? (
        <section className="spotlight" id="split">
          <p className="eyebrow">same intent · two outcomes · live on Arc</p>
          <h2>One agent trades. Your policy decides what happens to you.</h2>
          <p className="spotlightSummary">
            {sourceNameByAddress.get(spotlight.intent.sourceAgent.toLowerCase()) || shortAddress(spotlight.intent.sourceAgent)}{" "}
            wanted to swap {formatUSDC(spotlight.intent.amountUSDC)} USDC. Two followers were looking. One had room for it,
            the other&apos;s risk rule said no. Both got an on-chain receipt in the same block.
          </p>
          <div className="spotlightGrid">
            <SpotlightCard
              verdict="COPIED"
              kind="copied"
              label="Follower A · policy let it through"
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
              label="Follower B · policy refused"
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
        <Link to="/agents" className="pageNextCard">
          <span className="pageNextEyebrow">agents</span>
          <span className="pageNextTitle">See the three source AI traders</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/follow" className="pageNextCard">
          <span className="pageNextEyebrow">follow</span>
          <span className="pageNextTitle">Pick a preset and start mirroring</span>
          <span className="pageNextArrow">→</span>
        </Link>
        <Link to="/receipts" className="pageNextCard">
          <span className="pageNextEyebrow">receipts</span>
          <span className="pageNextTitle">Watch the live copied vs blocked feed</span>
          <span className="pageNextArrow">→</span>
        </Link>
      </section>
    </>
  );

  const agentsPage = (
    <>
      <section className="pageHead">
        <p className="pageEyebrow">agents · earned reputation</p>
        <h1 className="pageTitle">Three AI traders. Public copy and block history.</h1>
        <p className="pageLede">
          Every stat is computed from on-chain receipts on Arc. No off-chain leaderboard, no curated numbers. Pick the one whose
          discipline matches your risk and follow them with your own policy.
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
        <p className="pageEyebrow">follow · onboarding</p>
        <h1 className="pageTitle">Set your policy. Deposit USDC. Mirror an agent.</h1>
        <p className="pageLede">
          Pick a preset for slippage, daily cap, and risk tolerance. Shadow enforces every rule on-chain through the router.
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
        <p className="pageEyebrow">receipts · live on Arc</p>
        <h1 className="pageTitle">Every intent settles into a receipt.</h1>
        <p className="pageLede">
          Copied or blocked, per follower, in the same block. Every entry below is one event you can verify on Arc testnet.
        </p>
      </section>
      {state && (
        <LiveFeed
          receipts={feedReceipts}
          closes={state.positionCloses}
          sourceNameByAddress={sourceNameByAddress}
          latestBlock={state.latestBlock}
          fetchedAt={state.fetchedAt}
          loading={loading}
          totalReceipts={state.receipts.length}
          account={account}
          closingIntentId={closingIntentId}
          onClosePosition={closePosition}
        />
      )}

      <LatestReasoningPanel data={reasoning} />

      <section className="grid">
        <Stat label="registered agents" value={String(state?.sources.length || 0)} />
        <Stat label="intent receipts" value={String(state?.receipts.length || 0)} />
        <Stat label="USDC mirrored" value={formatUSDC(totalMirrored(copiedReceipts))} />
        <Stat label="blocked copies" value={String(blockedReceipts.length)} />
        <Stat label="builder fees paid" value={formatUSDC(totalKickbacks(state))} />
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

      <TechnicalPrimitive state={state} />
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
          <NavLink to="/" end className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Split
          </NavLink>
          <NavLink to="/agents" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Agents
          </NavLink>
          <NavLink to="/follow" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Follow
          </NavLink>
          <NavLink to="/receipts" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Receipts
          </NavLink>
        </div>
        <div className="navActions">
          {account ? (
            <button className="navWallet" onClick={connectWallet}>
              {shortAddress(account)}
            </button>
          ) : (
            <Link to="/follow" className="navCta">
              Start following
            </Link>
          )}
        </div>
      </nav>

      <RouteScroll />

      <Routes>
        <Route path="/" element={homePage} />
        <Route path="/agents" element={agentsPage} />
        <Route path="/follow" element={followPage} />
        <Route path="/receipts" element={receiptsPage} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <SiteFooter />
    </main>
  );
}

function RouteScroll() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [pathname]);
  return null;
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
      title: "Pick an AI trader",
      body: "Browse trader reputation from real onchain receipts. CatArb, LobsterRisk, MomentumOtter — each with public copy and block history.",
    },
    {
      num: "02",
      tone: "policy",
      title: "Set USDC limit and risk policy",
      body: "Deposit USDC into the router. Set max per intent, daily cap, allowed asset, and minimum slippage. Your rules sit onchain, not in a backend.",
    },
    {
      num: "03",
      tone: "outcome",
      title: "Copy or block every intent, onchain",
      body: "When the trader publishes, Shadow either copies the swap or refuses it with an onchain receipt that names the exact policy field. No surprises, no off chain matcher.",
    },
  ];
  return (
    <section className="howItWorks">
      <p className="eyebrow">how Shadow works</p>
      <h2 className="howTitle">Three steps from picking a trader to a verifiable receipt.</h2>
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
          You stay in your own wallet. Shadow holds your USDC in escrow and only spends it when an agent&apos;s trade
          fits the rules you set. Raise or lower those rules whenever you want.
        </p>
      </header>

      <div className="followStep">
        <span className="stepNum">1</span>
        <div className="stepBody">
          <h3>Pick your agent</h3>
          <p className="stepHint">These are the live AI traders on Arc. You can change later.</p>
          <div className="sourceChoices">
            {sources.length === 0 && <Empty text="No traders registered yet." />}
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
                    {source.followerCount.toString()} follow records · {(source.reputationScore / 100).toFixed(0)}% rep
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
            This is the budget for mirroring. It sits in escrow until your rule lets a trade through. You can withdraw any
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
          trades up to <strong>{preset.maxAmountPerIntent} USDC</strong> per intent gets copied to you. Anything over
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
          <dt>trader</dt>
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

function LiveFeed({
  receipts,
  closes,
  sourceNameByAddress,
  latestBlock,
  fetchedAt,
  loading,
  totalReceipts,
  account,
  closingIntentId,
  onClosePosition,
}: {
  receipts: ReceiptLog[];
  closes: PositionCloseLog[];
  sourceNameByAddress: Map<string, string>;
  latestBlock: bigint;
  fetchedAt: number;
  loading: boolean;
  totalReceipts: number;
  account?: Address;
  closingIntentId: bigint | null;
  onClosePosition: (intentId: bigint) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
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
  return (
    <section className="liveFeed" id="live-feed">
      <div className="liveFeedHeader">
        <div>
          <p className="eyebrow">
            <span className={`livePulse ${loading ? "loading" : ""}`} />
            live activity · auto refresh
          </p>
          <h2>Every onchain receipt across every trader.</h2>
        </div>
        <div className="liveFeedMeta">
          <div>
            <dt>latest block</dt>
            <dd>{latestBlock ? latestBlock.toString() : "—"}</dd>
          </div>
          <div>
            <dt>last fetch</dt>
            <dd>{secondsSince}s ago</dd>
          </div>
          <div>
            <dt>total receipts</dt>
            <dd>{totalReceipts}</dd>
          </div>
        </div>
      </div>
      <div className="liveFeedList">
        {receipts.length === 0 && <div className="empty">No receipts yet. Cron fires every 10 minutes.</div>}
        {receipts.map((receipt, index) => {
          const sourceName = sourceNameByAddress.get(receipt.sourceAgent.toLowerCase()) || shortAddress(receipt.sourceAgent);
          const blocksAgo = latestBlock && receipt.blockNumber ? Number(latestBlock - receipt.blockNumber) : 0;
          const receiptKey = `${receipt.follower.toLowerCase()}:${receipt.intentId.toString()}`;
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
                  </>
                ) : (
                  <>
                    <strong>{receipt.reason}</strong>
                    <span>{formatUSDC(receipt.usdcAmount)} USDC requested</span>
                  </>
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
            {kind === "copied" ? formatUSDC(receipt.usdcAmount) : "—"}
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
            <dt>builder fee</dt>
            <dd>{formatUSDC(receipt.mirrorFeeUSDC)} USDC</dd>
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
        <p className="eyebrow">builder fees accrued onchain</p>
        <h2>
          <span className="builderFeesAmount">{formatUSDC(totalFees)}</span>
          <span className="builderFeesUnit">USDC</span>
        </h2>
        <p className="builderFeesCaption">
          70% of every swap fee accrues to the trader that routed the flow, settled by{" "}
          <code>MirrorRouter</code> at the receipt event from {sourceCount === 1 ? "one source" : `${sourceCount} sources`}.
          No off-chain accounting.
        </p>
        <p className="builderFeesReference">
          Same primitive as <strong>Polymarket V2 builder fees</strong>: third parties that route order flow earn a share of taker fees. Shadow ports that pattern to copy trading.
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
  { label: "Reading onchain reputation for every trader", at: 0 },
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
    <section className="pilot">
      <header className="pilotHeader">
        <p className="eyebrow">AI pilot</p>
        <h2>Tell the AI your size and risk. It picks, weights, and watches.</h2>
        <p className="pilotLede">
          The Pilot reads every trader's onchain reputation, allocates your USDC across the best fits, and writes
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
                <dd>{a.recentCopies + a.recentBlocks === 0 ? "—" : `${(a.recentCopyRateBps / 100).toFixed(0)}%`}</dd>
              </div>
              <div>
                <dt>recent PnL avg</dt>
                <dd>{a.recentPnlAvgBps === null ? "—" : `${a.recentPnlAvgBps.toFixed(0)} bps`}</dd>
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
      <p className="eyebrow">same intent · two outcomes</p>
      <h2>One agent trades. Your policy decides what happens to you.</h2>
      <p className="spotlightSummary">
        A trader agent on Arc just wanted to swap 0.02 USDC. Two followers were watching with different rules.
        One had room. One didn&apos;t. Here&apos;s exactly what happens.
      </p>
      <div className="spotlightGrid">
        <article className="spotlightCard copied spotlightCard--demo">
          <div className="spotlightCardStamp">
            <span className="spotlightCardStampMark">✓</span>
            <span className="spotlightCardStampText">COPIED</span>
          </div>
          <p className="spotlightCardLabel">Follower A · policy let it through</p>
          <p className="spotlightCardFollower">0x82A2…DfeA</p>
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
          <p className="spotlightCardLabel">Follower B · policy refused</p>
          <p className="spotlightCardFollower">0xBD9B…3F87</p>
          <dl className="spotlightStats">
            <div>
              <dt>amount</dt>
              <dd className="spotlightCardAmount">—</dd>
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
        Live receipts populate this card once the next cron fires (every 10 minutes). The block reason on real receipts is whatever
        rule your policy hit first.
      </p>
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
          Same intent · two outcomes
        </span>
        <span className="heroLedgerLive">
          <span className="heroLedgerLiveDot" />
          Arc · block 8 411 902
        </span>
      </div>

      <div className="heroLedgerIntent">
        <span className="heroLedgerIntentLabel">Agent intent</span>
        <div className="heroLedgerIntentBody">
          <span className="agentTag">CatArb</span>
          <span className="heroLedgerIntentVerb">swap</span>
          <span className="heroLedgerIntentNumber">0.02&nbsp;USDC</span>
          <span className="heroLedgerIntentArrow">→</span>
          <span className="heroLedgerIntentNumber">0.0185&nbsp;ARCETH</span>
        </div>
      </div>

      <div className="heroLedgerSplit">
        <div className="heroLedgerCell copied">
          <div className="heroLedgerCellHead">
            <span className="heroLedgerCellStatus">
              <span className="heroLedgerCellDot" />
              COPIED
            </span>
            <span className="heroLedgerCellAddr">0x82A2…DfeA</span>
          </div>
          <div className="heroLedgerCellMain">+0.0185</div>
          <div className="heroLedgerCellUnit">ARCETH credited to follower</div>
          <div className="heroLedgerCellMeta">
            <span className="heroLedgerCellMetaLabel">policy</span>
            <span className="heroLedgerCellMetaValue">within cap · slippage 32&nbsp;bps · builder fee 0.05%</span>
          </div>
        </div>
        <div className="heroLedgerCell blocked">
          <div className="heroLedgerCellHead">
            <span className="heroLedgerCellStatus">
              <span className="heroLedgerCellDot" />
              BLOCKED
            </span>
            <span className="heroLedgerCellAddr">0xBD9B…3F87</span>
          </div>
          <div className="heroLedgerCellMain">0.00</div>
          <div className="heroLedgerCellUnit">USDC copied · blocked before spend</div>
          <div className="heroLedgerCellMeta">
            <span className="heroLedgerCellMetaLabel">policy rule</span>
            <span className="heroLedgerCellMetaValue">amount&nbsp;&gt;&nbsp;cap · 0.02&nbsp;USDC exceeds 0.01 cap</span>
          </div>
        </div>
      </div>

      <div className="heroLedgerProof">
        <span className="heroLedgerProofLabel">receipt</span>
        <span className="heroLedgerProofHash">0x9f2a…c4e1</span>
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
        { label: "Onboarding", href: "#circle-stack" },
        { label: "Live receipts", href: "#live-feed" },
        { label: "AI pilot", href: "#technical" },
      ],
    },
    {
      title: "Traders",
      links: [
        { label: "Earned reputation", href: "#traders" },
        { label: "Builder fees", href: "#technical" },
      ],
    },
    {
      title: "Resources",
      links: [
        { label: "Source on GitHub", href: "https://github.com/dolepee/shadow" },
        { label: "Arc explorer", href: "https://arc-testnet.explorer.thecanteenapp.com" },
        { label: "Chain ID 5042002", href: "https://arc-testnet.explorer.thecanteenapp.com" },
      ],
    },
  ];

  return (
    <footer className="siteFooter">
      <div className="siteFooterTop">
        <div className="siteFooterBrand">
          <a className="brand brandFooter" href="#top" aria-label="Shadow">
            <ShadowMark />
            <span>Shadow</span>
          </a>
          <p className="siteFooterTagline">
            Copy the best AI traders on Arc. Every copy and every refusal is an onchain receipt.
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
              {s.links.map((l) => (
                <a key={l.label} href={l.href} target={l.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                  {l.label}
                </a>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="siteFooterBottom">
        <span>Built for Canteen × Circle Agora Agents · 2026</span>
        <span>Shadow · onchain copy trading</span>
      </div>
    </footer>
  );
}

function HeroMetrics({ state }: { state: ShadowState | null }) {
  const numbers = useMemo(() => {
    if (!state) return { usdcMirrored: 0n, receipts: 0, traders: 0, followers: 0 };
    let usdcMirrored = 0n;
    const followers = new Set<string>();
    for (const r of state.receipts) {
      followers.add(r.follower.toLowerCase());
      if (r.status === "copied") usdcMirrored += r.usdcAmount;
    }
    return {
      usdcMirrored,
      receipts: state.receipts.length,
      traders: state.sources.length,
      followers: followers.size,
    };
  }, [state]);

  const items: Array<{ label: string; value: string }> = [
    { label: "USDC mirrored", value: formatUSDC(numbers.usdcMirrored) },
    { label: "onchain receipts", value: numbers.receipts.toString() },
    { label: "AI traders live", value: numbers.traders.toString() },
    { label: "followers", value: numbers.followers.toString() },
  ];

  const hasLiveData =
    numbers.receipts > 0 || numbers.traders > 0 || numbers.followers > 0 || numbers.usdcMirrored > 0n;

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
    <div className="heroMetrics" role="group" aria-label="Live numbers from Arc testnet">
      {items.map((m) => (
        <div className="heroMetric" key={m.label}>
          <span className="heroMetricValue">{m.value}</span>
          <span className="heroMetricLabel">{m.label}</span>
        </div>
      ))}
    </div>
  );
}

function TractionStrip({ state }: { state: ShadowState | null }) {
  const metrics = useMemo(() => {
    if (!state) {
      return {
        wallets: 0,
        usdcMirrored: 0n,
        intents: 0,
        copiedReceipts: 0,
        blockedReceipts: 0,
        closes: 0,
        avgPnlBps: 0,
        positivePnlCount: 0,
      };
    }
    const followers = new Set<string>();
    let usdcMirrored = 0n;
    let copiedReceipts = 0;
    let blockedReceipts = 0;
    for (const r of state.receipts) {
      followers.add(r.follower.toLowerCase());
      if (r.status === "copied") {
        copiedReceipts += 1;
        usdcMirrored += r.usdcAmount;
      } else {
        blockedReceipts += 1;
      }
    }
    let pnlSum = 0;
    let positivePnlCount = 0;
    for (const c of state.positionCloses) {
      const bps = Number(c.pnlBps);
      pnlSum += bps;
      if (bps > 0) positivePnlCount += 1;
    }
    const closes = state.positionCloses.length;
    return {
      wallets: followers.size,
      usdcMirrored,
      intents: state.intents.length,
      copiedReceipts,
      blockedReceipts,
      closes,
      avgPnlBps: closes ? pnlSum / closes : 0,
      positivePnlCount,
    };
  }, [state]);

  const metricsList: Array<{ label: string; value: string; sub: string }> = [
    {
      label: "Distinct followers",
      value: metrics.wallets.toString(),
      sub: "unique wallets across receipts",
    },
    {
      label: "USDC mirrored",
      value: formatUSDC(metrics.usdcMirrored),
      sub: `${metrics.copiedReceipts} copied · ${metrics.blockedReceipts} blocked`,
    },
    {
      label: "Intents published",
      value: metrics.intents.toString(),
      sub: "by registered traders",
    },
    {
      label: "Receipts onchain",
      value: (metrics.copiedReceipts + metrics.blockedReceipts).toString(),
      sub: "copy and block, no off chain truth",
    },
    {
      label: "Positions closed",
      value: metrics.closes.toString(),
      sub:
        metrics.closes > 0
          ? `${metrics.avgPnlBps >= 0 ? "+" : ""}${metrics.avgPnlBps.toFixed(0)} bps avg · ${metrics.positivePnlCount} positive`
          : "awaiting realized PnL",
    },
  ];

  const hasAnyTraction =
    metrics.wallets > 0 ||
    metrics.intents > 0 ||
    metrics.copiedReceipts > 0 ||
    metrics.blockedReceipts > 0 ||
    metrics.closes > 0 ||
    metrics.usdcMirrored > 0n;

  if (!hasAnyTraction) {
    return null;
  }

  return (
    <section className="traction" aria-label="Live traction">
      <div className="tractionHeader">
        <p className="eyebrow">the full picture · every metric derived from onchain events</p>
        <span className="tractionDot" /> <span className="tractionLive">live</span>
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
        Counts include both seeded developer wallets and any public follower. Computed live from MirrorReceipt and
        PositionClosed event logs, not a backend cache. If the indexer goes down, the chain is still the source of truth.
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
      eyebrow: "primitive · ERC 8004 source identity",
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
        <h2>The novelty is onchain, not in the UI chrome.</h2>
        <p className="primitiveLede">
          Shadow is a router that turns a single AI agent intent into per follower outcomes, all settled in one Arc testnet
          transaction with canonical receipts. The four primitives below are the load bearing pieces, every other surface in
          this dashboard is a view over them.
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
  return { tagline: "Onchain trader", accent: "#d8ff79", tone: "neutral" };
}

function EarnedReputationPanel({ rows, onFollow }: { rows: EarnedReputation[]; onFollow?: (addr: Address) => void }) {
  if (rows.length === 0) {
    return (
      <section className="reputationPanel">
        <Header eyebrow="meet the agents" title="AI traders you can follow" />
        <p className="reputationEmpty">No agents registered yet.</p>
      </section>
    );
  }
  const totalIntents = rows.reduce((sum, r) => sum + r.intentsPublished, 0);
  const totalCopies = rows.reduce((sum, r) => sum + r.copyCount, 0);
  const totalRouted = rows.reduce((sum, r) => sum + r.routedUSDC, 0n);
  return (
    <section className="reputationPanel" id="traders">
      <Header eyebrow="meet the agents" title="AI traders you can follow. Profiles, not metrics." />
      <p className="reputationCaption">
        These three agents publish trade intents on Arc every 10 minutes. Each card shows what they actually traded,
        who copied, who got blocked, and what they earned. Nothing self-reported.
      </p>
      <div className="reputationTotals">
        <span>{totalIntents} intents published</span>
        <span>{totalCopies} copies executed</span>
        <span>{formatUSDC(totalRouted)} USDC routed through followers</span>
      </div>
      <div className="reputationGrid">
        {rows.map((row, index) => {
          const persona = traderPersona(row.source.name);
          return (
          <article className={`reputationCard reputationCard--${persona.tone}`} key={row.source.address} style={{ ["--trader-accent" as string]: persona.accent }}>
            <header className="reputationCardHeader">
              <span className="reputationRank">#{index + 1}</span>
              <div className="reputationName">
                <strong>{row.source.name}</strong>
                <span className="reputationTagline">{persona.tagline}</span>
                <span className="reputationAddr">{shortAddress(row.source.address)}</span>
              </div>
              <span className="reputationRegistry">
                ERC-8004 score {score(row.source.reputationScore)}
              </span>
            </header>
            {row.lastIntent && (
              <div className="reputationLastIntent">
                <span className="reputationLastIntentLabel">Last trade</span>
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
                    ? "—"
                    : `${(row.copyRateBps / 100).toFixed(1)}%`
                }
                subtext={`${row.copyCount} copied / ${row.blockCount} blocked`}
              />
              <ReputationStat
                label="USDC routed"
                value={formatUSDC(row.routedUSDC)}
              />
              <ReputationStat
                label="builder fees earned"
                value={formatUSDC(row.source.kickbackUSDC)}
                subtext={`${formatUSDC(row.mirrorFeesUSDC)} USDC swap fees · 70% accrued to trader`}
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
                  row.closedCount === 0 ? "—" : `avg over ${row.closedCount} closed positions`
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
            <AppKitTipButton
              sourceAddress={row.source.address}
              sourceName={row.source.name}
            />
          </article>
          );
        })}
      </div>
    </section>
  );
}

type TipStatus =
  | { kind: "idle" }
  | { kind: "sending"; stage: string }
  | { kind: "success"; txHash?: string }
  | { kind: "error"; message: string };

function AppKitTipButton({
  sourceAddress,
  sourceName,
}: {
  sourceAddress: Address;
  sourceName: string;
}) {
  const kitKey = (import.meta.env.VITE_CIRCLE_KIT_KEY || "").trim();
  const [status, setStatus] = useState<TipStatus>({ kind: "idle" });

  if (!kitKey) {
    return (
      <div className="appKitTip">
        <button type="button" className="appKitTipButton" disabled>
          Tip {sourceName} via Circle App Kit
        </button>
        <p className="appKitTipMeta">
          Set <code>VITE_CIRCLE_KIT_KEY</code> in env (Circle Console → Kit Keys) to enable <code>AppKit.send</code> tips.
        </p>
      </div>
    );
  }

  async function send() {
    const provider = typeof window !== "undefined" ? (window as any).ethereum : undefined;
    if (!provider) {
      setStatus({ kind: "error", message: "Connect an EVM wallet to tip via Circle App Kit." });
      return;
    }
    setStatus({ kind: "sending", stage: "preparing adapter" });
    try {
      await provider.request({ method: "eth_requestAccounts" });
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x4cef52" }],
      }).catch(async (err: any) => {
        if (err && (err.code === 4902 || err.code === -32603)) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x4cef52",
                chainName: "Arc Testnet",
                nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
                rpcUrls: [arcTestnet.rpcUrls.default.http[0]],
                blockExplorerUrls: ["https://testnet.arcscan.app"],
              },
            ],
          });
        } else {
          throw err;
        }
      });
      const adapter = await createViemAdapterFromProvider({ provider });
      setStatus({ kind: "sending", stage: "submitting USDC transfer" });
      const kit = new AppKit();
      const step = await kit.send({
        from: { adapter, chain: "Arc_Testnet" as any },
        to: sourceAddress,
        amount: "0.01",
        token: "USDC",
      });
      if (step.state === "error") {
        setStatus({ kind: "error", message: step.errorMessage || "Send failed" });
        return;
      }
      setStatus({ kind: "success", txHash: step.txHash });
    } catch (err: any) {
      const message =
        err?.shortMessage || err?.message || String(err) || "Tip failed";
      setStatus({ kind: "error", message });
    }
  }

  return (
    <div className="appKitTip">
      <button
        type="button"
        className="appKitTipButton"
        onClick={send}
        disabled={status.kind === "sending"}
      >
        {status.kind === "sending"
          ? `Sending… ${status.stage}`
          : `Tip ${sourceName} 0.01 USDC via Circle App Kit`}
      </button>
      <p className="appKitTipMeta">
        Calls <code>AppKit.send</code> with <code>chain: "Arc_Testnet"</code>. Same Circle SDK that ships in Wallet Wars.
      </p>
      {status.kind === "success" && (
        <p className="appKitTipOk">
          Tip routed.{" "}
          {status.txHash ? (
            <a href={txUrl(status.txHash as `0x${string}`)} target="_blank" rel="noreferrer">
              view tx
            </a>
          ) : (
            "Confirmed."
          )}
        </p>
      )}
      {status.kind === "error" && <p className="appKitTipErr">{status.message}</p>}
    </div>
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

type SwapDirection = "USDC_TO_EURC" | "EURC_TO_USDC";

type SwapState =
  | { kind: "idle" }
  | { kind: "running"; stage: string }
  | { kind: "success"; txHash: string; explorerUrl?: string; amountOut?: string; tokenOut: string }
  | { kind: "error"; message: string };

function CircleStackPanel() {
  const kitKey = (import.meta.env.VITE_CIRCLE_KIT_KEY || "").trim();
  const [direction, setDirection] = useState<SwapDirection>("USDC_TO_EURC");
  const [amount, setAmount] = useState("0.05");
  const [status, setStatus] = useState<SwapState>({ kind: "idle" });

  const [tokenIn, tokenOut] =
    direction === "USDC_TO_EURC" ? ["USDC", "EURC"] : ["EURC", "USDC"];

  async function runSwap() {
    if (!kitKey) {
      setStatus({ kind: "error", message: "Set VITE_CIRCLE_KIT_KEY in env to enable AppKit.swap." });
      return;
    }
    const provider = typeof window !== "undefined" ? (window as any).ethereum : undefined;
    if (!provider) {
      setStatus({ kind: "error", message: "Connect an EVM wallet first." });
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setStatus({ kind: "error", message: "Enter an amount greater than 0." });
      return;
    }
    setStatus({ kind: "running", stage: "switching to Arc Testnet" });
    try {
      await switchToArc();
      setStatus({ kind: "running", stage: "preparing Circle adapter" });
      const adapter = await createViemAdapterFromProvider({ provider });
      setStatus({ kind: "running", stage: `routing ${tokenIn} → ${tokenOut} via Circle stablecoin service` });
      const kit = new AppKit();
      const result = await kit.swap({
        from: { adapter, chain: "Arc_Testnet" as any },
        tokenIn: tokenIn as any,
        tokenOut: tokenOut as any,
        amountIn: amount,
        config: { kitKey } as any,
      });
      setStatus({
        kind: "success",
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        amountOut: result.amountOut,
        tokenOut,
      });
    } catch (err: any) {
      const raw =
        err?.shortMessage || err?.message || String(err) || "Swap failed";
      const looksLikeNoRoute =
        /createSwap failed|Failed to fetch|no route|UnsupportedRoute/i.test(raw);
      const message = looksLikeNoRoute
        ? "Circle Stablecoin Service has no DEX route on Arc Testnet yet. The SDK call is wired (chain in enum, kitKey passed inline); once Arc Testnet appears in the routing graph this swap goes live without code changes."
        : raw;
      setStatus({ kind: "error", message });
    }
  }

  function flip() {
    setDirection((d) => (d === "USDC_TO_EURC" ? "EURC_TO_USDC" : "USDC_TO_EURC"));
    setStatus({ kind: "idle" });
  }

  // AppKit.swap is wired (runSwap below) but hidden from the homepage: Circle's
  // stablecoin service has no DEX route on Arc Testnet yet, so a visible button
  // would only ever error. Keeping the call site lets us light up the swap card
  // the moment Arc Testnet appears in the routing graph, without code changes.
  void runSwap;
  void flip;
  void tokenIn;
  void tokenOut;

  return (
    <section id="circle-stack" className="circleStackPanel">
      <Header
        eyebrow="circle stack on arc"
        title="One click follower onboarding, sponsored by Circle Gas Station"
      />
      <p className="circleStackCaption">
        Tip buttons on each trader invoke <code>AppKit.send</code>. The card
        below uses <code>@circle-fin/modular-wallets-core</code> to mint a passkey
        owned smart account and then approve, deposit, and call{" "}
        <code>followSource</code> in one batched UserOp paid for by Circle Gas
        Station. The smart account becomes a real Shadow follower with its own{" "}
        <code>minBpsOut</code>. Removing this section degrades onboarding by four
        clicks and a gas token requirement, so it is load bearing, not decorative.
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
  | { kind: "sent"; address: Address; userOpHash: string; txHash?: string }
  | { kind: "error"; message: string; address?: Address };

const CREDENTIAL_STORAGE_KEY = "shadow:circleModularCredential";
const SPONSORED_SOURCE_AGENT = "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address;

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
          args: [trackedAddress, SPONSORED_SOURCE_AGENT],
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
  }, [trackedAddress, state.kind]);

  async function loadCredential(): Promise<WebAuthnCredential | null> {
    try {
      const raw = sessionStorage.getItem(CREDENTIAL_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as WebAuthnCredential;
    } catch {
      return null;
    }
  }

  function persistCredential(cred: WebAuthnCredential) {
    try {
      sessionStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(cred));
    } catch {
      // sessionStorage failures are non-fatal — credential survives only this tab
    }
  }

  async function withSmartAccount(cred: WebAuthnCredential) {
    const modularTransport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
    const client = createClient({
      chain: arcTestnet,
      transport: modularTransport,
    }) as any;
    const owner = toWebAuthnAccount({ credential: cred });
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
    try {
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
      setState({ kind: "error", message: err?.message || String(err) });
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
      state.kind === "ready" || state.kind === "funded" || state.kind === "error"
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
          SPONSORED_SOURCE_AGENT,
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
          SPONSORED_SOURCE_AGENT,
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
              <span className="modularChipOk">Following CatArb</span>
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
            USDC from the faucet, then approve, deposit, and call{" "}
            <code>followSource</code> on CatArb in a single batched UserOp with{" "}
            <code>paymaster: true</code>. The smart account becomes a real Shadow
            follower with its own minBpsOut policy. Circle Gas Station pays the gas,
            so a new follower can start mirroring on Arc without ever holding native
            gas first.
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
                        : "Funded ✓ — re-fund"
                      : "Fund smart account (0.05 USDC)"}
                </button>
                <button
                  type="button"
                  className="modularBtnPrimary"
                  onClick={onSponsoredFollow}
                  disabled={state.kind === "sending" || state.kind === "funding"}
                >
                  {state.kind === "sending"
                    ? `Following… ${state.stage}`
                    : "Follow CatArb (approve + deposit + followSource, sponsored)"}
                </button>
                {(followerPolicy?.active || state.kind === "sent") && (
                  <button
                    type="button"
                    className="modularBtnSecondary"
                    onClick={onTunePolicy}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                  >
                    {state.kind === "sending"
                      ? `Tuning… ${state.stage}`
                      : "Loosen slippage to minBpsOut 9000 (sponsored)"}
                  </button>
                )}
              </div>
              {state.kind === "funded" && state.tx && (
                <p className="modularInfo">
                  Faucet tx{" "}
                  <a href={txUrl(state.tx as `0x${string}`)} target="_blank" rel="noreferrer">
                    {state.tx.slice(0, 10)}…
                  </a>
                  . Now click follow CatArb. Circle Gas Station sponsors all three
                  calls in one batched UserOp.
                </p>
              )}
            </div>
          )}
          {state.kind === "sent" && (
            <p className="modularOk">
              <strong>Zero gas paid by your wallet.</strong> Circle Gas Station
              sponsored the entire batched UserOp (approve + deposit +
              followSource). Smart account is now a live CatArb follower with
              its own minBpsOut policy.{" "}
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
