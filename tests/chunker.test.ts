import { describe, expect, it } from "vitest";
import { chunkText, clampChunkChars, splitSentences } from "../src/services/chunker.js";
import type { ChunkPlan } from "../src/types/index.js";
import { normaliseText } from "../src/utils/text.js";
import type { LanguageCode } from "../src/types/index.js";

const keyFor = (text: string, boundary: string): string => `${boundary}:${text.length}`;

function plan(text: string, language: LanguageCode, maxChars: number): ChunkPlan {
  return chunkText(text, { language, maxChars, rate: 1, cacheKeyFor: keyFor });
}

describe("chunker", () => {
  it("splits Arabic on the Arabic question mark and Hebrew on sof pasuq", () => {
    const ar = splitSentences({ text: "هل هذا صحيح؟ نعم. تابع القراءة!", start: 0, end: 31 }, "ar");
    expect(ar.map((s) => s.text)).toEqual(["هل هذا صحيح؟", "نعم.", "تابع القراءة!"]);
    const he = splitSentences({ text: "בראשית ברא׃ והארץ היתה תהו. סוף", start: 0, end: 30 }, "he");
    expect(he.map((s) => s.text)).toEqual(["בראשית ברא׃", "והארץ היתה תהו.", "סוף"]);
  });

  it("does not split on a decimal point or an abbreviation without a following space", () => {
    const en = splitSentences({ text: "It costs 3.5 dollars. Fine.", start: 0, end: 27 }, "en");
    expect(en.map((s) => s.text)).toEqual(["It costs 3.5 dollars.", "Fine."]);
  });

  it("packs sentences up to the limit and keeps offsets exact", () => {
    const text = "One two three four. Five six seven eight. Nine ten eleven twelve. Thirteen fourteen fifteen.";
    const result = plan(text, "en", 80);
    expect(result.maxChunkChars).toBe(80);
    expect(result.chunks.length).toBe(2);
    for (const c of result.chunks) {
      expect(c.text.length).toBeLessThanOrEqual(80);
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
    expect(result.chunks[0]?.boundary).toBe("sentence");
    expect(result.chunks[1]?.boundary).toBe("end");
  });

  it("marks paragraph boundaries and reports a positive total duration", () => {
    const text = "First paragraph sentence one. Sentence two.\n\nSecond paragraph.";
    const result = plan(text, "en", 600);
    expect(result.chunks.map((c) => c.boundary)).toEqual(["paragraph", "end"]);
    expect(result.chunks[1]?.text).toBe("Second paragraph.");
    expect(result.totalEstimatedDurationMs).toBeGreaterThan(0);
    expect(result.chunks.map((c) => c.cacheKey)).toEqual(["paragraph:43", "end:17"]);
  });

  it("breaks an over-long sentence at a clause separator, then at whitespace", () => {
    const clause = "אחרי הצומת, כשהאור מתחלף, ממשיכים ישר, ואז פונים ימינה, ואחר כך שמאלה, ועוצרים ליד התמרור הגדול שנמצא בקצה הרחוב הארוך מאוד.";
    const result = plan(clause, "he", 80);
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const c of result.chunks) {
      expect(c.text.length).toBeLessThanOrEqual(80);
      expect(clause.slice(c.start, c.end)).toBe(c.text);
    }
    expect(result.chunks[0]?.text.endsWith(",")).toBe(true);

    const noPunct = "слово ".repeat(40).trim();
    const words = plan(noPunct, "ru", 80);
    expect(words.chunks.length).toBeGreaterThan(2);
    for (const c of words.chunks) {
      expect(c.text.length).toBeLessThanOrEqual(80);
      expect(c.text.startsWith(" ")).toBe(false);
      expect(c.text.endsWith(" ")).toBe(false);
    }
  });

  it("clamps requested chunk sizes into the supported range", () => {
    expect(clampChunkChars(undefined)).toBe(320);
    expect(clampChunkChars(10)).toBe(80);
    expect(clampChunkChars(5000)).toBe(600);
    expect(clampChunkChars(250.7)).toBe(250);
  });

  it("estimates slower cadence as longer duration", () => {
    const text = "A sentence that takes some time to say out loud.";
    const fast = chunkText(text, { language: "en", maxChars: 320, rate: 1.1, cacheKeyFor: keyFor });
    const slow = chunkText(text, { language: "en", maxChars: 320, rate: 0.8, cacheKeyFor: keyFor });
    expect(slow.totalEstimatedDurationMs).toBeGreaterThan(fast.totalEstimatedDurationMs);
  });
});

describe("normaliseText", () => {
  it("removes markup, zero-width characters and emoji, and tidies punctuation spacing", () => {
    const raw = "## כותרת\n\n**חשוב** :  לעצור ​בצומת!!!  🎉\r\n\r\n\r\n- פריט";
    expect(normaliseText(raw)).toBe("כותרת\n\nחשוב: לעצור בצומת!\n\nפריט");
  });

  it("maps Hebrew gershayim and geresh to ASCII quotes so dictionary terms match", () => {
    expect(normaliseText("50 קמ״ש, ג׳ינס")).toBe('50 קמ"ש, ג\'ינס');
  });

  it("keeps Arabic and Hebrew diacritics intact", () => {
    const pointed = "שָׁלוֹם عَلَيْكُم";
    expect(normaliseText(pointed)).toBe(pointed);
  });
});
