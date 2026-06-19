import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toBytes,
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

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const registryAbi = parseAbi([
  "function nextMandateId() view returns (uint256)",
  "function createMandate(address circleAccount,address requiredSettlementAsset,address allowedTarget,uint8 actionType,uint256 maxAmountPerIntent,uint256 dailyCap,uint8 maxRiskLevel,uint16 minBpsOut,bytes32 labelHash) returns (uint256)",
]);

const attestorAbi = parseAbi([
  "function receiptCount() view returns (uint256)",
]);

const adapterAbi = parseAbi([
  "function adapterBondUSDC() view returns (uint256)",
  "function executedUSDC() view returns (uint256)",
  "function blockedUSDC() view returns (uint256)",
  "function beforeSwapStyleAction((uint256 mandateId,address actor,address circleAccount,address settlementAsset,address target,uint8 actionType,uint256 amountUSDC,uint8 riskLevel,uint16 minBpsOut,uint256 expiry,bytes32 intentHash,bytes32 executionRef) action) returns (bytes32 receiptHash,bool allowed,uint8 reason)",
  "function postBond(uint256 amountUSDC)",
]);

const vaultAbi = parseAbi([
  "function totalDepositedUSDC() view returns (uint256)",
]);

const MAX_UINT256 = (1n << 256n) - 1n;
const SWAP = 1;

await main();

