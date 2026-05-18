import { encodeFunctionData, isAddress, getAddress, parseUnits, parseAbi, type Address } from "viem";

export const config = { maxDuration: 10 };

type Preset = "conservative" | "balanced" | "aggressive";

type Body = {
  sourceAgent?: string;
  follower?: string;
  preset?: Preset;
};

type VercelLikeResponse = {
  setHeader: (k: string, v: string) => void;
  status: (s: number) => { json: (b: unknown) => void };
};

type VercelLikeRequest = {
  method?: string;
  body?: unknown;
};

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const routerAbi = parseAbi([
  "function depositUSDC(uint256 amountUSDC)",
  "function followSource(address sourceAgent, uint256 maxAmountPerIntent, uint256 dailyCap, address allowedAsset, uint8 maxRiskLevel, uint16 minBpsOut)",
]);

const PRESETS: Record<
  Preset,
  {
    maxAmountPerIntent: string;
    dailyCap: string;
    depositUSDC: string;
    maxRiskLevel: number;
    minBpsOut: number;
    policySummary: string;
    expectedReceipt: string;
  }
> = {
  conservative: {
    maxAmountPerIntent: "0.2",
    dailyCap: "1",
    depositUSDC: "1",
    maxRiskLevel: 1,
    minBpsOut: 10000,
    policySummary:
      "0.2 USDC per intent, 1 USDC daily cap, risk level 1 only, slippage tolerance 0 bps (asset out must equal intent.minAmountOut or better).",
    expectedReceipt:
      "Most source intents will emit MirrorReceipt(BLOCKED, SLIPPAGE_TOO_TIGHT) because the strict 10000 bps bound rejects any quote slippage. Copies only land when AMM depth matches the source minAmountOut exactly.",
  },
  balanced: {
    maxAmountPerIntent: "0.5",
    dailyCap: "3",
    depositUSDC: "1",
    maxRiskLevel: 2,
    minBpsOut: 9500,
    policySummary:
      "0.5 USDC per intent, 3 USDC daily cap, up to risk level 2, slippage tolerance 500 bps (5%).",
    expectedReceipt:
      "Routine source intents emit MirrorReceipt(COPIED) with realized asset out within 5% of source minAmountOut. Thin AMM events that drift past 5% emit MirrorReceipt(BLOCKED, SLIPPAGE_TOO_TIGHT) with the router untouched.",
  },
  aggressive: {
    maxAmountPerIntent: "1",
    dailyCap: "5",
    depositUSDC: "2",
    maxRiskLevel: 3,
    minBpsOut: 9000,
    policySummary:
      "1 USDC per intent, 5 USDC daily cap, up to risk level 3, slippage tolerance 1000 bps (10%).",
    expectedReceipt:
      "Most source intents emit MirrorReceipt(COPIED). Only intents whose live quote drifts more than 10% below source minAmountOut emit MirrorReceipt(BLOCKED, SLIPPAGE_TOO_TIGHT).",
  },
};

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method not allowed, use POST" });
    return;
  }

  const body = parseBody(req.body);
  const presetKey = (body.preset || "balanced") as Preset;
  if (!PRESETS[presetKey]) {
    res.status(400).json({ error: "preset must be conservative | balanced | aggressive" });
    return;
  }
  if (!body.sourceAgent || !isAddress(body.sourceAgent)) {
    res.status(400).json({ error: "sourceAgent required (EVM hex)" });
    return;
  }
  if (!body.follower || !isAddress(body.follower)) {
    res.status(400).json({ error: "follower required (EVM hex)" });
    return;
  }

  const router = (process.env.SHADOW_ROUTER || process.env.VITE_SHADOW_ROUTER || "").trim() as Address | "";
  const usdc = (
    process.env.ARC_USDC ||
    process.env.VITE_ARC_USDC ||
    "0x3600000000000000000000000000000000000000"
  ).trim() as Address;
  const allowedAsset = (process.env.SHADOW_ARCETH || process.env.VITE_SHADOW_ARCETH || "").trim() as Address | "";

  if (!router || !isAddress(router)) {
    res.status(500).json({ error: "SHADOW_ROUTER env not configured" });
    return;
  }
  if (!allowedAsset || !isAddress(allowedAsset)) {
    res.status(500).json({ error: "SHADOW_ARCETH env not configured" });
    return;
  }

  const sourceAgent = getAddress(body.sourceAgent) as Address;
  const follower = getAddress(body.follower) as Address;
  const preset = PRESETS[presetKey];

  const depositAmount = parseUnits(preset.depositUSDC, 6);
  const maxAmountPerIntent = parseUnits(preset.maxAmountPerIntent, 6);
  const dailyCap = parseUnits(preset.dailyCap, 6);

  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [router, depositAmount],
  });
  const depositCalldata = encodeFunctionData({
    abi: routerAbi,
    functionName: "depositUSDC",
    args: [depositAmount],
  });
  const followCalldata = encodeFunctionData({
    abi: routerAbi,
    functionName: "followSource",
    args: [sourceAgent, maxAmountPerIntent, dailyCap, allowedAsset, preset.maxRiskLevel, preset.minBpsOut],
  });

  res.status(200).json({
    chainId: 5_042_002,
    follower,
    sourceAgent,
    preset: presetKey,
    policy: {
      maxAmountPerIntentUSDC: preset.maxAmountPerIntent,
      dailyCapUSDC: preset.dailyCap,
      depositUSDC: preset.depositUSDC,
      allowedAsset,
      maxRiskLevel: preset.maxRiskLevel,
      minBpsOut: preset.minBpsOut,
      summary: preset.policySummary,
    },
    expectedReceipt: preset.expectedReceipt,
    transactions: [
      {
        step: 1,
        label: "approve USDC to router",
        to: usdc,
        data: approveCalldata,
        value: "0x0",
      },
      {
        step: 2,
        label: "depositUSDC into router",
        to: router,
        data: depositCalldata,
        value: "0x0",
      },
      {
        step: 3,
        label: "followSource with policy",
        to: router,
        data: followCalldata,
        value: "0x0",
      },
    ],
  });
}

function parseBody(raw: unknown): Body {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Body;
    } catch {
      return {};
    }
  }
  return raw as Body;
}
