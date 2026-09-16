/**
 * Supabase client factory, the typed database schema and row validators.
 *
 * The backend is the only Supabase client; it uses the service-role key and
 * therefore bypasses RLS. The `Database` type mirrors
 * `supabase/migrations/0001_init.sql` so every query is typed end to end,
 * and rows are additionally validated with zod on the way in, so a schema
 * drift in the database surfaces as a clear error instead of a silent
 * `undefined`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { LANGUAGE_CODES } from "../types/index.js";
import type { AccessibilityPreferences, LanguageCode, PhoneticOverride } from "../types/index.js";

/* eslint-disable @typescript-eslint/consistent-type-definitions -- supabase-js requires type literals: an interface has no implicit index signature and would not satisfy `Record<string, unknown>` */
export type OverrideRow = {
  id: string;
  language: LanguageCode;
  term: string;
  term_key: string;
  spoken_form: string;
  ipa: string | null;
  user_id: string | null;
  domain: string | null;
  created_at: string;
  updated_at: string;
};

export type OverrideInsert = {
  id?: string;
  language: LanguageCode;
  term: string;
  spoken_form: string;
  ipa?: string | null;
  user_id?: string | null;
  domain?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type PreferencesRow = {
  user_id: string;
  language: LanguageCode;
  gender: "female" | "male";
  cadence: "slow" | "relaxed" | "natural" | "brisk";
  mood: "neutral" | "warm" | "encouraging" | "calm" | "serious" | "cheerful";
  max_chunk_chars: number;
  word_highlighting: boolean;
  updated_at: string;
};

export type AudioCacheRow = {
  cache_key: string;
  provider: "azure" | "google";
  voice_id: string;
  format: "mp3" | "ogg" | "wav";
  language: LanguageCode;
  audio_base64: string;
  bytes: number;
  created_at: string;
  expires_at: string | null;
  hits: number;
};

export type RequestLogRow = {
  id: string;
  request_id: string;
  trace_id: string;
  user_id: string | null;
  language: LanguageCode;
  chars: number;
  chunks: number;
  preprocess_source: "gemini" | "rules";
  voice_id: string;
  duration_ms: number;
  created_at: string;
};

export type RequestLogInsert = Omit<RequestLogRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

/** Typed schema for `createClient<Database>`; keep in sync with the SQL migration. */
export type Database = {
  public: {
    Tables: {
      phonetic_overrides: { Row: OverrideRow; Insert: OverrideInsert; Update: Partial<OverrideInsert>; Relationships: [] };
      accessibility_preferences: { Row: PreferencesRow; Insert: PreferencesRow; Update: Partial<PreferencesRow>; Relationships: [] };
      audio_cache: { Row: AudioCacheRow; Insert: AudioCacheRow; Update: Partial<AudioCacheRow>; Relationships: [] };
      tts_requests: { Row: RequestLogRow; Insert: RequestLogInsert; Update: Partial<RequestLogInsert>; Relationships: [] };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

export type Db = SupabaseClient<Database>;

export function createSupabaseClient(url: string, serviceRoleKey: string): Db {
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "learning-app-tts/1.0.0" } },
  });
}

export const TABLES = {
  overrides: "phonetic_overrides",
  preferences: "accessibility_preferences",
  audioCache: "audio_cache",
  requests: "tts_requests",
} as const;

const languageSchema = z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]);

export const overrideRowSchema: z.ZodType<OverrideRow> = z.object({
  id: z.string(),
  language: languageSchema,
  term: z.string(),
  term_key: z.string(),
  spoken_form: z.string(),
  ipa: z.string().nullable(),
  user_id: z.string().nullable(),
  domain: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function overrideFromRow(row: OverrideRow): PhoneticOverride {
  return {
    id: row.id,
    language: row.language,
    term: row.term,
    spokenForm: row.spoken_form,
    ipa: row.ipa,
    userId: row.user_id,
    domain: row.domain,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const preferencesRowSchema: z.ZodType<PreferencesRow> = z.object({
  user_id: z.string(),
  language: languageSchema,
  gender: z.enum(["female", "male"]),
  cadence: z.enum(["slow", "relaxed", "natural", "brisk"]),
  mood: z.enum(["neutral", "warm", "encouraging", "calm", "serious", "cheerful"]),
  max_chunk_chars: z.number().int(),
  word_highlighting: z.boolean(),
  updated_at: z.string(),
});

export function preferencesFromRow(row: PreferencesRow): AccessibilityPreferences {
  return {
    userId: row.user_id,
    language: row.language,
    gender: row.gender,
    cadence: row.cadence,
    mood: row.mood,
    maxChunkChars: row.max_chunk_chars,
    wordHighlighting: row.word_highlighting,
    updatedAt: row.updated_at,
  };
}

export const audioCacheRowSchema: z.ZodType<AudioCacheRow> = z.object({
  cache_key: z.string(),
  provider: z.enum(["azure", "google"]),
  voice_id: z.string(),
  format: z.enum(["mp3", "ogg", "wav"]),
  language: languageSchema,
  audio_base64: z.string(),
  bytes: z.number().int(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  hits: z.number().int(),
});
