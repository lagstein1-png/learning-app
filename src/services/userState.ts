/**
 * Learner accessibility preferences: language, voice gender, cadence, mood,
 * chunk size and word highlighting. Stored per user id in Supabase, with an
 * in-memory store for tests and for deployments without a database.
 */
import { DEFAULT_CADENCE, DEFAULT_GENDER, DEFAULT_MOOD, ERROR_CODES, LIMITS } from "../config/constants.js";
import type { AccessibilityPreferences, AccessibilityPreferencesInput, LanguageCode } from "../types/index.js";
import { AppError } from "../utils/errors.js";
import { preferencesFromRow, preferencesRowSchema, TABLES, type Db } from "./supabase.js";

export interface PreferencesStore {
  get(userId: string): Promise<AccessibilityPreferences | null>;
  upsert(userId: string, input: AccessibilityPreferencesInput): Promise<AccessibilityPreferences>;
}

export function defaultPreferences(userId: string, language: LanguageCode): AccessibilityPreferences {
  return {
    userId,
    language,
    gender: DEFAULT_GENDER,
    cadence: DEFAULT_CADENCE,
    mood: DEFAULT_MOOD,
    maxChunkChars: LIMITS.defaultChunkChars,
    wordHighlighting: true,
    updatedAt: new Date(0).toISOString(),
  };
}

function merge(base: AccessibilityPreferences, input: AccessibilityPreferencesInput): AccessibilityPreferences {
  return {
    userId: base.userId,
    language: input.language ?? base.language,
    gender: input.gender ?? base.gender,
    cadence: input.cadence ?? base.cadence,
    mood: input.mood ?? base.mood,
    maxChunkChars: input.maxChunkChars ?? base.maxChunkChars,
    wordHighlighting: input.wordHighlighting ?? base.wordHighlighting,
    updatedAt: new Date().toISOString(),
  };
}

export class MemoryPreferencesStore implements PreferencesStore {
  private readonly rows = new Map<string, AccessibilityPreferences>();

  get(userId: string): Promise<AccessibilityPreferences | null> {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }

  upsert(userId: string, input: AccessibilityPreferencesInput): Promise<AccessibilityPreferences> {
    const base = this.rows.get(userId) ?? defaultPreferences(userId, input.language ?? "he");
    const next = merge(base, input);
    this.rows.set(userId, next);
    return Promise.resolve(next);
  }
}

export class SupabasePreferencesStore implements PreferencesStore {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<AccessibilityPreferences | null> {
    const { data, error } = await this.db.from(TABLES.preferences).select("*").eq("user_id", userId).maybeSingle();
    if (error) throw new AppError(ERROR_CODES.STORAGE, `preferences read failed: ${error.message}`, { retryable: true });
    if (data === null) return null;
    return preferencesFromRow(preferencesRowSchema.parse(data));
  }

  async upsert(userId: string, input: AccessibilityPreferencesInput): Promise<AccessibilityPreferences> {
    const base = (await this.get(userId)) ?? defaultPreferences(userId, input.language ?? "he");
    const next = merge(base, input);
    const { data, error } = await this.db
      .from(TABLES.preferences)
      .upsert(
        {
          user_id: next.userId,
          language: next.language,
          gender: next.gender,
          cadence: next.cadence,
          mood: next.mood,
          max_chunk_chars: next.maxChunkChars,
          word_highlighting: next.wordHighlighting,
          updated_at: next.updatedAt,
        },
        { onConflict: "user_id" },
      )
      .select("*")
      .single();
    if (error) throw new AppError(ERROR_CODES.STORAGE, `preferences write failed: ${error.message}`, { retryable: true });
    return preferencesFromRow(preferencesRowSchema.parse(data));
  }
}

export class UserStateService {
  constructor(private readonly store: PreferencesStore) {}

  /** Stored preferences, or defaults for the requested language when the learner has none. */
  async preferencesFor(userId: string | null, language: LanguageCode): Promise<AccessibilityPreferences> {
    if (userId === null) return defaultPreferences("anonymous", language);
    const stored = await this.store.get(userId);
    return stored ?? defaultPreferences(userId, language);
  }

  update(userId: string, input: AccessibilityPreferencesInput): Promise<AccessibilityPreferences> {
    return this.store.upsert(userId, input);
  }
}
