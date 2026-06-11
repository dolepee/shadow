export const LIFETIME_SNAPSHOT_FLOOR = {
  snapshotAt: "2026-05-24",
  // Stable May 24 reference proof block already documented in README.
  snapshotBlock: "43176529",
  followerWallets: 30,
  receipts: 2893,
  copied: 463,
  blocked: 2430,
  closedPositions: 173,
  mirroredUsdc: "13.355",
  mirroredUsdcAtomic: "13355000",
  sourceAgents: 3,
} as const;

export type LifetimeTotals = {
  snapshotAt: string;
  snapshotBlock: string;
  followerWallets: number;
  receipts: number;
  copied: number;
  blocked: number;
  closedPositions: number;
  mirroredUsdc: string;
  mirroredUsdcAtomic: string;
  sourceAgents: number;
};

export type RecentWindowTotals = {
  fromBlock: string;
  toBlock: string;
  historyTruncated: boolean;
  followerWallets: number;
  receipts: number;
  copied: number;
  blocked: number;
  closedPositions: number;
  mirroredUsdc: string;
  mirroredUsdcAtomic: string;
  sourceAgents: number;
};
