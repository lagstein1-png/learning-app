/**
 * Audio engine: the integration layer to the neural voice providers.
 *
 * For every chunk it builds provider-specific SSML, checks the cache, then
 * walks the voice fallback chain: each provider call is rate-limited (token
 * bucket + concurrency gate), retried with full-jitter exponential backoff
 * on transient failures, and guarded by a per-provider circuit breaker so a
 * provider that is down is skipped instead of paid for in timeouts. When no
 * provider can produce audio the engine returns a device-fallback directive
 * rather than an error, so the learner still hears the text.
 */
import { performance } from "node:perf_hooks";
import { PROVIDER_ENDPOINTS } from "../config/constants.js";
import type { DeviceFallbackDirective, EmphasisMarker, LanguageCode, SpeechChunk, SynthesisResult, VoiceProfile, VoiceSelection } from "../types/index.js";
import { ProviderHttpError } from "../utils/errors.js";
import { RateLimiter, RateLimitExceededError } from "../utils/rateLimiter.js";
import { isTransient, withRetry, withTimeout } from "../utils/retry.js";
import { buildSsml } from "../utils/ssml.js";
import type { AudioCacheStore } from "./audioCache.js";
import type { Observability } from "./observability.js";
import type { CloudProvider, VoiceSelector } from "./voiceSelector.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SynthesisProvider {
  readonly id: CloudProvider;
  synthesize(ssml: string, voice: VoiceProfile, signal: AbortSignal): Promise<Buffer>;
}

export class AzureSpeechProvider implements SynthesisProvider {
  readonly id = "azure" as const;

  constructor(
    private readonly key: string,
    private readonly region: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}

  async synthesize(ssml: string, _voice: VoiceProfile, signal: AbortSignal): Promise<Buffer> {
    const response = await this.fetchFn(PROVIDER_ENDPOINTS.azure.tts(this.region), {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": PROVIDER_ENDPOINTS.azure.outputFormat,
        "User-Agent": "learning-app-tts/1.0.0",
      },
      body: ssml,
      signal,
    });
    if (!response.ok) throw new ProviderHttpError("azure", response.status, await response.text());
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new ProviderHttpError("azure", 502, "empty audio body");
    return bytes;
  }
}

export class GoogleTtsProvider implements SynthesisProvider {
  readonly id = "google" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}

  async synthesize(ssml: string, voice: VoiceProfile, signal: AbortSignal): Promise<Buffer> {
    const response = await this.fetchFn(PROVIDER_ENDPOINTS.google.tts, {
      method: "POST",
      headers: {
        "X-Goog-Api-Key": this.apiKey,
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "learning-app-tts/1.0.0",
      },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode: voice.locale, name: voice.id },
        audioConfig: { audioEncoding: PROVIDER_ENDPOINTS.google.audioEncoding, sampleRateHertz: 24000 },
      }),
      signal,
    });
    if (!response.ok) throw new ProviderHttpError("google", response.status, await response.text());
    const body = (await response.json()) as { audioContent?: unknown };
    if (typeof body.audioContent !== "string" || body.audioContent.length === 0) {
      throw new ProviderHttpError("google", 502, "response carried no audioContent");
    }
    return Buffer.from(body.audioContent, "base64");
  }
}

export interface AudioEngineConfig {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly rateLimitRpm: number;
  readonly maxConcurrency: number;
  /** Consecutive failures before a provider's breaker opens. */
  readonly breakerThreshold: number;
  /** How long an open breaker skips the provider. */
  readonly breakerCooldownMs: number;
  /** Injected for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface ChunkSynthesisInput {
  readonly chunk: SpeechChunk;
  readonly language: LanguageCode;
  readonly selection: VoiceSelection;
  /** Emphasis markers with offsets relative to the whole text; sliced per chunk here. */
  readonly emphasis: readonly EmphasisMarker[];
  readonly ipa: ReadonlyMap<string, string>;
}

