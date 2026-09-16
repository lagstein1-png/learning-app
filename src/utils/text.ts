/**
 * Deterministic text utilities shared by the pre-processor, the dictionary
 * and the chunker. All of them are pure: same input, same output, no I/O.
 */
import { LANGUAGES } from "../config/constants.js";
import type { LanguageCode } from "../types/index.js";

/** Zero-width characters and BOM: engines read them as noise or stall on them. */
const NOISE = /[\u200B-\u200D\uFEFF\u2060]/gu;
const EMOJI = /[\p{Extended_Pictographic}\uFE0F]/gu;
const MARKDOWN = /(\*\*|__|~~|`{1,3}|^#{1,6}[ \t]+|^[ \t]*[-*+][ \t]+|^[ \t]*\d+\.[ \t]+)/gmu;
const PUNCT_CLASS = "[,.;:!?\\u061F\\u060C\\u061B]";
const QUOTES: readonly [RegExp, string][] = [
  [/[“”„«»״]/gu, '"'],
  [/[‘’‚‹›׳]/gu, "'"],
  [/\.{3,}|…/gu, "…"],
  [/\s*[‐‑]\s*(?=\S)/gu, "-"],
];

/** Normalise whitespace and punctuation without touching letters or diacritics. */
export function normaliseText(raw: string): string {
  let t = raw.normalize("NFC").replace(/\r\n?/gu, "\n").replace(NOISE, "").replace(EMOJI, "").replace(MARKDOWN, "");
  for (const [re, rep] of QUOTES) t = t.replace(re, rep);
  t = t
    .replace(/[ \t\u00A0]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(new RegExp(` (${PUNCT_CLASS})`, "gu"), "$1")
    .replace(new RegExp(`(${PUNCT_CLASS})(?=[\\p{L}\\p{M}])`, "gu"), "$1 ")
    .replace(/([!?؟]){2,}/gu, "$1")
    .trim();
  return t;
}

/** Detect which of the four scripts dominates. Returns `null` when nothing matches. */
export function detectScript(text: string): LanguageCode | null {
  let best: LanguageCode | null = null;
  let bestCount = 0;
  for (const spec of Object.values(LANGUAGES)) {
    const re = new RegExp(spec.scriptRange.source, "gu");
    const count = (text.match(re) ?? []).length;
    if (count > bestCount) {
      bestCount = count;
      best = spec.code;
    }
  }
  return best;
}

/** Escape the five XML characters so arbitrary text is safe inside SSML. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Escape regex metacharacters in a literal term. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary regex that works for Hebrew, Arabic and Cyrillic, where `\b`
 * misbehaves because those letters are not ASCII word characters. Hebrew
 * clitic prefixes (ו, ב, ל, מ, ה, ש, כ) attached to a term are captured in
 * the `prefix` group so "והתמרור" still maps to the pronunciation of
 * "תמרור" with the prefix kept in front of it.
 */
export function termPattern(term: string, language: LanguageCode): RegExp {
  const core = escapeRegex(term);
  const hebrewPrefix = language === "he" ? "(?<prefix>[ובלמהשכ]{0,2})" : "(?<prefix>)";
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${hebrewPrefix}${core}(?![\\p{L}\\p{N}\\p{M}])`, "giu");
}

/** Rough spoken-duration estimate in milliseconds. */
export function estimateDurationMs(text: string, language: LanguageCode, rate: number): number {
  const spec = LANGUAGES[language];
  const chars = text.replace(/\s+/gu, " ").length;
  return Math.round((chars / spec.charsPerSecond / Math.max(0.5, rate)) * 1000);
}
