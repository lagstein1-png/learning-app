/**
 * Two-tier audio cache: an in-process LRU in front of a Supabase table.
 *
 * The same sentence read by the same voice with the same prosody is byte-for-
 * byte identical, so the cache key is a hash of exactly those inputs. Cached
 * audio never hits a provider again, which is what keeps long read-aloud
 * sessions fast and inside free-tier quotas.
 */
import { ERROR_CODES, LIMITS } from "../config/constants.js";
import type { AudioFormat, LanguageCode, ProviderId } from "../types/index.js";
import { AppError } from "../utils/errors.js";
import type { Observability } from "./observability.js";
import { audioCacheRowSchema, TABLES, type Db } from "./supabase.js";

export interface CachedAudio {
  readonly audio: Buffer;
  readonly provider: Exclude<ProviderId, "device">;
  readonly voiceId: string;
  readonly format: AudioFormat;
  readonly language: LanguageCode;
}

export interface AudioCacheStore {
  get(key: string): Promise<CachedAudio | null>;
  put(key: string, entry: CachedAudio): Promise<void>;
}

export class MemoryAudioCache implements AudioCacheStore {
  private readonly items = new Map<string, { entry: CachedAudio; expiresAt: number }>();

  constructor(
    private readonly maxItems: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Promise<CachedAudio | null> {
    const hit = this.items.get(key);
    if (!hit) return Promise.resolve(null);
    if (this.ttlMs > 0 && hit.expiresAt <= this.now()) {
      this.items.delete(key);
      return Promise.resolve(null);
    }
    // Refresh recency: Map preserves insertion order, so re-inserting moves it to the end.
    this.items.delete(key);
    this.items.set(key, hit);
    return Promise.resolve(hit.entry);
  }

  put(key: string, entry: CachedAudio): Promise<void> {
    if (this.maxItems === 0) return Promise.resolve();
    this.items.delete(key);
    this.items.set(key, { entry, expiresAt: this.ttlMs > 0 ? this.now() + this.ttlMs : Number.POSITIVE_INFINITY });
    while (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
    return Promise.resolve();
  }

  get size(): number {
    return this.items.size;
  }
}

export class SupabaseAudioCache implements AudioCacheStore {
  constructor(
    private readonly db: Db,
    private readonly ttlSeconds: number,
  ) {}

  async get(key: string): Promise<CachedAudio | null> {
    const { data, error } = await this.db.from(TABLES.audioCache).select("*").eq("cache_key", key).maybeSingle();
    if (error) throw new AppError(ERROR_CODES.STORAGE, `audio cache read failed: ${error.message}`, { retryable: true });
    if (data === null) return null;
    const row = audioCacheRowSchema.parse(data);
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) {
      await this.db.from(TABLES.audioCache).delete().eq("cache_key", key);
      return null;
    }
    await this.db.from(TABLES.audioCache).update({ hits: row.hits + 1 }).eq("cache_key", key);
    return {
      audio: Buffer.from(row.audio_base64, "base64"),
      provider: row.provider,
      voiceId: row.voice_id,
      format: row.format,
      language: row.language,
    };
  }

  async put(key: string, entry: CachedAudio): Promise<void> {
    if (entry.audio.byteLength > LIMITS.maxCachedAudioBytes) return;
    const now = new Date();
    const expiresAt = this.ttlSeconds > 0 ? new Date(now.getTime() + this.ttlSeconds * 1000).toISOString() : null;
    const { error } = await this.db.from(TABLES.audioCache).upsert(
      {
        cache_key: key,
        provider: entry.provider,
        voice_id: entry.voiceId,
        format: entry.format,
        language: entry.language,
        audio_base64: entry.audio.toString("base64"),
        bytes: entry.audio.byteLength,
        created_at: now.toISOString(),
        expires_at: expiresAt,
        hits: 0,
      },
      { onConflict: "cache_key" },
    );
    if (error) throw new AppError(ERROR_CODES.STORAGE, `audio cache write failed: ${error.message}`, { retryable: true });
  }
}

/** Memory first, then the durable store; writes go to both. Storage failures never fail synthesis. */
export class TieredAudioCache implements AudioCacheStore {
  constructor(
    private readonly memory: MemoryAudioCache,
    private readonly durable: AudioCacheStore | null,
    private readonly obs: Observability,
  ) {}

  async get(key: string): Promise<CachedAudio | null> {
    const local = await this.memory.get(key);
    if (local) {
      this.obs.increment("audio_cache.hit.memory");
      return local;
    }
    if (!this.durable) return null;
    try {
      const remote = await this.durable.get(key);
      if (remote) {
        this.obs.increment("audio_cache.hit.durable");
        await this.memory.put(key, remote);
      }
      return remote;
    } catch (error) {
      this.obs.warn("audio cache durable read failed; continuing without cache", { key, reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async put(key: string, entry: CachedAudio): Promise<void> {
    await this.memory.put(key, entry);
    if (!this.durable) return;
    try {
      await this.durable.put(key, entry);
    } catch (error) {
      this.obs.warn("audio cache durable write failed; entry kept in memory only", { key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}
