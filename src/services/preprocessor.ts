/**
 * Linguistic pre-processing engine.
 *
 * Two layers, always in this order:
 *
 *   1. A deterministic rule layer (`applyRules`) that cleans punctuation,
 *      neutralises URLs and repeated symbols, and derives a coarse mood from
 *      punctuation. It runs on every request and never fails.
 *   2. Gemini (Google AI Studio, `@google/genai`) asked for a strict JSON
 *      payload: cleaned text, context, mood, emphasis phrases, resolved
 *      homographs and per-text phonetic annotations. The response is
 *      validated with zod and sanity-checked (length drift, script match)
 *      before it is trusted. Any failure — timeout, quota, malformed JSON,
 *      drift — falls back to the rule-layer result with `source: "rules"`,
 *      so the learner always gets audio.
 */
import { ApiError, GoogleGenAI, Type, type Schema } from "@google/genai";
import { z } from "zod";
import { LANGUAGES, LIMITS } from "../config/constants.js";
import type { EmphasisMarker, HomographResolution, LanguageCode, PreprocessResult, SpeechMood } from "../types/index.js";
import { ProviderHttpError } from "../utils/errors.js";
import { withRetry, withTimeout } from "../utils/retry.js";
import { detectScript, normaliseText } from "../utils/text.js";
import type { Observability } from "./observability.js";

/** Minimal model client so tests can inject a fake without touching the network. */
export interface LanguageModelClient {
  generateJson(input: { systemInstruction: string; prompt: string; schema: Schema; signal: AbortSignal }): Promise<{ text: string; promptTokens: number; outputTokens: number }>;
}

export class GeminiClient implements LanguageModelClient {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateJson(input: { systemInstruction: string; prompt: string; schema: Schema; signal: AbortSignal }): Promise<{ text: string; promptTokens: number; outputTokens: number }> {
    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: input.prompt,
        config: {
          systemInstruction: input.systemInstruction,
          responseMimeType: "application/json",
          responseSchema: input.schema,
          temperature: 0.2,
          maxOutputTokens: 4096,
          abortSignal: input.signal,
        },
      });
      return {
        text: response.text ?? "",
        promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      };
    } catch (error) {
      if (error instanceof ApiError) throw new ProviderHttpError("gemini", error.status, error.message);
      throw error;
    }
  }
}

const MOODS: readonly SpeechMood[] = ["neutral", "warm", "encouraging", "calm", "serious", "cheerful"];

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING, description: "The text ready for speech synthesis, same language, same meaning, punctuation cleaned." },
    context: { type: Type.STRING, description: "One sentence: what kind of text this is and who it addresses." },
    mood: { type: Type.STRING, enum: [...MOODS], description: "The delivery mood that best serves a learner with dyslexia or ADHD." },
    emphasis: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          phrase: { type: Type.STRING, description: "Exact substring of `text` to stress." },
          level: { type: Type.STRING, enum: ["moderate", "strong"] },
          reason: { type: Type.STRING },
        },
        required: ["phrase", "level", "reason"],
      },
    },
    homographs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          surface: { type: Type.STRING, description: "The ambiguous word exactly as written in `text`." },
          reading: { type: Type.STRING, description: "Unambiguous spelling for speech: with vowel points (niqqud/tashkeel), stress mark, or respelling." },
          meaning: { type: Type.STRING },
        },
        required: ["surface", "reading", "meaning"],
      },
    },
    phoneticAnnotations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          term: { type: Type.STRING, description: "Acronym, loanword, symbol or domain term exactly as it appears in `text`." },
          spokenForm: { type: Type.STRING, description: "How it should be read aloud in the same language." },
        },
        required: ["term", "spokenForm"],
      },
    },
  },
  required: ["text", "context", "mood", "emphasis", "homographs", "phoneticAnnotations"],
};

const responseSchema = z.object({
  text: z.string().min(1),
  context: z.string(),
  mood: z.enum(MOODS as [SpeechMood, ...SpeechMood[]]),
  emphasis: z.array(z.object({ phrase: z.string().min(1), level: z.enum(["moderate", "strong"]), reason: z.string() })).max(40),
  homographs: z.array(z.object({ surface: z.string().min(1), reading: z.string().min(1), meaning: z.string() })).max(60),
  phoneticAnnotations: z.array(z.object({ term: z.string().min(1), spokenForm: z.string().min(1) })).max(60),
});

