import { createPublicClient, createWalletClient, encodePacked, http, keccak256, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "USDC",
    symbol: "USDC",
  },
  rpcUrls: {
    default: {
      http: [requiredEnv("ARC_RPC_URL", false) || "http://127.0.0.1:8545"],
    },
  },
});

const routerAbi = parseAbi([
  "function publishIntent((address asset, uint256 amountUSDC, uint256 minAmountOut, uint8 riskLevel, uint256 expiry, bytes32 intentHash) intent) returns (uint256)",
]);

type ShadowIntent = {
  source: "CatArb";
  asset: "ARCETH";
  amountUSDC: string;
  riskLevel: number;
  reason: string;
  intentHash: `0x${string}`;
};

const reason = "CatArb momentum agent requests one controlled AMM copy intent.";
const intentHash = keccak256(encodePacked(["string", "uint256"], [reason, BigInt(Date.now())]));
const intent: ShadowIntent = {
  source: "CatArb",
  asset: "ARCETH",
  amountUSDC: "1.00",
  riskLevel: 2,
  reason,
  intentHash,
};

if (process.argv.includes("--publish")) {
  await publishIntent(intent);
} else {
  console.log(JSON.stringify(intent, null, 2));
  console.log("Run npm run agent:intent -- --publish after setting ARC_RPC_URL, SHADOW_ROUTER, SHADOW_ARCETH, and CAT_AGENT_PRIVATE_KEY.");
}

async function publishIntent(shadowIntent: ShadowIntent) {
  const rpcUrl = requiredEnv("ARC_RPC_URL", true);
  const router = requiredEnv("SHADOW_ROUTER", true) as `0x${string}`;
  const arceth = requiredEnv("SHADOW_ARCETH", true) as `0x${string}`;
  const privateKey = normalizePrivateKey(requiredEnv("CAT_AGENT_PRIVATE_KEY", true));
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport,
  });

  const tx = await walletClient.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "publishIntent",
    args: [
      {
        asset: arceth,
        amountUSDC: parseUnits(shadowIntent.amountUSDC, 6),
        minAmountOut: 1n,
        riskLevel: shadowIntent.riskLevel,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        intentHash: shadowIntent.intentHash,
      },
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

  console.log(
    JSON.stringify(
      {
        ...shadowIntent,
        sourceAddress: account.address,
        tx,
        blockNumber: receipt.blockNumber.toString(),
      },
      null,
      2,
    ),
  );
}

function requiredEnv(name: string, required: boolean): string {
  const value = process.env[name];
  if (!value && required) {
    throw new Error(`Missing ${name}`);
  }
  return value || "";
}

function normalizePrivateKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}
