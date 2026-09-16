/**
 * Token bucket + concurrency gate for outbound provider calls.
 *
 * The bucket refills continuously at `rpm / 60` tokens per second. A caller
 * that finds the bucket empty waits for the next token instead of failing, so
 * bursts from many devices are smoothed rather than rejected. The concurrency
 * gate caps in-flight requests, which is what actually protects provider
 * connection limits.
 */
export interface RateLimiterOptions {
  readonly requestsPerMinute: number;
  readonly maxConcurrency: number;
  /** Longest a caller will wait for a token before giving up. */
  readonly maxWaitMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RateLimiterOptions) {
    this.capacity = Math.max(1, options.requestsPerMinute);
    this.refillPerMs = options.requestsPerMinute / 60000;
    this.tokens = this.capacity;
    this.now = options.now ?? Date.now;
    this.lastRefill = this.now();
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = t;
    }
  }

  /** Current snapshot for health endpoints and tests. */
  snapshot(): { tokens: number; inFlight: number; queued: number } {
    this.refill();
    return { tokens: Math.floor(this.tokens), inFlight: this.inFlight, queued: this.waiters.length };
  }

  private async acquireToken(): Promise<void> {
    const deadline = this.now() + this.options.maxWaitMs;
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      if (this.now() + waitMs > deadline) {
        throw new RateLimitExceededError(`rate limit: next token in ${waitMs}ms exceeds max wait ${this.options.maxWaitMs}ms`);
      }
      await this.sleep(waitMs);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.options.maxConcurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Run `fn` once a token and a concurrency slot are available. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireToken();
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }
}
