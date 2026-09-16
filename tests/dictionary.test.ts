import { describe, expect, it } from "vitest";
import { SEED_OVERRIDES } from "../src/config/seedDictionary.js";
import { DictionaryService, MemoryDictionaryStore } from "../src/services/dictionary.js";
import { testObservability } from "./helpers/mocks.js";
import type { PhoneticOverride } from "../src/types/index.js";

function override(partial: Partial<PhoneticOverride> & Pick<PhoneticOverride, "language" | "term" | "spokenForm">): PhoneticOverride {
  return { id: `id-${partial.term}`, ipa: null, userId: null, domain: null, createdAt: "", updatedAt: "", ...partial };
}

describe("DictionaryService.apply", () => {
  const service = new DictionaryService(new MemoryDictionaryStore(), testObservability());

  it("replaces on word boundaries only and reports occurrences", () => {
    const result = service.apply("GPS works. GPSX is not GPS. gps too.", "en", [override({ language: "en", term: "GPS", spokenForm: "G P S" })]);
    expect(result.text).toBe("G P S works. GPSX is not G P S. G P S too.");
    expect(result.applied).toEqual([{ term: "GPS", spokenForm: "G P S", occurrences: 3, scope: "global" }]);
  });

  it("keeps Hebrew clitic prefixes in front of the spoken form", () => {
    const result = service.apply('נסענו 50 קמ"ש והתמרור אמר לעצור', "he", [
      override({ language: "he", term: 'קמ"ש', spokenForm: "קילומטר לשעה" }),
      override({ language: "he", term: "תמרור", spokenForm: "תַּמְרוּר" }),
    ]);
    expect(result.text).toBe("נסענו 50 קילומטר לשעה והתַּמְרוּר אמר לעצור");
  });

  it("applies longer terms before shorter ones so nothing is partially eaten", () => {
    const result = service.apply('ק"מ ואז קמ"ש', "he", [
      override({ language: "he", term: 'ק"מ', spokenForm: "קילומטר" }),
      override({ language: "he", term: 'קמ"ש', spokenForm: "קילומטר לשעה" }),
    ]);
    expect(result.text).toBe("קילומטר ואז קילומטר לשעה");
  });

  it("lets a learner override beat a global one, and both beat an AI annotation", () => {
    const overrides = [
      override({ language: "en", term: "ADHD", spokenForm: "A D H D" }),
      override({ language: "en", term: "ADHD", spokenForm: "attention deficit", userId: "u1", id: "user-row" }),
    ];
    const result = service.apply("ADHD and PWA", "en", overrides, [
      { term: "ADHD", spokenForm: "ay-dee-aitch-dee" },
      { term: "PWA", spokenForm: "P W A" },
    ]);
    expect(result.text).toBe("attention deficit and P W A");
    expect(result.applied.find((a) => a.term === "ADHD")?.scope).toBe("user");
  });

  it("collects IPA for spoken forms that carry one", () => {
    const result = service.apply("dyslexia is common", "en", [override({ language: "en", term: "dyslexia", spokenForm: "dyslexia", ipa: "dɪsˈlɛksiə" })]);
    expect(result.ipa.get("dyslexia")).toBe("dɪsˈlɛksiə");
  });

  it("ignores annotations whose spoken form equals the term", () => {
    const result = service.apply("plain text", "en", [], [{ term: "plain", spokenForm: "plain" }]);
    expect(result.applied).toEqual([]);
    expect(result.text).toBe("plain text");
  });

  it("handles regex metacharacters in terms", () => {
    const result = service.apply("Speed: 30 km/h (max).", "en", [override({ language: "en", term: "km/h", spokenForm: "kilometres per hour" })]);
    expect(result.text).toBe("Speed: 30 kilometres per hour (max).");
  });
});

describe("MemoryDictionaryStore", () => {
  it("seeds global rows for all four languages", async () => {
    const store = new MemoryDictionaryStore(SEED_OVERRIDES);
    expect(store.size).toBe(SEED_OVERRIDES.length);
    for (const language of ["he", "en", "ar", "ru"] as const) {
      const rows = await store.list(language, null);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.language === language && r.userId === null)).toBe(true);
    }
  });

  it("scopes learner rows and reports created vs updated", async () => {
    const store = new MemoryDictionaryStore();
    const first = await store.upsert({ language: "ru", term: "ПДД", spokenForm: "правила", userId: "u1" });
    expect(first.created).toBe(true);
    const second = await store.upsert({ language: "ru", term: "пдд", spokenForm: "правила дорожного движения", userId: "u1" });
    expect(second.created).toBe(false);
    expect(second.override.id).toBe(first.override.id);
    expect(second.override.spokenForm).toBe("правила дорожного движения");
    expect(await store.list("ru", "u1")).toHaveLength(1);
    expect(await store.list("ru", "someone-else")).toHaveLength(0);
    expect(await store.list("ru", null)).toHaveLength(0);
    expect(await store.remove(first.override.id)).toBe(true);
    expect(await store.remove(first.override.id)).toBe(false);
  });
});

describe("DictionaryService cache", () => {
  it("caches lookups until invalidated by an upsert", async () => {
    const store = new MemoryDictionaryStore();
    const service = new DictionaryService(store, testObservability(), 60_000);
    expect(await service.resolve("en", null)).toHaveLength(0);
    await store.upsert({ language: "en", term: "X", spokenForm: "ex" });
    expect(await service.resolve("en", null)).toHaveLength(0);
    await service.upsert({ language: "en", term: "Y", spokenForm: "why" });
    expect(await service.resolve("en", null)).toHaveLength(2);
  });
});