type ModelPayload = z.infer<typeof responseSchema>;

const LANGUAGE_NAMES: Readonly<Record<LanguageCode, string>> = { he: "Hebrew", en: "English", ar: "Arabic", ru: "Russian" };

function systemInstruction(language: LanguageCode): string {
  const name = LANGUAGE_NAMES[language];
  return [
    `You prepare ${name} text for a neural text-to-speech voice used by learners with dyslexia, ADHD and new immigrants.`,
    "Return only the JSON object described by the schema.",
    "Rules for `text`:",
    `- Keep the language ${name}. Never translate, never summarise, never add or remove information.`,
    "- Keep every sentence; you may split a very long sentence at a natural clause boundary.",
    "- Normalise punctuation so pauses fall where a careful human reader would pause.",
    "- Write numbers, dates, units and symbols the way a teacher would say them aloud in this language.",
    "- Remove markup, list bullets, URLs and emoji; say 'link' in the language where a URL stood.",
    language === "he" || language === "ar"
      ? "- Where a word is ambiguous without vowel points, list it under `homographs` with a vowel-pointed `reading`; do not vowel-point the whole text."
      : "- Where a word is a heteronym (spelling shared by two pronunciations), list it under `homographs` with a `reading` that resolves it (stress mark or respelling).",
    "Rules for `emphasis`: at most one phrase per sentence, only where stress helps comprehension (a key term, a negation, a number that matters). `phrase` must be copied verbatim from `text`.",
    "Rules for `phoneticAnnotations`: acronyms, foreign brand names, abbreviations and domain terms that a synthesiser would misread. `term` must be copied verbatim from `text`.",
    "Rules for `mood`: choose the delivery that lowers cognitive load — `warm` for explanations, `encouraging` for feedback, `calm` for instructions, `serious` for warnings, `cheerful` only for praise, `neutral` otherwise.",
  ].join("\n");
}

export interface PreprocessOptions {
  readonly language: LanguageCode;
  readonly skipAi?: boolean;
  readonly domain?: string;
}

export interface PreprocessorConfig {
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu;
const LINK_WORD: Readonly<Record<LanguageCode, string>> = { he: "קישור", en: "link", ar: "رابط", ru: "ссылка" };

/** Deterministic layer. Pure and total. */
export function applyRules(raw: string, language: LanguageCode): Omit<PreprocessResult, "latencyMs" | "source"> {
  const link = LINK_WORD[language];
  const text = normaliseText(raw.replace(URL_RE, ` ${link} `)).replace(/\s{2,}/gu, " ");
  const exclamations = (text.match(/!/gu) ?? []).length;
  const questions = (text.match(/[?؟]/gu) ?? []).length;
  const sentences = Math.max(1, (text.match(/[.!?؟](\s|$)/gu) ?? []).length);
  let mood: SpeechMood = "warm";
  if (exclamations > 0 && exclamations >= sentences / 2) mood = "encouraging";
  else if (questions > 0 && questions >= sentences / 2) mood = "neutral";
  return {
    text,
    language,
    context: `${LANGUAGE_NAMES[language]} text, ${sentences} sentence${sentences === 1 ? "" : "s"}, rule-based analysis`,
    mood,
    emphasis: [],
    homographs: [],
    phoneticAnnotations: [],
  };
}

/** Find `phrases` in `text` and turn them into offset markers; phrases that no longer occur are dropped. */
export function locateEmphasis(text: string, markers: readonly Pick<EmphasisMarker, "phrase" | "level" | "reason">[]): EmphasisMarker[] {
  const out: EmphasisMarker[] = [];
  let cursor = 0;
  for (const m of markers) {
    const phrase = m.phrase.trim();
    if (phrase.length === 0) continue;
    let idx = text.indexOf(phrase, cursor);
    if (idx === -1) idx = text.indexOf(phrase);
    if (idx === -1) continue;
    const end = idx + phrase.length;
    if (out.some((o) => idx < o.end && end > o.start)) continue;
    out.push({ phrase, start: idx, end, level: m.level, reason: m.reason });
    cursor = end;
  }
  return out.sort((a, b) => a.start - b.start);
}

export class Preprocessor {
  constructor(
    private readonly model: LanguageModelClient | null,
    private readonly config: PreprocessorConfig,
    private readonly obs: Observability,
  ) {}