export type ChunkOutcome = { readonly kind: "audio"; readonly result: SynthesisResult } | { readonly kind: "device"; readonly directive: DeviceFallbackDirective; readonly chunkIndex: number };

interface BreakerState {
  failures: number;
  openUntil: number;
}

/** Slice whole-text emphasis markers down to one chunk, re-based to the chunk's own offsets. */
export function emphasisForChunk(chunk: SpeechChunk, markers: readonly EmphasisMarker[]): EmphasisMarker[] {
  return markers
    .filter((m) => m.start >= chunk.start && m.end <= chunk.end)
    .map((m) => ({ ...m, start: m.start - chunk.start, end: m.end - chunk.start }));
}

export class AudioEngine {
  private readonly limiters = new Map<CloudProvider, RateLimiter>();
  private readonly breakers = new Map<CloudProvider, BreakerState>();
  private readonly now: () => number;

  constructor(
    private readonly providers: ReadonlyMap<CloudProvider, SynthesisProvider>,
    private readonly selector: VoiceSelector,
    private readonly cache: AudioCacheStore,
    private readonly config: AudioEngineConfig,
    private readonly obs: Observability,
  ) {
    this.now = config.now ?? Date.now;
    for (const id of providers.keys()) {
      this.limiters.set(id, new RateLimiter({ requestsPerMinute: config.rateLimitRpm, maxConcurrency: config.maxConcurrency, maxWaitMs: config.timeoutMs, ...(config.sleep ? { sleep: config.sleep } : {}), now: this.now }));
      this.breakers.set(id, { failures: 0, openUntil: 0 });
    }
  }

  /** Which providers are configured and whose breaker is currently closed. */
  providerHealth(): Record<CloudProvider, boolean> {
    const state = (id: CloudProvider): boolean => {
      const b = this.breakers.get(id);
      return b !== undefined && b.openUntil <= this.now();
    };
    return { azure: state("azure"), google: state("google") };
  }

  private breakerOpen(id: CloudProvider): boolean {
    const b = this.breakers.get(id);
    return b !== undefined && b.openUntil > this.now();
  }

  private recordFailure(id: CloudProvider): void {
    const b = this.breakers.get(id);
    if (!b) return;
    b.failures += 1;
    if (b.failures >= this.config.breakerThreshold) {
      b.openUntil = this.now() + this.config.breakerCooldownMs;
      b.failures = 0;
      this.obs.warn("provider breaker opened", { provider: id, cooldown_ms: this.config.breakerCooldownMs });
      this.obs.increment(`tts.breaker.open.${id}`);
    }
  }

  private recordSuccess(id: CloudProvider): void {
    const b = this.breakers.get(id);
    if (b) b.failures = 0;
  }

  /** Build the SSML this chunk would be synthesised with, for a given dialect. */
  ssmlFor(input: ChunkSynthesisInput, voice: VoiceProfile, dialect: CloudProvider | "device"): string {
    return buildSsml(
      { text: input.chunk.text, emphasis: emphasisForChunk(input.chunk, input.emphasis), ipa: input.ipa, boundary: input.chunk.boundary },
      voice,
      input.selection.prosody,
      dialect,
    );
  }

  private async callProvider(provider: SynthesisProvider, ssml: string, voice: VoiceProfile): Promise<Buffer> {
    const limiter = this.limiters.get(provider.id);
    if (!limiter) throw new Error(`no rate limiter for provider ${provider.id}`);
    return withRetry(
      (attempt) =>
        limiter.run(() =>
          this.obs.span("tts.provider.call", { provider: provider.id, voice: voice.id, attempt, chars: ssml.length }, (setAttr) =>
            withTimeout(
              async (signal) => {
                const audio = await provider.synthesize(ssml, voice, signal);
                setAttr("bytes", audio.byteLength);
                return audio;
              },
              this.config.timeoutMs,
              `${provider.id} synthesis`,
            ),
          ),
        ),
      {
        maxRetries: this.config.maxRetries,
        baseDelayMs: 300,
        maxDelayMs: 5000,
        ...(this.config.sleep ? { sleep: this.config.sleep } : {}),
        onRetry: (error, attempt, delayMs) => {
          this.recordFailure(provider.id);
          this.obs.warn("provider retry", { provider: provider.id, attempt, delay_ms: delayMs, reason: error instanceof Error ? error.message : String(error) });
          this.obs.increment(`tts.retry.${provider.id}`);
        },
      },
    );
  }

