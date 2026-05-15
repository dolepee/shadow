import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createWalletClient, custom, encodePacked, keccak256, parseUnits, type Address } from "viem";
import {
  addresses,
  arcTestnet,
  erc20Abi,
  fetchShadowState,
  formatAsset,
  formatUSDC,
  isConfigured,
  publicClient,
  routerAbi,
  shortAddress,
  txUrl,
  type ReceiptLog,
  type ShadowState,
} from "./chain";

const SPOTLIGHT = {
  intentId: 3n,
  amountUSDC: "0.5",
  intentMinAmountOut: "0.05",
  followerA: {
    address: "0x495cb55E288E9105E3b3080F2A7323F870538695" as Address,
    minBpsOut: 10000,
    label: "strict",
    scaledMin: "0.05",
  },
  followerB: {
    address: "0x7A3FFC0294f21E040b2bEa3e5Aad33cA08B33AcD" as Address,
    minBpsOut: 9000,
    label: "lenient",
    scaledMin: "0.045",
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

function App() {
  const [state, setState] = useState<ShadowState | null>(null);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<Address>();
  const [action, setAction] = useState<ActionState>({ label: "ready" });

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
  }, []);

  const copiedReceipts = useMemo(() => state?.receipts.filter((receipt) => receipt.status === "copied") || [], [state]);
  const blockedReceipts = useMemo(() => state?.receipts.filter((receipt) => receipt.status === "blocked") || [], [state]);
  const catAgent = state?.sources[0];
  const spotlight = useMemo(() => {
    const matches = state?.receipts.filter((receipt) => receipt.intentId === SPOTLIGHT.intentId) || [];
    return {
      a: matches.find((r) => r.follower.toLowerCase() === SPOTLIGHT.followerA.address.toLowerCase()),
      b: matches.find((r) => r.follower.toLowerCase() === SPOTLIGHT.followerB.address.toLowerCase()),
    };
  }, [state]);
  const spotlightLiveQuote = spotlight.b ? formatAsset(spotlight.b.assetAmountOut) : "—";

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

  async function depositFiveUSDC() {
    await writeTx("deposit 5 USDC", async (wallet, user) => {
      const amount = parseUnits("5", 6);
      const approveTx = await wallet.writeContract({
        account: user,
        address: addresses.usdc!,
        abi: erc20Abi,
        functionName: "approve",
        args: [addresses.router!, amount],
        chain: arcTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
      return wallet.writeContract({
        account: user,
        address: addresses.router!,
        abi: routerAbi,
        functionName: "depositUSDC",
        args: [amount],
        chain: arcTestnet,
      });
    });
  }

  async function followCatArb() {
    if (!catAgent) {
      setAction({ label: "no source agent", error: "Seed CatArb before following." });
      return;
    }
    await writeTx("follow CatArb", (wallet, user) =>
      wallet.writeContract({
        account: user,
        address: addresses.router!,
        abi: routerAbi,
        functionName: "followSource",
        args: [catAgent.address, parseUnits("2", 6), parseUnits("5", 6), addresses.arceth!, 3, 9_500],
        chain: arcTestnet,
      }),
    );
  }

  async function publishOneUSDCIntent() {
    await writeTx("publish intent", (wallet, user) => {
      const intentHash = keccak256(encodePacked(["string", "address", "uint256"], ["cat-arb-ui-intent", user, BigInt(Date.now())]));
      return wallet.writeContract({
        account: user,
        address: addresses.router!,
        abi: routerAbi,
        functionName: "publishIntent",
        args: [
          {
            asset: addresses.arceth!,
            amountUSDC: parseUnits("1", 6),
            minAmountOut: 1n,
            riskLevel: 2,
            expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
            intentHash,
          },
        ],
        chain: arcTestnet,
      });
    });
  }

  async function writeTx(label: string, fn: (wallet: ReturnType<typeof createWalletClient>, user: Address) => Promise<`0x${string}`>) {
    if (!isConfigured || !addresses.router || !window.ethereum) {
      setAction({ label, error: "Configure addresses and connect a wallet first." });
      return;
    }
    const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
    await switchToArc();
    setAccount(user);
    const wallet = createWalletClient({
      account: user,
      chain: arcTestnet,
      transport: custom(window.ethereum),
    });

    try {
      setAction({ label: `${label} pending` });
      const tx = await fn(wallet, user);
      setAction({ label: `${label} sent`, tx });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAction({ label: `${label} confirmed`, tx });
      await refresh();
    } catch (error) {
      setAction({ label: `${label} failed`, error: error instanceof Error ? error.message : String(error) });
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
          Arc testnet AMM while another is blocked with an onchain receipt.
        </p>
        {!isConfigured && (
          <div className="warning">
            Add Vite contract addresses after deployment to switch this dashboard from product shell to live mode.
          </div>
        )}
      </section>

      {spotlight.a && spotlight.b && (
        <section className="spotlight">
          <p className="eyebrow">v2 slippage demo · live on Arc testnet</p>
          <h2>One source intent. Two follower outcomes.</h2>
          <p className="spotlightSummary">
            CatArb published intent #{SPOTLIGHT.intentId.toString()} for {SPOTLIGHT.amountUSDC} USDC at minimum {SPOTLIGHT.intentMinAmountOut} ARCETH. The live AMM quoted {spotlightLiveQuote} ARCETH. Each follower's own minBpsOut decides the outcome — the source intent no longer cascade-reverts.
          </p>
          <div className="spotlightGrid">
            <SpotlightCard
              verdict="BLOCKED"
              kind="blocked"
              label={`Follower A · ${SPOTLIGHT.followerA.label}`}
              follower={SPOTLIGHT.followerA.address}
              minBps={SPOTLIGHT.followerA.minBpsOut}
              scaledMin={SPOTLIGHT.followerA.scaledMin}
              liveQuote={spotlightLiveQuote}
              receipt={spotlight.a}
              detail="Scaled minimum exceeds the live AMM quote. No swap, no fee, no debit."
            />
            <SpotlightCard
              verdict="COPIED"
              kind="copied"
              label={`Follower B · ${SPOTLIGHT.followerB.label}`}
              follower={SPOTLIGHT.followerB.address}
              minBps={SPOTLIGHT.followerB.minBpsOut}
              scaledMin={SPOTLIGHT.followerB.scaledMin}
              liveQuote={spotlightLiveQuote}
              receipt={spotlight.b}
              detail="Scaled minimum sits below the live quote. The swap clears, fee accrues, kickback routes to CatArb."
            />
          </div>
        </section>
      )}

      <section className="grid">
        <Stat label="registered agents" value={String(state?.sources.length || 0)} />
        <Stat label="intent receipts" value={String(state?.receipts.length || 0)} />
        <Stat label="USDC mirrored" value={formatUSDC(totalMirrored(copiedReceipts))} />
        <Stat label="blocked copies" value={String(blockedReceipts.length)} />
        <Stat label="source kickbacks" value={formatUSDC(totalKickbacks(state))} />
        <Stat label="1 USDC quote" value={`${formatAsset(state?.quoteForOneUSDC || 0n)} ARCETH`} />
      </section>

      <section className="panel">
        <div>
          <p className="eyebrow">demo control panel</p>
          <h2>Write the core flow from the browser.</h2>
          <p>
            Use the seed script for the full two follower split. These buttons are the browser path for wallet based writes.
          </p>
        </div>
        <div className="buttonGrid">
          <button onClick={refresh}>{loading ? "refreshing" : "refresh state"}</button>
          <button onClick={depositFiveUSDC}>approve and deposit 5 USDC</button>
          <button onClick={followCatArb}>follow CatArb</button>
          <button onClick={publishOneUSDCIntent}>publish 1 USDC intent</button>
        </div>
        <div className={action.error ? "status error" : "status"}>
          <strong>{action.label}</strong>
          {action.tx && <span>{shortAddress(action.tx)}</span>}
          {action.error && <span>{action.error}</span>}
        </div>
      </section>

      <section className="agents">
        <Header eyebrow="source agents" title="ERC-8004 referenced agent profiles" />
        <div className="agentGrid">
          {state?.sources.map((source) => (
            <article className="card" key={source.address}>
              <p>{source.name}</p>
              <strong>{score(source.reputationScore)}</strong>
              <span>{shortAddress(source.address)}</span>
              <span>{source.followerCount.toString()} followers</span>
              <span>{formatUSDC(source.kickbackUSDC)} USDC kickback accrued</span>
              <span>ERC-8004 {shortAddress(source.erc8004Registry)}</span>
            </article>
          ))}
          {state?.sources.length === 0 && <Empty text="No source agents registered yet." />}
        </div>
      </section>

      <section className="split">
        <ReceiptColumn title="copied receipts" receipts={copiedReceipts} />
        <ReceiptColumn title="blocked receipts" receipts={blockedReceipts} />
      </section>

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

function ReceiptColumn({ title, receipts }: { title: string; receipts: ReceiptLog[] }) {
  return (
    <article className={title.includes("copied") ? "receipt copied" : "receipt blocked"}>
      <p>{title}</p>
      {receipts.length === 0 && <span>No receipts yet.</span>}
      <div className="receiptList">
        {receipts
          .slice()
          .reverse()
          .slice(0, 6)
          .map((receipt) => (
            <div className="receiptRow" key={`${receipt.transactionHash}-${receipt.follower}`}>
              <h3>intent {receipt.intentId.toString()}</h3>
              <span>{shortAddress(receipt.follower)}</span>
              <span>{receipt.status === "copied" ? `${formatUSDC(receipt.usdcAmount)} USDC copied` : receipt.reason}</span>
              {receipt.mirrorFeeUSDC > 0n && <span>{formatUSDC(receipt.mirrorFeeUSDC)} USDC mirror fee</span>}
              {receipt.assetAmountOut > 0n && <span>{formatAsset(receipt.assetAmountOut)} ARCETH out</span>}
              <span>{shortAddress(receipt.transactionHash)}</span>
            </div>
          ))}
      </div>
    </article>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function SpotlightCard({
  verdict,
  kind,
  label,
  follower,
  minBps,
  scaledMin,
  liveQuote,
  receipt,
  detail,
}: {
  verdict: "BLOCKED" | "COPIED";
  kind: "blocked" | "copied";
  label: string;
  follower: Address;
  minBps: number;
  scaledMin: string;
  liveQuote: string;
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
          <dt>minBpsOut</dt>
          <dd>{minBps}</dd>
        </div>
        <div>
          <dt>scaled minimum</dt>
          <dd>{scaledMin} ARCETH</dd>
        </div>
        <div>
          <dt>live quote</dt>
          <dd>{liveQuote} ARCETH</dd>
        </div>
        {receipt.status === "copied" && (
          <div>
            <dt>received</dt>
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
            <dt>reason</dt>
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

function score(value: number): string {
  return `${(value / 100).toFixed(0)}%`;
}

createRoot(document.getElementById("root")!).render(<App />);