  get aiEnabled(): boolean {
    return this.config.enabled && this.model !== null;
  }

  async process(raw: string, options: PreprocessOptions): Promise<PreprocessResult> {
    const t0 = performance.now();
    const rules = applyRules(raw, options.language);
    const useAi = this.aiEnabled && options.skipAi !== true && rules.text.length >= LIMITS.minCharsForAi && rules.text.length <= LIMITS.maxCharsForAi;
    if (!useAi) {
      return { ...rules, source: "rules", latencyMs: Math.round(performance.now() - t0) };
    }
    const model = this.model;
    if (model === null) {
      return { ...rules, source: "rules", latencyMs: Math.round(performance.now() - t0) };
    }
    try {
      const payload = await this.obs.span("preprocess.gemini", { language: options.language, chars: rules.text.length }, (setAttr) =>
        withRetry(
          async (attempt) => {
            setAttr("attempt", attempt);
            const result = await withTimeout(
              (signal) =>
                model.generateJson({
                  systemInstruction: systemInstruction(options.language),
                  prompt: options.domain ? `Domain: ${options.domain}\n\nText:\n${rules.text}` : `Text:\n${rules.text}`,
                  schema: RESPONSE_SCHEMA,
                  signal,
                }),
              this.config.timeoutMs,
              "gemini",
            );
            setAttr("prompt_tokens", result.promptTokens);
            setAttr("output_tokens", result.outputTokens);
            return this.parse(result.text, rules.text, options.language);
          },
          {
            maxRetries: this.config.maxRetries,
            baseDelayMs: 400,
            maxDelayMs: 4000,
            onRetry: (error, attempt, delayMs) => {
              this.obs.warn("gemini retry", { attempt, delay_ms: delayMs, reason: error instanceof Error ? error.message : String(error) });
            },
          },
        ),
      );
      return this.merge(payload, rules, options.language, t0);
    } catch (error) {
      this.obs.warn("gemini pre-processing failed; using rule layer", { language: options.language, reason: error instanceof Error ? error.message : String(error) });
      this.obs.increment("preprocess.fallback.rules");
      return { ...rules, source: "rules", latencyMs: Math.round(performance.now() - t0) };
    }
  }

  /** Validate the model output structurally and semantically. Throws on drift. */
  private parse(json: string, original: string, language: LanguageCode): ModelPayload {
    const parsed = responseSchema.parse(JSON.parse(json));
    const cleaned = normaliseText(parsed.text);
    const ratio = cleaned.length / Math.max(1, original.length);
    if (ratio < 0.6 || ratio > 1.8) throw new DriftError(`length ratio ${ratio.toFixed(2)} outside [0.6, 1.8]`);
    const script = detectScript(cleaned);
    if (script !== null && script !== language && LANGUAGES[language].scriptRange.test(original)) {
      throw new DriftError(`script changed from ${language} to ${script}`);
    }
    return { ...parsed, text: cleaned };
  }

  private merge(payload: ModelPayload, rules: Omit<PreprocessResult, "latencyMs" | "source">, language: LanguageCode, t0: number): PreprocessResult {
    const homographs: HomographResolution[] = payload.homographs.filter((h) => h.surface !== h.reading && payload.text.includes(h.surface));
    const annotations = payload.phoneticAnnotations.filter((a) => a.term !== a.spokenForm && payload.text.includes(a.term));
    return {
      text: payload.text,
      language,
      context: payload.context.trim().length > 0 ? payload.context.trim() : rules.context,
      mood: payload.mood,
      emphasis: locateEmphasis(payload.text, payload.emphasis),
      homographs,
      phoneticAnnotations: annotations,
      source: "gemini",
      latencyMs: Math.round(performance.now() - t0),
    };
  }
}

export class DriftError extends Error {
  constructor(message: string) {
    super(`model output drifted from the source: ${message}`);
    this.name = "DriftError";
  }
}
