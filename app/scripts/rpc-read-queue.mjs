const transientRpcPattern =
  /request limit reached|rate limit|too many requests|\b429\b|-32011|timed? out|timeout|fetch failed|econnreset|etimedout|socket hang up|temporarily unavailable|\b502\b|\b503\b|\b504\b/i;

export function createRpcReadQueue({
  maxAttempts = 6,
  baseDelayMs = 750,
  maxDelayMs = 8_000,
  spacingMs = 350,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random = Math.random,
  onRetry = () => {},
} = {}) {
  validatePositiveInteger(maxAttempts, "maxAttempts");
  validateNonNegativeInteger(baseDelayMs, "baseDelayMs");
  validateNonNegativeInteger(maxDelayMs, "maxDelayMs");
  validateNonNegativeInteger(spacingMs, "spacingMs");

  let tail = Promise.resolve();
  let nextReadAt = 0;

  return function queueRpcRead(label, operation) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("RPC read operation must be a function"));
    }

    const task = tail.then(async () => {
      const spacingDelay = Math.max(0, nextReadAt - Date.now());
      if (spacingDelay > 0) await sleep(spacingDelay);

      try {
        return await retryRpcRead({
          label,
          operation,
          maxAttempts,
          baseDelayMs,
          maxDelayMs,
          sleep,
          random,
          onRetry,
        });
      } finally {
        nextReadAt = Date.now() + spacingMs;
      }
    });

    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

export function isTransientRpcReadError(error) {
  return transientRpcPattern.test(flattenError(error));
}

async function retryRpcRead({
  label,
  operation,
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
  sleep,
  random,
  onRetry,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !isTransientRpcReadError(error)) throw error;

      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(exponentialDelay * 0.2 * random());
      const delayMs = exponentialDelay + jitter;
      onRetry({ label, attempt, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error(`RPC read retry loop exhausted for ${label}`);
}

function flattenError(error) {
  const parts = [];
  const seen = new Set();
  let current = error;

  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;

    for (const key of ["name", "message", "shortMessage", "details", "code", "status"]) {
      const value = current[key];
      if (value !== undefined && value !== null) parts.push(String(value));
    }
    current = current.cause;
  }

  return parts.join(" ");
}

function validatePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function validateNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}
