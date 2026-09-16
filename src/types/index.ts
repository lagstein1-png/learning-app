/**
 * Formal contracts shared by every layer of the TTS backend.
 *
 * Everything the HTTP layer accepts or returns, everything the orchestration
 * graph carries between nodes, and everything the storage layer persists is
 * described here. No layer invents its own ad-hoc shapes.
 */

/** The four language tracks the product supports. ISO 639-1. */
export type LanguageCode = "he" | "en" | "ar" | "ru";

export const LANGUAGE_CODES: readonly LanguageCode[] = ["he", "en", "ar", "ru"] as const;

export type TextDirection = "rtl" | "ltr";

export type VoiceGender = "female" | "male";

/** Emotional colouring the pre-processor can detect and the voice selector can honour. */
export type SpeechMood = "neutral" | "warm" | "encouraging" | "calm" | "serious" | "cheerful";

/** Named cadence presets tuned for low cognitive load. */
export type CadencePreset = "slow" | "relaxed" | "natural" | "brisk";

export type AudioFormat = "mp3" | "ogg" | "wav";

/** Where a piece of audio was actually produced. */
export type ProviderId = "azure" | "google" | "device";

/** A neural voice available on a cloud provider. */
export interface VoiceProfile {
  /** Provider-specific voice identifier, e.g. `he-IL-HilaNeural`. */
  readonly id: string;
  readonly provider: Exclude<ProviderId, "device">;
  readonly language: LanguageCode;
  /** BCP-47 locale the provider expects, e.g. `he-IL`. */
  readonly locale: string;
  readonly gender: VoiceGender;
  /** Human readable, for logs and admin UIs. */
  readonly displayName: string;
  /** Provider quality tier; `neural` is the floor, `hd` is preferred. */
  readonly tier: "neural" | "hd";
  /** Provider style hints supported by this voice (Azure `mstts:express-as` styles). */
  readonly styles: readonly string[];
  /** Ranking inside the language: 0 is the most preferred. */
  readonly rank: number;
}

/** Concrete prosody settings after gender / mood / cadence are resolved. */
export interface ProsodySettings {
  /** Relative rate, 1.0 is provider default. */
  readonly rate: number;
  /** Semitone shift, 0 is neutral. */
  readonly pitchSemitones: number;
  /** Extra pause in milliseconds after sentence boundaries. */
  readonly sentencePauseMs: number;
  /** Extra pause in milliseconds at paragraph boundaries. */
  readonly paragraphPauseMs: number;
  /** Provider style name, when the chosen voice supports it. */
  readonly style: string | null;
}

/** The voice the selector resolved plus its ordered fallbacks. */
export interface VoiceSelection {
  readonly primary: VoiceProfile;
  readonly fallbacks: readonly VoiceProfile[];
  readonly prosody: ProsodySettings;
  /** Voice hint for on-device synthesis when every cloud provider is unavailable. */
  readonly deviceHint: DeviceVoiceHint;
}

export interface DeviceVoiceHint {
  readonly locale: string;
  readonly gender: VoiceGender;
  readonly rate: number;
  readonly pitch: number;
  /** Preferred on-device voice names, best first (Web Speech / AVSpeech / Android TTS). */
  readonly preferredNames: readonly string[];
}

