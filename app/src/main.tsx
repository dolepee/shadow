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
  registryAbi,
  routerAbi,
  shortAddress,
  type ReceiptLog,
  type ShadowState,
} from "./chain";
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

  async function connectWallet() {
    if (!window.ethereum) {
      setAction({ label: "wallet missing", error: "Install a browser wallet to write transactions." });
      return;
    }
    const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
    setAccount(accounts[0]);
    setAction({ label: "wallet connected" });
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
        args: [catAgent.address, parseUnits("2", 6), parseUnits("5", 6), addresses.arceth!, 3],
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

  async function registerConnectedSource() {
    await writeTx("register source", (wallet, user) =>
      wallet.writeContract({
        account: user,
        address: addresses.registry!,
        abi: registryAbi,
        functionName: "registerSource",
        args: [user, "GuestAgent", "ipfs://shadow/guest-agent", 5_800, "0x8004A818BFB912233c491871b3d84c89A494BD9e", 99n],
        chain: arcTestnet,
      }),
    );
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
          <button onClick={registerConnectedSource}>register connected source</button>
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
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x4cef52" }],
    });
  } catch {
    // Some wallets on fresh Arc testnet setups require manual network addition.
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