async function main() {
  const rpcUrl = requiredEnv("ARC_RPC_URL");
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });

  const account = privateKeyToAccount(normalizeKey(requiredEnv("PRIVATE_KEY")));
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });

  const usdc = requiredEnv("ARC_USDC") as Address;
  const registry = requiredEnv("LEPTON_REGISTRY") as Address;
  const attestor = requiredEnv("LEPTON_ATTESTOR") as Address;
  const adapter = requiredEnv("LEPTON_ADAPTER") as Address;
  const vault = optionalEnv("LEPTON_VAULT_SINK") as Address | undefined;
  const minBond = BigInt(requiredEnv("LEPTON_MIN_BOND_USDC"));
  const allowAmount = BigInt(requiredEnv("LEPTON_SMOKE_ALLOW_USDC"));
  const dailyCap = BigInt(requiredEnv("LEPTON_SMOKE_DAILY_CAP_USDC"));
  const blockAmount = BigInt(requiredEnv("LEPTON_SMOKE_BLOCK_USDC"));

  const [balance, nativeBalance, receiptCountBefore, bondBefore, executedBefore, blockedBefore] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: attestor, abi: attestorAbi, functionName: "receiptCount" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "adapterBondUSDC" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "executedUSDC" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "blockedUSDC" }),
  ]);
  const vaultBefore = vault
    ? await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalDepositedUSDC" })
    : undefined;

  console.log(`deployer=${account.address}`);
  console.log(`balances USDC=${formatUnits(balance, 6)} native=${formatUnits(nativeBalance, 18)}`);
  console.log(
    `before receipts=${receiptCountBefore} bond=${formatUnits(bondBefore, 6)} executed=${formatUnits(executedBefore, 6)} blocked=${formatUnits(blockedBefore, 6)}`,
  );
  if (vaultBefore !== undefined) console.log(`before vaultDeposited=${formatUnits(vaultBefore, 6)}`);

  const neededForTransfers = (bondBefore < minBond ? minBond - bondBefore : 0n) + allowAmount;
  if (balance < neededForTransfers) {
    throw new Error(`deployer USDC ${formatUnits(balance, 6)} < required ${formatUnits(neededForTransfers, 6)}`);
  }

  console.log("approving adapter for USDC pulls...");
  await sendAndConfirm(
    publicClient,
    await wallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [adapter, MAX_UINT256],
      gas: 200_000n,
    }),
    "approve",
  );

  if (bondBefore < minBond) {
    console.log(`posting adapter bond delta=${formatUnits(minBond - bondBefore, 6)} USDC...`);
    await sendAndConfirm(
      publicClient,
      await wallet.writeContract({
        address: adapter,
        abi: adapterAbi,
        functionName: "postBond",
        args: [minBond - bondBefore],
        gas: 900_000n,
      }),
      "postBond",
    );
  }

  const nextMandateId = await publicClient.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "nextMandateId",
  });
  console.log(`creating smoke mandate id=${nextMandateId}...`);
  await sendAndConfirm(
    publicClient,
    await wallet.writeContract({
      address: registry,
      abi: registryAbi,
      functionName: "createMandate",
      args: [
        account.address,
        usdc,
        adapter,
        SWAP,
        allowAmount,
        dailyCap,
        3,
        9_900,
        labelHash(`shadow-lepton-smoke-${Date.now()}`),
      ],
      gas: 500_000n,
    }),
    "createMandate",
  );

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400);

  console.log("executing allowed action...");
  await sendAndConfirm(
    publicClient,
    await wallet.writeContract({
      address: adapter,
      abi: adapterAbi,
      functionName: "beforeSwapStyleAction",
      args: [
        {
          mandateId: nextMandateId,
          actor: account.address,
          circleAccount: account.address,
          settlementAsset: usdc,
          target: adapter,
          actionType: SWAP,
          amountUSDC: allowAmount,
          riskLevel: 2,
          minBpsOut: 9_950,
          expiry,
          intentHash: labelHash("shadow-lepton-allow"),
          executionRef: labelHash("smoke-allow"),
        },
      ],
      gas: 1_100_000n,
    }),
    "allowAction",
  );

  console.log("executing blocked action...");
  await sendAndConfirm(
    publicClient,
    await wallet.writeContract({
      address: adapter,
      abi: adapterAbi,
      functionName: "beforeSwapStyleAction",
      args: [
        {
          mandateId: nextMandateId,
          actor: account.address,
          circleAccount: account.address,
          settlementAsset: usdc,
          target: adapter,
          actionType: SWAP,
          amountUSDC: blockAmount,
          riskLevel: 2,
          minBpsOut: 9_950,
          expiry,
          intentHash: labelHash("shadow-lepton-block"),
          executionRef: labelHash("smoke-block"),
        },
      ],
      gas: 1_100_000n,
    }),
    "blockAction",
  );

  const [receiptCountAfter, bondAfter, executedAfter, blockedAfter, finalBalance] = await Promise.all([
    publicClient.readContract({ address: attestor, abi: attestorAbi, functionName: "receiptCount" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "adapterBondUSDC" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "executedUSDC" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "blockedUSDC" }),
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  ]);
  const vaultAfter = vault
    ? await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalDepositedUSDC" })
    : undefined;

  console.log(
    `after receipts=${receiptCountAfter} bond=${formatUnits(bondAfter, 6)} executed=${formatUnits(executedAfter, 6)} blocked=${formatUnits(blockedAfter, 6)}`,
  );
  if (vaultAfter !== undefined) console.log(`after vaultDeposited=${formatUnits(vaultAfter, 6)}`);
  console.log(`final deployer USDC=${formatUnits(finalBalance, 6)}`);

  if (receiptCountAfter < receiptCountBefore + 2n) throw new Error("expected at least two new receipts");
  if (executedAfter < executedBefore + allowAmount) throw new Error("allowed action did not update executedUSDC");
  if (blockedAfter < blockedBefore + blockAmount) throw new Error("blocked action did not update blockedUSDC");
  if (vaultBefore !== undefined && vaultAfter !== undefined && vaultAfter < vaultBefore + allowAmount) {
    throw new Error("vault did not record allowed deposit");
  }
}

async function sendAndConfirm(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: `0x${string}`,
  label: string,
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${label} tx=${hash} block=${receipt.blockNumber} status=${receipt.status}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
}

function labelHash(value: string): `0x${string}` {
  return keccak256(toBytes(value));
}

function normalizeKey(value: string): `0x${string}` {
  const cleaned = sanitizeEnv(value);
  return cleaned.startsWith("0x") ? (cleaned as `0x${string}`) : (`0x${cleaned}` as `0x${string}`);
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    console.error(`error: missing env ${name}`);
    process.exit(2);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? sanitizeEnv(value) : undefined;
}

function sanitizeEnv(value: string): string {
  return value.replace(/\\n/g, "").trim();
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
    // .env is optional if env is already exported.
  }
}
