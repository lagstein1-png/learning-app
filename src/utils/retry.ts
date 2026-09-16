import { ProviderHttpError } from "./errors.js";

export interface RetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Decide whether the failure is worth retrying. Defaults to `isTransient`. */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injected for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Network hiccups, timeouts, 408/429/5xx are transient; 4xx logic errors are not. */
export function isTransient(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return error.retryable;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause !== error && isTransient(cause)) return true;
    if (/fetch failed|socket hang up|network/i.test(error.message)) return true;
  }
  return false;
}

/**
 * Full-jitter exponential backoff: delay = random(0, min(max, base * 2^attempt)).
 * Full jitter spreads retries from many mobile clients so a recovering provider
 * is not hit by a synchronised wave.
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number = Math.random): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

/** Run `fn` with exponential backoff. `attempt` passed to `fn` starts at 0. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? ((e: unknown) => isTransient(e));
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.maxRetries || !shouldRetry(error, attempt)) throw error;
      const delay = backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs, random);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** Race a promise against a timeout, aborting the signal so the underlying fetch stops. */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