/** A phonetic override row as stored in the dictionary. */
export interface PhoneticOverride {
  readonly id: string;
  readonly language: LanguageCode;
  /** The surface form as it appears in text. Matched case-insensitively on word boundaries. */
  readonly term: string;
  /** What the synthesiser should actually say. */
  readonly spokenForm: string;
  /** Optional IPA, emitted as `<phoneme>` when the provider supports it. */
  readonly ipa: string | null;
  /** `null` is a global override; a user id scopes it to that learner. */
  readonly userId: string | null;
  /** Domain tag, e.g. `driving-theory`, `math`, `civics`. */
  readonly domain: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PhoneticOverrideInput {
  readonly language: LanguageCode;
  readonly term: string;
  readonly spokenForm: string;
  readonly ipa?: string;
  readonly userId?: string;
  readonly domain?: string;
}

/** One replacement the dictionary applied, for transparency in the response. */
export interface AppliedOverride {
  readonly term: string;
  readonly spokenForm: string;
  readonly occurrences: number;
  readonly scope: "global" | "user";
}

/** Accessibility preferences a learner has saved. */
export interface AccessibilityPreferences {
  readonly userId: string;
  readonly language: LanguageCode;
  readonly gender: VoiceGender;
  readonly cadence: CadencePreset;
  readonly mood: SpeechMood;
  /** Maximum characters per chunk the learner is comfortable with. */
  readonly maxChunkChars: number;
  /** Whether the client should highlight words as they are spoken. */
  readonly wordHighlighting: boolean;
  readonly updatedAt: string;
}

export interface AccessibilityPreferencesInput {
  readonly language?: LanguageCode;
  readonly gender?: VoiceGender;
  readonly cadence?: CadencePreset;
  readonly mood?: SpeechMood;
  readonly maxChunkChars?: number;
  readonly wordHighlighting?: boolean;
}

/** Emphasis the pre-processor asked for on a span of the normalised text. */
export interface EmphasisMarker {
  /** The exact phrase, so offsets can be recomputed after later rewrites. */
  readonly phrase: string;
  readonly start: number;
  readonly end: number;
  readonly level: "moderate" | "strong";
  readonly reason: string;
}

/** A homograph the pre-processor resolved. */
export interface HomographResolution {
  readonly surface: string;
  readonly reading: string;
  readonly meaning: string;
}

/** Structured output of the linguistic pre-processing engine. */
export interface PreprocessResult {
  /** Text after punctuation clean-up and expansion, ready for chunking. */
  readonly text: string;
  readonly language: LanguageCode;
  readonly context: string;
  readonly mood: SpeechMood;
  readonly emphasis: readonly EmphasisMarker[];
  readonly homographs: readonly HomographResolution[];
  /** Additional `term → spokenForm` pairs the model proposed for this text only. */
  readonly phoneticAnnotations: readonly { readonly term: string; readonly spokenForm: string }[];
  /** `gemini` when the model answered, `rules` when the deterministic layer produced this result. */
  readonly source: "gemini" | "rules";
  readonly latencyMs: number;
}

/** One chunk of speech, sized to stay natural and never time out. */
export interface SpeechChunk {
  readonly index: number;
  readonly text: string;
  /** Character offsets into the pre-processed text so clients can highlight. */
  readonly start: number;
  readonly end: number;
  /** `paragraph` chunks get the longer pause after them. */
  readonly boundary: "sentence" | "paragraph" | "end";
  readonly estimatedDurationMs: number;
  /** Stable hash of (text, voice, prosody) used as the audio cache key. */
  readonly cacheKey: string;
}

export interface ChunkPlan {
  readonly chunks: readonly SpeechChunk[];
  readonly totalEstimatedDurationMs: number;
  readonly maxChunkChars: number;
}

/** Result of synthesising a single chunk. */
export interface SynthesisResult {
  readonly chunkIndex: number;
  readonly provider: ProviderId;
  readonly voiceId: string;
  readonly format: AudioFormat;
  readonly audio: Buffer;
  readonly cached: boolean;
  readonly latencyMs: number;
}

/** What the client should do when no cloud audio could be produced. */
export interface DeviceFallbackDirective {
  readonly reason: string;
  readonly hint: DeviceVoiceHint;
  readonly ssml: string;
}

// ────────────────────────────── HTTP contracts ──────────────────────────────

export interface ProcessTextRequest {
  readonly text: string;
  readonly language: LanguageCode;
  readonly userId?: string;
  readonly gender?: VoiceGender;
  readonly cadence?: CadencePreset;
  readonly mood?: SpeechMood;
  readonly domain?: string;
  readonly maxChunkChars?: number;
  /** Skip the Gemini call and use the deterministic layer only. */
  readonly skipAi?: boolean;
}

export interface ProcessTextResponse {
  readonly requestId: string;
  readonly language: LanguageCode;
  readonly direction: TextDirection;
  readonly preprocess: PreprocessResult;
  readonly overrides: readonly AppliedOverride[];
  readonly voice: {
    readonly id: string;
    readonly provider: ProviderId;
    readonly displayName: string;
    readonly gender: VoiceGender;
    readonly fallbacks: readonly string[];
    readonly prosody: ProsodySettings;
    readonly deviceHint: DeviceVoiceHint;
  };
  readonly plan: ChunkPlan;
  /** Opaque token the client passes to `/get-audio`. */
  readonly planToken: string;
  readonly timings: Readonly<Record<string, number>>;
}

export interface GetAudioQuery {
  readonly planToken: string;
  /** Omit for the whole plan streamed as one MP3; set for one chunk. */
  readonly chunk?: number;
}

export type DictionaryOverrideRequest = PhoneticOverrideInput;

export interface DictionaryOverrideResponse {
  readonly override: PhoneticOverride;
  readonly created: boolean;
}

export interface DictionaryListResponse {
  readonly language: LanguageCode;
  readonly userId: string | null;
  readonly overrides: readonly PhoneticOverride[];
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

export interface HealthResponse {
  readonly status: "ok";
  readonly service: string;
  readonly version: string;
  readonly languages: readonly LanguageCode[];
  readonly providers: Readonly<Record<Exclude<ProviderId, "device">, boolean>>;
  readonly gemini: boolean;
  readonly supabase: boolean;
  readonly uptimeSeconds: number;
}
