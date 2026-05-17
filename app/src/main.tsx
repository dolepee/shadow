import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createWalletClient, custom, parseUnits, type Address } from "viem";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
  type WebAuthnCredential,
} from "@circle-fin/modular-wallets-core";
import { createBundlerClient } from "viem/account-abstraction";
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
      const response = await fetch("/api/verify-slippage", { method: "POST" });
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

  return (
    <main className="shell">
      <nav className="nav">
        <span className="brand">Shadow</span>
        <div className="navActions">
          <span>Arc testnet</span>
          <button onClick={connectWallet}>{account ? shortAddress(account) : "connect wallet"}</button>
        </div>
      </nav>

      <section className="hero">
        <p className="eyebrow">agent intent following</p>
        <h1>Follow AI trading agents with policy controlled USDC mirroring.</h1>
        <p className="lede">
          A source agent publishes an intent. Shadow checks each follower policy. One follower can copy through a controlled
          Arc testnet AMM while another is blocked with an onchain receipt. Source agents earn a 70% builder fee on every
          mirrored swap.
        </p>
        {!isConfigured && (
          <div className="warning">
            Add Vite contract addresses after deployment to switch this dashboard from product shell to live mode.
          </div>
        )}
      </section>

      <TechnicalPrimitive state={state} />

      <BuilderFeesBanner state={state} />

      <HowItWorks />

      {spotlight && (
        <section className="spotlight">
          <p className="eyebrow">policy split · live on Arc testnet</p>
          <h2>One source intent. Two follower outcomes.</h2>
          <p className="spotlightSummary">
            {sourceNameByAddress.get(spotlight.intent.sourceAgent.toLowerCase()) || shortAddress(spotlight.intent.sourceAgent)}{" "}
            published intent #{spotlight.intent.intentId.toString()} for {formatUSDC(spotlight.intent.amountUSDC)} USDC.
            The router fanned it out: one follower&apos;s policy let the swap through, another&apos;s blocked it. Both outcomes
            settled in a single tx without cascade reverts.
          </p>
          <div className="spotlightGrid">
            <SpotlightCard
              verdict="BLOCKED"
              kind="blocked"
              label="Follower · policy blocked"
              follower={spotlight.blocked.follower}
              receipt={spotlight.blocked}
              detail={`Router emitted blocked receipt with reason "${spotlight.blocked.reason}". No swap, no fee, no debit.`}
            />
            <SpotlightCard
              verdict="COPIED"
              kind="copied"
              label="Follower · policy allowed"
              follower={spotlight.copied.follower}
              receipt={spotlight.copied}
              detail="Swap cleared through the controlled AMM. Mirror fee accrued and source builder fee routed."
            />
          </div>

          <div className="liveVerify">
            <div className="liveVerifyHeader">
              <p className="eyebrow">don't trust the screenshot</p>
              <p className="liveVerifyLede">
                Publish a fresh demo intent right now. The button calls a Vercel function that signs as CatArb, picks an intent.minAmountOut to land between the two scaled minimums, waits for the MirrorReceipts, and prints them below. One run per minute.
              </p>
            </div>
            <button className="liveVerifyButton" onClick={runVerify} disabled={verifying}>
              {verifying ? "publishing intent…" : "run verify now"}
            </button>
            {verifyError && <div className="liveVerifyError">error: {verifyError}</div>}
            {verifyResult && <VerifyResultPanel result={verifyResult} />}
          </div>
        </section>
      )}

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

      <LatestReasoningPanel data={reasoning} />

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

      <section className="grid">
        <Stat label="registered agents" value={String(state?.sources.length || 0)} />
        <Stat label="intent receipts" value={String(state?.receipts.length || 0)} />
        <Stat label="USDC mirrored" value={formatUSDC(totalMirrored(copiedReceipts))} />
        <Stat label="blocked copies" value={String(blockedReceipts.length)} />
        <Stat label="builder fees paid" value={formatUSDC(totalKickbacks(state))} />
        <Stat label="1 USDC quote" value={`${formatAsset(state?.quoteForOneUSDC || 0n)} ARCETH`} />
      </section>

      <EarnedReputationPanel rows={state ? computeEarnedReputation(state) : []} />

      <CircleStackPanel />

      <section className="panel">
        <Header eyebrow="controlled AMM" title="Real onchain exchange path, intentionally small" />
        <div className="reserveGrid">
          <Stat label="USDC reserve" value={formatUSDC(state?.reserves.usdc || 0n)} />
          <Stat label="ARCETH reserve" value={formatAsset(state?.reserves.asset || 0n)} />
          <Stat label="next intent id" value={String(state?.nextIntentId || 1n)} />
        </div>
      </section>
    </main>
  );
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
      title: "Source agent publishes",
      body: "An AI agent emits a USDC denominated intent on Arc with a minBpsOut slippage hint.",
    },
    {
      num: "02",
      title: "Router checks each policy",
      body: "Every follower has on chain limits. The router decides copy, block, or skip per follower.",
    },
    {
      num: "03",
      title: "AMM executes the swap",
      body: "Approved follower USDC swaps through a controlled pool. Mirror fee splits to protocol and source.",
    },
    {
      num: "04",
      title: "Receipt and builder fee",
      body: "Every outcome is a MirrorReceipt log. 70% of the mirror fee accrues to the source as a builder fee, anyone can read it onchain.",
    },
  ];
  return (
    <section className="howItWorks">
      <p className="eyebrow">how Shadow works</p>
      <h2 className="howTitle">Four onchain steps from agent signal to follower receipt.</h2>
      <div className="howSteps">
        {steps.map((step) => (
          <div className="howStep" key={step.num}>
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
    <section className="followFlow">
      <header className="followHeader">
        <p className="eyebrow">become a follower</p>
        <h2>Pick a source, pick a risk profile, follow in one flow.</h2>
        <p className="lede">
          Connect your wallet, deposit Arc USDC, and your wallet will mirror every intent the source agent publishes,
          gated by the policy you choose. Each policy can be raised or lowered at any time.
        </p>
      </header>

      <div className="followStep">
        <span className="stepNum">1</span>
        <div className="stepBody">
          <h3>Pick a source agent</h3>
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
          <h3>Pick a risk profile</h3>
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
          <h3>Choose deposit</h3>
          <p className="stepHint">
            USDC moves into the router escrow. Mirror fees come out of this balance. You can deposit zero if you have
            already funded. Need Arc testnet USDC? Grab some from{" "}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer noopener">
              Circle's faucet
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

      <div className="followAction">
        {!account ? (
          <button className="followCta" onClick={connectWallet} type="button">
            connect wallet to continue
          </button>
        ) : (
          <button className="followCta" onClick={onFollow} disabled={following} type="button">
            {following ? "submitting…" : `follow ${selectedName} with ${preset.label.toLowerCase()} policy`}
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
          <dt>source agent</dt>
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
    <section className="liveFeed">
      <div className="liveFeedHeader">
        <div>
          <p className="eyebrow">
            <span className={`livePulse ${loading ? "loading" : ""}`} />
            live activity · auto refresh
          </p>
          <h2>Every onchain receipt across every source agent.</h2>
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
        {receipts.map((receipt) => {
          const sourceName = sourceNameByAddress.get(receipt.sourceAgent.toLowerCase()) || shortAddress(receipt.sourceAgent);
          const blocksAgo = latestBlock && receipt.blockNumber ? Number(latestBlock - receipt.blockNumber) : 0;
          const receiptKey = `${receipt.follower.toLowerCase()}:${receipt.intentId.toString()}`;
          const canClose =
            receipt.status === "copied" &&
            Boolean(accountKey) &&
            receipt.follower.toLowerCase() === accountKey &&
            !closedByFollowerIntent.has(receiptKey);
          return (
            <article className={`liveFeedRow ${receipt.status}`} key={`${receipt.transactionHash}-${receipt.follower}`}>
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
      <p className="eyebrow">{label}</p>
      <h3>{verdict}</h3>
      <span className="follower">{shortAddress(follower)}</span>
      <dl className="spotlightStats">
        <div>
          <dt>USDC routed</dt>
          <dd>{formatUSDC(receipt.usdcAmount)}</dd>
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
        {receipt.status === "blocked" && (
          <div>
            <dt>block reason</dt>
            <dd>{receipt.reason}</dd>
          </div>
        )}
      </dl>
      <p className="spotlightDetail">{detail}</p>
      <a className="spotlightLink" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer noopener">
        receipt tx · {shortAddress(receipt.transactionHash)}
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
        <p className="eyebrow">builder fees · 70% of every mirror fee</p>
        <h2>
          <span className="builderFeesAmount">{formatUSDC(totalFees)}</span>
          <span className="builderFeesUnit">USDC</span>
        </h2>
        <p className="builderFeesCaption">
          accrued to source agents from {sourceCount === 1 ? "one source" : `${sourceCount} sources`}, all settled by{" "}
          <code>ShadowRouter.fanOut</code> at the receipt event. No off-chain accounting.
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
      body: "Both copied and blocked outcomes emit MirrorReceipt logs with usdcAmount, minBps applied, and the kickback paid. Every decision is independently verifiable by reading chain state.",
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
    <section className="primitive">
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

function EarnedReputationPanel({ rows }: { rows: EarnedReputation[] }) {
  if (rows.length === 0) {
    return (
      <section className="reputationPanel">
        <Header eyebrow="earned reputation" title="What source agents have actually done onchain" />
        <p className="reputationEmpty">No source agents registered yet.</p>
      </section>
    );
  }
  const totalIntents = rows.reduce((sum, r) => sum + r.intentsPublished, 0);
  const totalCopies = rows.reduce((sum, r) => sum + r.copyCount, 0);
  const totalRouted = rows.reduce((sum, r) => sum + r.routedUSDC, 0n);
  return (
    <section className="reputationPanel">
      <Header eyebrow="earned reputation" title="What source agents have actually done onchain" />
      <p className="reputationCaption">
        Ranked by mirror fees actually earned. Every number here is derived from{" "}
        <code>IntentPublished</code>, <code>MirrorReceipt</code>, and{" "}
        <code>PositionClosed</code> events; nothing is self-reported.
      </p>
      <div className="reputationTotals">
        <span>{totalIntents} intents published</span>
        <span>{totalCopies} copies executed</span>
        <span>{formatUSDC(totalRouted)} USDC routed through followers</span>
      </div>
      <div className="reputationGrid">
        {rows.map((row, index) => (
          <article className="reputationCard" key={row.source.address}>
            <header className="reputationCardHeader">
              <span className="reputationRank">#{index + 1}</span>
              <div className="reputationName">
                <strong>{row.source.name}</strong>
                <span className="reputationAddr">{shortAddress(row.source.address)}</span>
              </div>
              <span className="reputationRegistry">
                ERC-8004 score {score(row.source.reputationScore)}
              </span>
            </header>
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
                label="mirror fees earned"
                value={formatUSDC(row.mirrorFeesUSDC)}
                subtext={`70% builder fee · ${formatUSDC(row.source.kickbackUSDC)} USDC accrued`}
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
            <AppKitTipButton
              sourceAddress={row.source.address}
              sourceName={row.source.name}
            />
          </article>
        ))}
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
  const [status, setStatus] = useState<TipStatus>({ kind: "idle" });

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
  const [direction, setDirection] = useState<SwapDirection>("USDC_TO_EURC");
  const [amount, setAmount] = useState("0.05");
  const [status, setStatus] = useState<SwapState>({ kind: "idle" });

  const [tokenIn, tokenOut] =
    direction === "USDC_TO_EURC" ? ["USDC", "EURC"] : ["EURC", "USDC"];

  async function runSwap() {
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
      });
      setStatus({
        kind: "success",
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        amountOut: result.amountOut,
        tokenOut,
      });
    } catch (err: any) {
      const message =
        err?.shortMessage || err?.message || String(err) || "Swap failed";
      setStatus({ kind: "error", message });
    }
  }

  function flip() {
    setDirection((d) => (d === "USDC_TO_EURC" ? "EURC_TO_USDC" : "USDC_TO_EURC"));
    setStatus({ kind: "idle" });
  }

  return (
    <section className="circleStackPanel">
      <Header
        eyebrow="circle stack on arc"
        title="App Kit Send, Swap, and Modular Wallets — three Circle products live on the same page"
      />
      <p className="circleStackCaption">
        Tip buttons on each source agent invoke <code>AppKit.send</code>. The swap
        below invokes <code>AppKit.swap</code>, routed through Circle&apos;s stablecoin
        service for USDC ↔ EURC. The card on the right uses{" "}
        <code>@circle-fin/modular-wallets-core</code> to mint a passkey-owned smart
        account and pay zero gas via Circle Gas Station. All three are Circle&apos;s own SDKs, not a third-party shim.
      </p>
      <div className="circleStackGrid">
        <div className="swapCard">
          <div className="swapRow">
            <label>
              <span>From</span>
              <strong>{tokenIn}</strong>
            </label>
            <button type="button" className="swapFlip" onClick={flip} disabled={status.kind === "running"}>
              ⇅
            </button>
            <label>
              <span>To</span>
              <strong>{tokenOut}</strong>
            </label>
          </div>
          <label className="swapAmountField">
            <span>Amount in {tokenIn}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={status.kind === "running"}
            />
          </label>
          <button
            type="button"
            className="swapSubmit"
            onClick={runSwap}
            disabled={status.kind === "running"}
          >
            {status.kind === "running" ? `Swapping… ${status.stage}` : `Swap via Circle App Kit`}
          </button>
          {status.kind === "success" && (
            <p className="swapOk">
              Swap confirmed.{" "}
              {status.amountOut !== undefined
                ? `Received ${status.amountOut} ${status.tokenOut}.`
                : ""}
              {" "}
              {status.explorerUrl ? (
                <a href={status.explorerUrl} target="_blank" rel="noreferrer">
                  view tx
                </a>
              ) : (
                <a href={txUrl(status.txHash as `0x${string}`)} target="_blank" rel="noreferrer">
                  view tx
                </a>
              )}
            </p>
          )}
          {status.kind === "error" && <p className="swapErr">{status.message}</p>}
        </div>
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
  | { kind: "sending"; stage: string; address: Address }
  | { kind: "sent"; address: Address; userOpHash: string; txHash?: string }
  | { kind: "error"; message: string; address?: Address };

const CREDENTIAL_STORAGE_KEY = "shadow:circleModularCredential";

function ModularWalletCard() {
  const clientKey = (import.meta.env.VITE_CIRCLE_CLIENT_KEY || "").trim();
  const clientUrl = (import.meta.env.VITE_CIRCLE_CLIENT_URL || "").trim();
  const recipient = (import.meta.env.VITE_SHADOW_ROUTER || "").trim() as Address;

  const initial: ModularWalletState =
    !clientKey || !clientUrl
      ? {
          kind: "configMissing",
          reason:
            "Set VITE_CIRCLE_CLIENT_KEY and VITE_CIRCLE_CLIENT_URL in your env (Circle Console → Modular Wallets) to enable passkey onboarding + Gas Station.",
        }
      : { kind: "idle" };

  const [state, setState] = useState<ModularWalletState>(initial);

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
    const smartAccount = await toCircleSmartAccount({ client, owner: cred as any });
    const bundler = createBundlerClient({
      account: smartAccount,
      chain: arcTestnet,
      transport: modularTransport,
      paymaster: true,
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

  async function onSponsoredTip() {
    if (state.kind !== "ready") return;
    const accountAddress = state.address;
    if (!recipient) {
      setState({ kind: "error", message: "VITE_SHADOW_ROUTER not set; nothing to tip.", address: accountAddress });
      return;
    }
    setState({ kind: "sending", stage: "loading passkey credential", address: accountAddress });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing — log in again.");
      setState({ kind: "sending", stage: "encoding USDC transfer", address: accountAddress });
      const { smartAccount, bundler } = await withSmartAccount(credential);
      const transferData = encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "transfer",
            stateMutability: "nonpayable",
            inputs: [
              { name: "to", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ],
        functionName: "transfer",
        args: [recipient, parseUnits("0.01", 6)],
      });
      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor", address: accountAddress });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [
          {
            to: addresses.usdc as Address,
            value: 0n,
            data: transferData,
          },
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
      setState({
        kind: "error",
        message: err?.shortMessage || err?.message || String(err),
        address: accountAddress,
      });
    }
  }

  return (
    <div className="modularCard">
      <div className="modularHeader">
        <span className="modularBadge">Modular Wallets · MSCA · ERC-4337</span>
        <h3>Passkey onboarding with sponsored gas</h3>
      </div>
      {state.kind === "configMissing" ? (
        <p className="modularEmpty">{(state as any).reason}</p>
      ) : (
        <>
          <p className="modularBody">
            Create a Circle MSCA owned by your device passkey, then send a 0.01 USDC
            payment with <code>paymaster: true</code>. Circle Gas Station pays the
            gas — followers can onboard without holding a single USDC for gas first.
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
          {(state.kind === "ready" || state.kind === "sending" || state.kind === "sent" || (state.kind === "error" && (state as any).address)) && (
            <div className="modularAccount">
              <p>
                <span>Smart account</span>{" "}
                <code>{shortAddress((state as any).address)}</code>
              </p>
              <button
                type="button"
                className="modularBtnPrimary"
                onClick={onSponsoredTip}
                disabled={state.kind === "sending"}
              >
                {state.kind === "sending"
                  ? `Sending… ${state.stage}`
                  : "Send 0.01 USDC, gas sponsored by Circle"}
              </button>
            </div>
          )}
          {state.kind === "sent" && (
            <p className="modularOk">
              UserOp confirmed.{" "}
              {state.txHash ? (
                <a href={txUrl(state.txHash as `0x${string}`)} target="_blank" rel="noreferrer">
                  view tx
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

createRoot(document.getElementById("root")!).render(<App />);
