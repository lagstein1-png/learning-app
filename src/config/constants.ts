/**
 * Strongly typed, immutable configuration: the language matrix, the neural
 * voice catalogue, prosody presets and hard limits.
 *
 * Secrets and deployment-specific values are NOT here; they are parsed and
 * validated from the environment in `env.ts`. Everything in this file is a
 * product decision that should be reviewed in code review, not tuned per
 * deployment.
 */
import type {
  CadencePreset,
  LanguageCode,
  ProsodySettings,
  SpeechMood,
  TextDirection,
  VoiceGender,
  VoiceProfile,
} from "../types/index.js";

export const SERVICE_VERSION = "1.0.0";

/** Per-language configuration used by chunking, normalisation and voice selection. */
export interface LanguageSpec {
  readonly code: LanguageCode;
  readonly locale: string;
  readonly direction: TextDirection;
  readonly nativeName: string;
  /** Sentence terminators specific to the script, in addition to `.?!`. */
  readonly sentenceTerminators: readonly string[];
  /** Clause separators used as secondary split points. */
  readonly clauseSeparators: readonly string[];
  /** Average characters spoken per second at rate 1.0, measured against provider output. */
  readonly charsPerSecond: number;
  /** Whether the script uses combining diacritics that must be preserved for pronunciation. */
  readonly hasDiacritics: boolean;
  /** Unicode range of the script's letters, used to detect language mismatch. */
  readonly scriptRange: RegExp;
}

export const LANGUAGES: Readonly<Record<LanguageCode, LanguageSpec>> = {
  he: {
    code: "he",
    locale: "he-IL",
    direction: "rtl",
    nativeName: "עברית",
    sentenceTerminators: [".", "?", "!", "׃"],
    clauseSeparators: [",", ";", ":", "–", "—", "־"],
    charsPerSecond: 13,
    hasDiacritics: true,
    scriptRange: /[\u0590-\u05FF]/u,
  },
  en: {
    code: "en",
    locale: "en-US",
    direction: "ltr",
    nativeName: "English",
    sentenceTerminators: [".", "?", "!"],
    clauseSeparators: [",", ";", ":", "–", "—"],
    charsPerSecond: 15,
    hasDiacritics: false,
    scriptRange: /[A-Za-z]/u,
  },
  ar: {
    code: "ar",
    locale: "ar-EG",
    direction: "rtl",
    nativeName: "العربية",
    sentenceTerminators: [".", "؟", "!", "?"],
    clauseSeparators: ["،", "؛", ",", ":", "–", "—"],
    charsPerSecond: 12,
    hasDiacritics: true,
    scriptRange: /[\u0600-\u06FF]/u,
  },
  ru: {
    code: "ru",
    locale: "ru-RU",
    direction: "ltr",
    nativeName: "Русский",
    sentenceTerminators: [".", "?", "!"],
    clauseSeparators: [",", ";", ":", "–", "—"],
    charsPerSecond: 14,
    hasDiacritics: false,
    scriptRange: /[\u0400-\u04FF]/u,
  },
};

/**
 * The neural voice catalogue. Female voices with warm, clear delivery are
 * ranked first in every language; male voices remain available for learners
 * who prefer them. Rank 0 is the default.
 */
