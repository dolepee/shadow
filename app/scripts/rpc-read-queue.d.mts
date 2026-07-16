export type RpcReadRetryEvent = {
  label: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
};

export type RpcReadQueueOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  spacingMs?: number;
  sleep?: (delayMs: number) => Promise<unknown>;
  random?: () => number;
  onRetry?: (event: RpcReadRetryEvent) => void;
};

export declare function createRpcReadQueue(
  options?: RpcReadQueueOptions,
): <T>(label: string, operation: () => Promise<T>) => Promise<T>;

export declare function isTransientRpcReadError(error: unknown): boolean;
