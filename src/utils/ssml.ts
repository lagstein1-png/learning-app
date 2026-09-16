/**
 * SSML generation for the two cloud providers and for on-device fallback.
 *
 * Azure understands `<mstts:express-as>` styles and `<prosody>`; Google
 * understands standard SSML 1.1 (`<prosody>`, `<emphasis>`, `<break>`,
 * `<phoneme>`); on-device engines mostly ignore markup, so the device variant
 * keeps only `<break>` and plain text.
 */
import type { EmphasisMarker, ProsodySettings, VoiceProfile } from "../types/index.js";
import { escapeXml } from "./text.js";

export type SsmlDialect = "azure" | "google" | "device";

export interface SsmlChunkInput {
  readonly text: string;
  /** Emphasis markers with offsets relative to `text`. */
  readonly emphasis: readonly EmphasisMarker[];
  /** IPA overrides keyed by the exact spoken form that appears in `text`. */
  readonly ipa: ReadonlyMap<string, string>;
  readonly boundary: "sentence" | "paragraph" | "end";
}

function ratePercent(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function pitchSt(semitones: number): string {
  const v = Math.round(semitones * 10) / 10;
  return `${v >= 0 ? "+" : ""}${v}st`;
}

/** Wrap segments of `text` with `<emphasis>` and `<phoneme>` where requested. */
function annotate(text: string, emphasis: readonly EmphasisMarker[], ipa: ReadonlyMap<string, string>, dialect: SsmlDialect): string {
  if (dialect === "device") return escapeXml(text);
  const sorted = [...emphasis]
    .filter((m) => m.start >= 0 && m.end <= text.length && m.end > m.start)
    .sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cursor = 0;
  const emit = (segment: string): void => {
    out.push(applyIpa(segment, ipa));
  };
  for (const m of sorted) {
    if (m.start < cursor) continue;
    emit(text.slice(cursor, m.start));
    out.push(`<emphasis level="${m.level}">`);
    emit(text.slice(m.start, m.end));
    out.push("</emphasis>");
    cursor = m.end;
  }
  emit(text.slice(cursor));
  return out.join("");
}

function applyIpa(segment: string, ipa: ReadonlyMap<string, string>): string {
  if (ipa.size === 0) return escapeXml(segment);
  let result = "";
  let rest = segment;
  while (rest.length > 0) {
    let bestIndex = -1;
    let bestTerm = "";
    for (const term of ipa.keys()) {
      const idx = rest.indexOf(term);
      if (idx !== -1 && (bestIndex === -1 || idx < bestIndex || (idx === bestIndex && term.length > bestTerm.length))) {
        bestIndex = idx;
        bestTerm = term;
      }
    }
    if (bestIndex === -1) {
      result += escapeXml(rest);
      break;
    }
    result += escapeXml(rest.slice(0, bestIndex));
    const symbols = ipa.get(bestTerm) ?? "";
    result += `<phoneme alphabet="ipa" ph="${escapeXml(symbols)}">${escapeXml(bestTerm)}</phoneme>`;
    rest = rest.slice(bestIndex + bestTerm.length);
  }
  return result;
}

/** Build a complete `<speak>` document for one chunk. */
export function buildSsml(input: SsmlChunkInput, voice: VoiceProfile, prosody: ProsodySettings, dialect: SsmlDialect): string {
  const body = annotate(input.text, input.emphasis, input.ipa, dialect);
  const pauseMs = input.boundary === "paragraph" ? prosody.paragraphPauseMs : input.boundary === "sentence" ? prosody.sentencePauseMs : 0;
  const trailingBreak = pauseMs > 0 ? `<break time="${pauseMs}ms"/>` : "";

  if (dialect === "device") {
    return `<speak xml:lang="${voice.locale}">${body}${trailingBreak}</speak>`;
  }

  const prosodyOpen = `<prosody rate="${ratePercent(prosody.rate)}" pitch="${pitchSt(prosody.pitchSemitones)}">`;
  const prosodyClose = "</prosody>";

  if (dialect === "azure") {
    const useStyle = prosody.style !== null && voice.styles.includes(prosody.style);
    const styleOpen = useStyle ? `<mstts:express-as style="${prosody.style ?? ""}" styledegree="1">` : "";
    const styleClose = useStyle ? "</mstts:express-as>" : "";
    return (
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${voice.locale}">` +
      `<voice name="${voice.id}">${styleOpen}${prosodyOpen}${body}${trailingBreak}${prosodyClose}${styleClose}</voice></speak>`
    );
  }

  return `<speak>${prosodyOpen}${body}${trailingBreak}${prosodyClose}</speak>`;
}

/** Plain-text fallback with sentence pauses rendered as punctuation the device engine honours. */
export function ssmlToPlainText(ssml: string): string {
  return ssml
    .replace(/<break[^>]*\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
