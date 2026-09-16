import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "../src/utils/errors.js";
import { RateLimiter, RateLimitExceededError } from "../src/utils/rateLimiter.js";
import { backoffDelay, isTransient, TimeoutError, withRetry, withTimeout } from "../src/utils/retry.js";
import { MemoryAudioCache, type CachedAudio } from "../src/services/audioCache.js";
import { instantSleep } from "./helpers/mocks.js";

describe("retry with exponential backoff", () => {
  it("caps the delay and applies full jitter", () => {
    expect(backoffDelay(0, 100, 10_000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 10_000, () => 1)).toBe(800);
    expect(backoffDelay(10, 100, 5_000, () => 1)).toBe(5_000);
    expect(backoffDelay(3, 100, 10_000, () => 0.5)).toBe(400);
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(0);
  });

  it("retries transient failures up to maxRetries and then rethrows", async () => {
    const { sleep, delays } = instantSleep();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new ProviderHttpError("x", 503, "down"));
        },
        { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000, sleep, random: () => 1 },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it("does not retry logic errors", async () => {
    const { sleep, delays } = instantSleep();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new ProviderHttpError("x", 400, "bad request"));
        },
        { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000, sleep },
      ),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("classifies transient errors", () => {
    expect(isTransient(new ProviderHttpError("x", 429, ""))).toBe(true);
    expect(isTransient(new ProviderHttpError("x", 500, ""))).toBe(true);
    expect(isTransient(new ProviderHttpError("x", 404, ""))).toBe(false);
    expect(isTransient(new TimeoutError("t"))).toBe(true);
    expect(isTransient(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new Error("validation failed"))).toBe(false);
    expect(isTransient("string")).toBe(false);
  });

  it("aborts a call that exceeds its timeout", async () => {
    await expect(
      withTimeout(
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            });
          }),
        20,
        "slow call",
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(() => Promise.resolve("fast"), 1000, "fast")).resolves.toBe("fast");
  });
});

describe("RateLimiter", () => {
  it("caps concurrency and queues the rest", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 600, maxConcurrency: 2, maxWaitMs: 1000 });
    let inFlight = 0;
    let peak = 0;
    const job = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };
    await Promise.all([limiter.run(job), limiter.run(job), limiter.run(job), limiter.run(job), limiter.run(job)]);
    expect(peak).toBe(2);
    expect(limiter.snapshot().inFlight).toBe(0);
  });

  it("waits for the token bucket to refill and rejects when the wait exceeds the limit", async () => {
    let now = 0;
    const { sleep, delays } = instantSleep();
    const limiter = new RateLimiter({
      requestsPerMinute: 60,
      maxConcurrency: 4,
      maxWaitMs: 2000,
      now: () => now,
      sleep: async (ms) => {
        await sleep(ms);
        now += ms;
      },
    });
    const bucket = limiter.snapshot();
    expect(bucket.tokens).toBe(60);
    for (let i = 0; i < 60; i += 1) await limiter.run(() => Promise.resolve());
    await limiter.run(() => Promise.resolve());
    expect(delays).toEqual([1000]);

    const strict = new RateLimiter({ requestsPerMinute: 1, maxConcurrency: 1, maxWaitMs: 100, now: () => now, sleep });
    await strict.run(() => Promise.resolve());
    await expect(strict.run(() => Promise.resolve())).rejects.toBeInstanceOf(RateLimitExceededError);
  });
});

describe("MemoryAudioCache", () => {
  const entry = (tag: string): CachedAudio => ({ audio: Buffer.from(tag), provider: "azure", voiceId: "v", format: "mp3", language: "he" });

  it("evicts least-recently-used entries beyond the cap", async () => {
    const cache = new MemoryAudioCache(2, 0);
    await cache.put("a", entry("a"));
    await cache.put("b", entry("b"));
    expect(await cache.get("a")).not.toBeNull();
    await cache.put("c", entry("c"));
    expect(cache.size).toBe(2);
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  it("expires entries after the ttl", async () => {
    let now = 0;
    const cache = new MemoryAudioCache(10, 1000, () => now);
    await cache.put("k", entry("k"));
    now = 999;
    expect(await cache.get("k")).not.toBeNull();
    now = 1000;
    expect(await cache.get("k")).toBeNull();
  });

  it("stores nothing when the cap is zero", async () => {
    const cache = new MemoryAudioCache(0, 0);
    await cache.put("k", entry("k"));
    expect(await cache.get("k")).toBeNull();
  });
});