export const VOICE_CATALOGUE: readonly VoiceProfile[] = [
  // ── Hebrew ────────────────────────────────────────────────────────────
  { id: "he-IL-HilaNeural", provider: "azure", language: "he", locale: "he-IL", gender: "female", displayName: "Hila (Azure)", tier: "neural", styles: [], rank: 0 },
  { id: "he-IL-Wavenet-A", provider: "google", language: "he", locale: "he-IL", gender: "female", displayName: "Wavenet A (Google)", tier: "neural", styles: [], rank: 1 },
  { id: "he-IL-Wavenet-C", provider: "google", language: "he", locale: "he-IL", gender: "female", displayName: "Wavenet C (Google)", tier: "neural", styles: [], rank: 2 },
  { id: "he-IL-AvriNeural", provider: "azure", language: "he", locale: "he-IL", gender: "male", displayName: "Avri (Azure)", tier: "neural", styles: [], rank: 3 },
  { id: "he-IL-Wavenet-B", provider: "google", language: "he", locale: "he-IL", gender: "male", displayName: "Wavenet B (Google)", tier: "neural", styles: [], rank: 4 },
  // ── English ───────────────────────────────────────────────────────────
  { id: "en-US-JennyNeural", provider: "azure", language: "en", locale: "en-US", gender: "female", displayName: "Jenny (Azure)", tier: "neural", styles: ["assistant", "chat", "customerservice", "newscast", "angry", "cheerful", "sad", "excited", "friendly", "terrified", "shouting", "unfriendly", "whispering", "hopeful"], rank: 0 },
  { id: "en-US-AriaNeural", provider: "azure", language: "en", locale: "en-US", gender: "female", displayName: "Aria (Azure)", tier: "neural", styles: ["chat", "customerservice", "narration-professional", "newscast-casual", "newscast-formal", "cheerful", "empathetic", "angry", "sad", "excited", "friendly", "terrified", "shouting", "unfriendly", "whispering", "hopeful"], rank: 1 },
  { id: "en-US-Neural2-F", provider: "google", language: "en", locale: "en-US", gender: "female", displayName: "Neural2 F (Google)", tier: "neural", styles: [], rank: 2 },
  { id: "en-US-GuyNeural", provider: "azure", language: "en", locale: "en-US", gender: "male", displayName: "Guy (Azure)", tier: "neural", styles: ["newscast", "angry", "cheerful", "sad", "excited", "friendly", "terrified", "shouting", "unfriendly", "whispering", "hopeful"], rank: 3 },
  { id: "en-US-Neural2-D", provider: "google", language: "en", locale: "en-US", gender: "male", displayName: "Neural2 D (Google)", tier: "neural", styles: [], rank: 4 },
  // ── Arabic ────────────────────────────────────────────────────────────
  { id: "ar-EG-SalmaNeural", provider: "azure", language: "ar", locale: "ar-EG", gender: "female", displayName: "Salma (Azure)", tier: "neural", styles: [], rank: 0 },
  { id: "ar-SA-ZariyahNeural", provider: "azure", language: "ar", locale: "ar-SA", gender: "female", displayName: "Zariyah (Azure)", tier: "neural", styles: [], rank: 1 },
  { id: "ar-XA-Wavenet-A", provider: "google", language: "ar", locale: "ar-XA", gender: "female", displayName: "Wavenet A (Google)", tier: "neural", styles: [], rank: 2 },
  { id: "ar-EG-ShakirNeural", provider: "azure", language: "ar", locale: "ar-EG", gender: "male", displayName: "Shakir (Azure)", tier: "neural", styles: [], rank: 3 },
  { id: "ar-XA-Wavenet-B", provider: "google", language: "ar", locale: "ar-XA", gender: "male", displayName: "Wavenet B (Google)", tier: "neural", styles: [], rank: 4 },
  // ── Russian ───────────────────────────────────────────────────────────
  { id: "ru-RU-SvetlanaNeural", provider: "azure", language: "ru", locale: "ru-RU", gender: "female", displayName: "Svetlana (Azure)", tier: "neural", styles: [], rank: 0 },
  { id: "ru-RU-DariyaNeural", provider: "azure", language: "ru", locale: "ru-RU", gender: "female", displayName: "Dariya (Azure)", tier: "neural", styles: [], rank: 1 },
  { id: "ru-RU-Wavenet-C", provider: "google", language: "ru", locale: "ru-RU", gender: "female", displayName: "Wavenet C (Google)", tier: "neural", styles: [], rank: 2 },
  { id: "ru-RU-DmitryNeural", provider: "azure", language: "ru", locale: "ru-RU", gender: "male", displayName: "Dmitry (Azure)", tier: "neural", styles: [], rank: 3 },
  { id: "ru-RU-Wavenet-B", provider: "google", language: "ru", locale: "ru-RU", gender: "male", displayName: "Wavenet B (Google)", tier: "neural", styles: [], rank: 4 },
];

/**
 * On-device voice names, best first, for the moment every cloud provider is
 * unavailable. These are the names Web Speech, AVSpeechSynthesis and Android
 * TTS expose; the client matches them by substring.
 */
