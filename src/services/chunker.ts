/**
 * Smart audio chunking.
 *
 * Long text is cut into conversational segments that end on a sentence, or
 * failing that on a clause, so every chunk sounds like a complete thought
 * and no single provider call can time out. Each chunk carries its offsets
 * into the source text (for word highlighting on the client), an estimated
 * duration (so the client can pace playback) and a cache key.
 */
import { LANGUAGES, LIMITS } from "../config/constants.js";
import type { ChunkPlan, LanguageCode, SpeechChunk } from "../types/index.js";
import { escapeRegex, estimateDurationMs } from "../utils/text.js";

export interface ChunkOptions {
  readonly language: LanguageCode;
  readonly maxChars: number;
  readonly rate: number;
  /** Cache key for a chunk's text; injected so the key can include voice and prosody. */
  readonly cacheKeyFor: (chunkText: string, boundary: SpeechChunk["boundary"]) => string;
}

interface Segment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Clamp a requested chunk size into the supported range. */
export function clampChunkChars(requested: number | undefined): number {
  const v = requested ?? LIMITS.defaultChunkChars;
  return Math.min(LIMITS.maxChunkChars, Math.max(LIMITS.minChunkChars, Math.floor(v)));
}

function splitParagraphs(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/gu;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const trimmedStart = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body.length === 0) continue;
    const start = (m.index ?? 0) + trimmedStart;
    out.push({ text: body, start, end: start + body.length });
  }
  return out;
}

/**
 * Sentence split: a run of the language's terminators (optionally followed by
 * closing quotes or brackets) ends a sentence only when whitespace or the end
 * of the paragraph follows, so "3.5" and "ד\"ר" never split.
 */
export function splitSentences(paragraph: Segment, language: LanguageCode): Segment[] {
  const terms = LANGUAGES[language].sentenceTerminators.map(escapeRegex).join("");
  const boundary = new RegExp(`[${terms}]+["')\\]\\u00BB]*(?=\\s|$)`, "gu");
  const out: Segment[] = [];
  const text = paragraph.text;
  let last = 0;
  const pushTrimmed = (from: number, to: number): void => {
    const seg = trimSegment(text, paragraph.start, from, to);
    if (seg.text.length > 0) out.push(seg);
  };
  for (const m of text.matchAll(boundary)) {
    const end = (m.index ?? 0) + m[0].length;
    pushTrimmed(last, end);
    last = end;
  }
  if (last < text.length) pushTrimmed(last, text.length);
  return out.length > 0 ? out : [paragraph];
}

/** Break one over-long sentence at clause separators, then at whitespace. */
function splitLong(segment: Segment, language: LanguageCode, maxChars: number): Segment[] {
  if (segment.text.length <= maxChars) return [segment];
  const seps = LANGUAGES[language].clauseSeparators;
  const pieces: Segment[] = [];
  let cursor = 0;
  const text = segment.text;
  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChars) {
      pieces.push(trimSegment(text, segment.start, cursor, text.length));
      break;
    }
    const windowEnd = cursor + maxChars;
    let cut = -1;
    for (const sep of seps) {
      const idx = text.lastIndexOf(sep, windowEnd - 1);
      if (idx > cursor + Math.floor(maxChars / 3) && idx + sep.length > cut) cut = idx + sep.length;
    }
    if (cut === -1) {
      const space = text.lastIndexOf(" ", windowEnd);
      cut = space > cursor + Math.floor(maxChars / 4) ? space : windowEnd;
    }
    pieces.push(trimSegment(text, segment.start, cursor, cut));
    cursor = cut;
  }
  return pieces.filter((p) => p.text.length > 0);
}

function trimSegment(text: string, base: number, from: number, to: number): Segment {
  const raw = text.slice(from, to);
  const lead = raw.length - raw.trimStart().length;
  const body = raw.trim();
  return { text: body, start: base + from + lead, end: base + from + lead + body.length };
}

/** Build the chunk plan for `text`. */
export function chunkText(text: string, options: ChunkOptions): ChunkPlan {
  const maxChars = clampChunkChars(options.maxChars);
  const paragraphs = splitParagraphs(text);
  const chunks: SpeechChunk[] = [];

  const push = (seg: Segment, boundary: SpeechChunk["boundary"]): void => {
    chunks.push({
      index: chunks.length,
      text: seg.text,
      start: seg.start,
      end: seg.end,
      boundary,
      estimatedDurationMs: estimateDurationMs(seg.text, options.language, options.rate),
      cacheKey: options.cacheKeyFor(seg.text, boundary),
    });
  };

  for (const paragraph of paragraphs) {
    const sentences = splitSentences(paragraph, options.language).flatMap((s) => splitLong(s, options.language, maxChars));
    let current: Segment | null = null;
    for (const sentence of sentences) {
      if (current === null) {
        current = sentence;
        continue;
      }
      const joined = text.slice(current.start, sentence.end);
      if (joined.length <= maxChars) {
        current = { text: joined, start: current.start, end: sentence.end };
      } else {
        push(current, "sentence");
        current = sentence;
      }
    }
    if (current !== null) push(current, "paragraph");
  }

  if (chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined) {
      chunks[chunks.length - 1] = { ...last, boundary: "end", cacheKey: options.cacheKeyFor(last.text, "end") };
    }
  }

  return {
    chunks,
    totalEstimatedDurationMs: chunks.reduce((sum, c) => sum + c.estimatedDurationMs, 0),
    maxChunkChars: maxChars,
  };
}