  /** Synthesise one chunk, walking cache → providers in order → device fallback. */
  async synthesizeChunk(input: ChunkSynthesisInput): Promise<ChunkOutcome> {
    const t0 = performance.now();
    const { chunk } = input;
    const cached = await this.cache.get(chunk.cacheKey);
    if (cached) {
      return {
        kind: "audio",
        result: { chunkIndex: chunk.index, provider: cached.provider, voiceId: cached.voiceId, format: cached.format, audio: cached.audio, cached: true, latencyMs: Math.round(performance.now() - t0) },
      };
    }

    const reasons: string[] = [];
    /** Providers that failed with an outage-shaped error during this chunk; their other voices are skipped. */
    const downForThisChunk = new Set<CloudProvider>();
    for (const voice of this.selector.usable(input.selection)) {
      const provider = this.providers.get(voice.provider);
      if (!provider) continue;
      if (downForThisChunk.has(voice.provider)) continue;
      if (this.breakerOpen(voice.provider)) {
        if (!reasons.some((r) => r.startsWith(`${voice.provider}: breaker open`))) reasons.push(`${voice.provider}: breaker open`);
        continue;
      }
      const ssml = this.ssmlFor(input, voice, voice.provider);
      try {
        const audio = await this.callProvider(provider, ssml, voice);
        this.recordSuccess(voice.provider);
        this.obs.increment(`tts.success.${voice.provider}`);
        await this.cache.put(chunk.cacheKey, { audio, provider: voice.provider, voiceId: voice.id, format: "mp3", language: input.language });
        return {
          kind: "audio",
          result: { chunkIndex: chunk.index, provider: voice.provider, voiceId: voice.id, format: "mp3", audio, cached: false, latencyMs: Math.round(performance.now() - t0) },
        };
      } catch (error) {
        const ownLimit = error instanceof RateLimitExceededError;
        if (!ownLimit) this.recordFailure(voice.provider);
        if (ownLimit || isTransient(error)) downForThisChunk.add(voice.provider);
        this.obs.increment(`tts.failure.${voice.provider}`);
        const reason = error instanceof Error ? error.message : String(error);
        reasons.push(`${voice.id}: ${reason}`);
        this.obs.warn("voice failed, trying next", { provider: voice.provider, voice: voice.id, chunk: chunk.index, reason });
      }
    }

    this.obs.increment("tts.device_fallback");
    const directive: DeviceFallbackDirective = {
      reason: reasons.length > 0 ? reasons.join("; ") : "no cloud voice provider is configured",
      hint: input.selection.deviceHint,
      ssml: this.ssmlFor(input, input.selection.primary, "device"),
    };
    return { kind: "device", directive, chunkIndex: chunk.index };
  }

  /**
   * Synthesise a whole plan in order, keeping one chunk of look-ahead in
   * flight so playback of chunk N never waits on the network for chunk N+1.
   */
  async *stream(inputs: readonly ChunkSynthesisInput[]): AsyncGenerator<ChunkOutcome, void, undefined> {
    let next: Promise<ChunkOutcome> | null = null;
    for (const [i, input] of inputs.entries()) {
      const current: Promise<ChunkOutcome> = next ?? this.synthesizeChunk(input);
      const following = inputs[i + 1];
      next = following !== undefined ? this.synthesizeChunk(following) : null;
      yield await current;
    }
  }
}