export const DEVICE_VOICE_NAMES: Readonly<Record<LanguageCode, Readonly<Record<VoiceGender, readonly string[]>>>> = {
  he: {
    female: ["Microsoft Hila Online", "Hila", "Carmit", "Google עברית", "he-IL-language"],
    male: ["Microsoft Avri Online", "Avri", "Google עברית", "he-IL-language"],
  },
  en: {
    female: ["Microsoft Jenny Online", "Microsoft Aria Online", "Samantha", "Google US English", "en-US-language"],
    male: ["Microsoft Guy Online", "Daniel", "Alex", "Google US English", "en-US-language"],
  },
  ar: {
    female: ["Microsoft Salma Online", "Microsoft Zariyah Online", "Laila", "Google العربية", "ar-XA-language"],
    male: ["Microsoft Shakir Online", "Majed", "Google العربية", "ar-XA-language"],
  },
  ru: {
    female: ["Microsoft Svetlana Online", "Microsoft Dariya Online", "Milena", "Google русский", "ru-RU-language"],
    male: ["Microsoft Dmitry Online", "Yuri", "Google русский", "ru-RU-language"],
  },
};

/** Cadence presets. Rates below 1.0 lower cognitive load for dyslexic readers. */
export const CADENCE_PRESETS: Readonly<Record<CadencePreset, Pick<ProsodySettings, "rate" | "sentencePauseMs" | "paragraphPauseMs">>> = {
  slow: { rate: 0.8, sentencePauseMs: 550, paragraphPauseMs: 1000 },
  relaxed: { rate: 0.9, sentencePauseMs: 400, paragraphPauseMs: 800 },
  natural: { rate: 1.0, sentencePauseMs: 300, paragraphPauseMs: 650 },
  brisk: { rate: 1.1, sentencePauseMs: 200, paragraphPauseMs: 450 },
};

/** Mood → pitch and provider style. Styles apply only where the voice supports them. */
export const MOOD_PRESETS: Readonly<Record<SpeechMood, { readonly pitchSemitones: number; readonly style: string | null; readonly rateMultiplier: number }>> = {
  neutral: { pitchSemitones: 0, style: null, rateMultiplier: 1.0 },
  warm: { pitchSemitones: 0.5, style: "friendly", rateMultiplier: 0.97 },
  encouraging: { pitchSemitones: 1, style: "hopeful", rateMultiplier: 1.0 },
  calm: { pitchSemitones: -0.5, style: "empathetic", rateMultiplier: 0.93 },
  serious: { pitchSemitones: -1, style: "narration-professional", rateMultiplier: 0.98 },
  cheerful: { pitchSemitones: 1.5, style: "cheerful", rateMultiplier: 1.03 },
};

export const DEFAULT_GENDER: VoiceGender = "female";
export const DEFAULT_CADENCE: CadencePreset = "relaxed";
export const DEFAULT_MOOD: SpeechMood = "warm";

/** Hard limits that protect providers and keep long sessions responsive. */
export const LIMITS = {
  /** Longest text a single `/process-text` call accepts. */
  maxInputChars: 20000,
  /** Default and ceiling for characters per synthesis chunk. Azure hard-limits SSML at 10 minutes; 600 chars stays far under it. */
  defaultChunkChars: 320,
  maxChunkChars: 600,
  minChunkChars: 80,
  /** Gemini is skipped for texts shorter than this; the rule layer is enough. */
  minCharsForAi: 24,
  /** Longest text sent to Gemini in one call. */
  maxCharsForAi: 6000,
  /** Plan tokens expire after this many milliseconds. */
  planTtlMs: 30 * 60 * 1000,
  maxPlansInMemory: 2000,
  /** Largest single audio payload cached inline in Postgres (bytes). */
  maxCachedAudioBytes: 2 * 1024 * 1024,
} as const;

/** Provider endpoints. Region placeholders are substituted from env. */
export const PROVIDER_ENDPOINTS = {
  azure: {
    tts: (region: string): string => `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
  },
  google: {
    tts: "https://texttospeech.googleapis.com/v1/text:synthesize",
    audioEncoding: "MP3",
  },
} as const;

/** Error codes returned to clients. Stable strings; never renumber. */
export const ERROR_CODES = {
  VALIDATION: "E_VALIDATION",
  UNAUTHORIZED: "E_UNAUTHORIZED",
  NOT_FOUND: "E_NOT_FOUND",
  PLAN_EXPIRED: "E_PLAN_EXPIRED",
  RATE_LIMITED: "E_RATE_LIMITED",
  PROVIDER_UNAVAILABLE: "E_PROVIDER_UNAVAILABLE",
  PREPROCESS_FAILED: "E_PREPROCESS_FAILED",
  STORAGE: "E_STORAGE",
  INTERNAL: "E_INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
