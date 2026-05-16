import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

loadEnvFile();

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: [requiredEnv("ARC_RPC_URL")] } },
});

const registryAbi = parseAbi([
  "function registerSource(address agent, string name, string metadataURI, uint16 reputationScore, address erc8004Registry, uint256 erc8004TokenId)",
  "function sources(address) view returns (address agent, string name, string metadataURI, uint16 reputationScore, address erc8004Registry, uint256 erc8004TokenId, bool registered)",
]);

const routerAbi = parseAbi([
  "function followSource(address sourceAgent, uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
]);

const ERC8004_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  const deployer = privateKeyToAccount(normalizeKey(requiredEnv("PRIVATE_KEY")));
  const otter = privateKeyToAccount(normalizeKey(requiredEnv("OTTER_AGENT_PRIVATE_KEY")));
  const followerAKey = normalizeKey(requiredEnv("FOLLOWER_A_PRIVATE_KEY"));
  const followerBKey = normalizeKey(requiredEnv("FOLLOWER_B_PRIVATE_KEY"));
  const registry = requiredEnv("SHADOW_REGISTRY") as Address;
  const router = requiredEnv("SHADOW_ROUTER") as Address;
  const arceth = requiredEnv("SHADOW_ARCETH") as Address;

  console.log(`deployer=${deployer.address}`);
  console.log(`momentumOtter=${otter.address}`);

  const existing = await publicClient.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "sources",
    args: [otter.address],
  });
  const isRegistered = existing[6] as boolean;

  if (isRegistered) {
    console.log("MomentumOtter already registered, skipping registerSource");
  } else {
    const deployerWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport });
    console.log("registering MomentumOtter source agent...");
    const registerTx = await deployerWallet.writeContract({
      address: registry,
      abi: registryAbi,
      functionName: "registerSource",
      args: [
        otter.address,
        "MomentumOtter",
        "ipfs://shadow/momentum-otter",
        5_400,
        ERC8004_REGISTRY,
        3n,
      ],
    });
    console.log(`registerSource tx=${registerTx}`);
    const registerReceipt = await publicClient.waitForTransactionReceipt({ hash: registerTx });
    console.log(`registerSource confirmed block=${registerReceipt.blockNumber.toString()}`);
  }

  const otterBalance = await publicClient.getBalance({ address: otter.address });
  console.log(`momentumOtter native balance=${otterBalance.toString()} wei`);
  const gasStipend = parseUnits("0.05", 18);
  if (otterBalance < gasStipend) {
    const deployerWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport });
    console.log(`funding MomentumOtter with ${gasStipend.toString()} wei native gas...`);
    const fundTx = await deployerWallet.sendTransaction({
      to: otter.address,
      value: gasStipend,
    });
    console.log(`fund tx=${fundTx}`);
    await publicClient.waitForTransactionReceipt({ hash: fundTx });
  } else {
    console.log("MomentumOtter already funded, skipping native transfer");
  }

  await ensureFollow(publicClient, transport, router, arceth, followerAKey, otter.address, 10000, "Follower A → MomentumOtter (strict)");
  await ensureFollow(publicClient, transport, router, arceth, followerBKey, otter.address, 9000, "Follower B → MomentumOtter (lenient)");

  console.log("\nDone. Add OTTER_AGENT_PRIVATE_KEY to GitHub Secrets and append a publish step to .github/workflows/publish-intents.yml.");
}

async function ensureFollow(
  publicClient: ReturnType<typeof createPublicClient>,
  transport: ReturnType<typeof http>,
  router: Address,
  arceth: Address,
  followerKey: `0x${string}`,
  source: Address,
  minBpsOut: number,
  label: string,
) {
  const account = privateKeyToAccount(followerKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });
  console.log(`\n[${label}] follower=${account.address}`);
  const tx = await wallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "followSource",
    args: [
      source,
      parseUnits("2", 6),
      parseUnits("20", 6),
      arceth,
      3,
      minBpsOut,
    ],
  });
  console.log(`[${label}] tx=${tx}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`[${label}] confirmed block=${receipt.blockNumber.toString()}`);
}

function normalizeKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`error: missing env ${name}`);
    process.exit(2);
  }
  return value;
}

function loadEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../.env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional if env is already exported
  }
}
