import { describe, expect, it } from "vitest";
import { VOICE_CATALOGUE } from "../src/config/constants.js";
import { VoiceSelector } from "../src/services/voiceSelector.js";
import { buildSsml, ssmlToPlainText } from "../src/utils/ssml.js";
import type { ProsodySettings, VoiceProfile } from "../src/types/index.js";

function voice(id: string): VoiceProfile {
  const found = VOICE_CATALOGUE.find((v) => v.id === id);
  if (!found) throw new Error(`voice ${id} missing from catalogue`);
  return found;
}
const jenny = voice("en-US-JennyNeural");
const hila = voice("he-IL-HilaNeural");
const prosody: ProsodySettings = { rate: 0.9, pitchSemitones: 0.5, sentencePauseMs: 400, paragraphPauseMs: 800, style: "friendly" };

describe("buildSsml", () => {
  it("emits Azure express-as only when the voice supports the style", () => {
    const withStyle = buildSsml({ text: "Hello <world> & \"friends\"", emphasis: [], ipa: new Map(), boundary: "sentence" }, jenny, prosody, "azure");
    expect(withStyle).toContain('<mstts:express-as style="friendly" styledegree="1">');
    expect(withStyle).toContain('<prosody rate="-10%" pitch="+0.5st">');
    expect(withStyle).toContain("Hello &lt;world&gt; &amp; &quot;friends&quot;");
    expect(withStyle).toContain('<break time="400ms"/>');
    expect(withStyle.startsWith('<speak version="1.0"')).toBe(true);

    const noStyle = buildSsml({ text: "שלום", emphasis: [], ipa: new Map(), boundary: "paragraph" }, hila, prosody, "azure");
    expect(noStyle).not.toContain("express-as");
    expect(noStyle).toContain('<voice name="he-IL-HilaNeural">');
    expect(noStyle).toContain('<break time="800ms"/>');
  });

  it("produces plain SSML 1.1 for Google and a minimal document for devices", () => {
    const google = buildSsml({ text: "Stop here.", emphasis: [{ phrase: "Stop", start: 0, end: 4, level: "strong", reason: "" }], ipa: new Map(), boundary: "end" }, jenny, prosody, "google");
    expect(google).toBe('<speak><prosody rate="-10%" pitch="+0.5st"><emphasis level="strong">Stop</emphasis> here.</prosody></speak>');
    const device = buildSsml({ text: "Stop here.", emphasis: [{ phrase: "Stop", start: 0, end: 4, level: "strong", reason: "" }], ipa: new Map(), boundary: "sentence" }, jenny, prosody, "device");
    expect(device).toBe('<speak xml:lang="en-US">Stop here.<break time="400ms"/></speak>');
    expect(ssmlToPlainText(device)).toBe("Stop here.");
  });

  it("wraps IPA overrides in phoneme tags and skips overlapping emphasis", () => {
    const ssml = buildSsml(
      {
        text: "dyslexia and dyslexia again",
        emphasis: [
          { phrase: "dyslexia", start: 0, end: 8, level: "moderate", reason: "" },
          { phrase: "and", start: 4, end: 12, level: "moderate", reason: "overlap" },
        ],
        ipa: new Map([["dyslexia", "dɪsˈlɛksiə"]]),
        boundary: "end",
      },
      jenny,
      { ...prosody, style: null },
      "google",
    );
    expect(ssml.match(/<phoneme/g)?.length).toBe(2);
    expect(ssml.match(/<emphasis/g)?.length).toBe(1);
  });
});

describe("VoiceSelector", () => {
  it("puts gender before provider availability, and availability before rank", () => {
    const googleOnly = new VoiceSelector(new Set(["google"]), ["azure", "google"]);
    const selection = googleOnly.select({ language: "he", gender: "female", cadence: "natural", mood: "neutral" });
    expect(selection.primary.id).toBe("he-IL-Wavenet-A");
    expect(googleOnly.usable(selection).map((v) => v.id)).toEqual(["he-IL-Wavenet-A", "he-IL-Wavenet-C", "he-IL-Wavenet-B"]);
    expect(selection.fallbacks.slice(0, 2).every((v) => v.gender === "female")).toBe(true);

    const both = new VoiceSelector(new Set(["azure", "google"]), ["google", "azure"]);
    expect(both.select({ language: "en", gender: "female", cadence: "natural", mood: "neutral" }).primary.id).toBe("en-US-Neural2-F");
    expect(both.select({ language: "ar", gender: "male", cadence: "natural", mood: "neutral" }).primary.id).toBe("ar-XA-Wavenet-B");
  });

  it("honours an explicit voice id and derives prosody from cadence and mood", () => {
    const selector = new VoiceSelector(new Set(["azure", "google"]), ["azure", "google"]);
    const selection = selector.select({ language: "en", gender: "female", cadence: "slow", mood: "cheerful", preferredVoiceId: "en-US-GuyNeural" });
    expect(selection.primary.id).toBe("en-US-GuyNeural");
    expect(selection.prosody.style).toBe("cheerful");
    expect(selection.prosody.rate).toBeCloseTo(0.82, 2);
    expect(selection.prosody.pitchSemitones).toBe(1.5);
    expect(selection.deviceHint.pitch).toBeCloseTo(1.13, 2);
    expect(selection.deviceHint.locale).toBe("en-US");
  });

  it("selects a primary even when no provider is configured, so the device hint is still correct", () => {
    const none = new VoiceSelector(new Set(), ["azure", "google"]);
    const selection = none.select({ language: "ru", gender: "female", cadence: "relaxed", mood: "warm" });
    expect(selection.primary.id).toBe("ru-RU-SvetlanaNeural");
    expect(none.usable(selection)).toEqual([]);
    expect(selection.deviceHint.preferredNames[0]).toContain("Svetlana");
  });
});
