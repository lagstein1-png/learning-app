/**
 * Dynamic voice selector.
 *
 * Ordering rule, deliberately a sort and not a score: gender preference is
 * the first key, then provider availability in the configured order, then
 * catalogue rank. A learner who chose a female voice must never receive a
 * male one merely because it scored higher on quality, and a voice from an
 * unconfigured provider is never selected as primary.
 */
import { CADENCE_PRESETS, DEVICE_VOICE_NAMES, LANGUAGES, MOOD_PRESETS, VOICE_CATALOGUE } from "../config/constants.js";
import type { CadencePreset, DeviceVoiceHint, LanguageCode, ProsodySettings, ProviderId, SpeechMood, VoiceGender, VoiceProfile, VoiceSelection } from "../types/index.js";

export interface VoiceRequest {
  readonly language: LanguageCode;
  readonly gender: VoiceGender;
  readonly cadence: CadencePreset;
  readonly mood: SpeechMood;
  /** Explicit voice id the learner picked; honoured when it matches the language. */
  readonly preferredVoiceId?: string;
}

export type CloudProvider = Exclude<ProviderId, "device">;

export class VoiceSelector {
  private readonly providerRank: ReadonlyMap<CloudProvider, number>;

  constructor(
    private readonly enabledProviders: ReadonlySet<CloudProvider>,
    providerOrder: readonly CloudProvider[],
    private readonly catalogue: readonly VoiceProfile[] = VOICE_CATALOGUE,
  ) {
    const rank = new Map<CloudProvider, number>();
    providerOrder.forEach((p, i) => rank.set(p, i));
    this.providerRank = rank;
  }

  /** Every catalogue voice for the language, best first for this request. */
  rankVoices(request: VoiceRequest): VoiceProfile[] {
    const voices = this.catalogue.filter((v) => v.language === request.language);
    const availabilityRank = (v: VoiceProfile): number => (this.enabledProviders.has(v.provider) ? (this.providerRank.get(v.provider) ?? 99) : 1000);
    return [...voices].sort((a, b) => {
      if (request.preferredVoiceId !== undefined) {
        if (a.id === request.preferredVoiceId && b.id !== request.preferredVoiceId) return -1;
        if (b.id === request.preferredVoiceId && a.id !== request.preferredVoiceId) return 1;
      }
      const ga = a.gender === request.gender ? 0 : 1;
      const gb = b.gender === request.gender ? 0 : 1;
      if (ga !== gb) return ga - gb;
      const pa = availabilityRank(a);
      const pb = availabilityRank(b);
      if (pa !== pb) return pa - pb;
      if (a.tier !== b.tier) return a.tier === "hd" ? -1 : 1;
      return a.rank - b.rank;
    });
  }

  resolveProsody(voice: VoiceProfile, cadence: CadencePreset, mood: SpeechMood): ProsodySettings {
    const c = CADENCE_PRESETS[cadence];
    const m = MOOD_PRESETS[mood];
    const rate = Math.round(c.rate * m.rateMultiplier * 100) / 100;
    return {
      rate,
      pitchSemitones: m.pitchSemitones,
      sentencePauseMs: c.sentencePauseMs,
      paragraphPauseMs: c.paragraphPauseMs,
      style: m.style !== null && voice.styles.includes(m.style) ? m.style : null,
    };
  }

  deviceHint(language: LanguageCode, gender: VoiceGender, prosody: ProsodySettings): DeviceVoiceHint {
    return {
      locale: LANGUAGES[language].locale,
      gender,
      rate: prosody.rate,
      // Web Speech pitch is a 0–2 multiplier where 1 is neutral; one semitone ≈ 1/12 of an octave.
      pitch: Math.round((1 + prosody.pitchSemitones / 12) * 100) / 100,
      preferredNames: DEVICE_VOICE_NAMES[language][gender],
    };
  }

  select(request: VoiceRequest): VoiceSelection {
    const ranked = this.rankVoices(request);
    const primary = ranked[0];
    if (primary === undefined) {
      throw new Error(`no voices in the catalogue for language ${request.language}`);
    }
    const prosody = this.resolveProsody(primary, request.cadence, request.mood);
    return {
      primary,
      fallbacks: ranked.slice(1),
      prosody,
      deviceHint: this.deviceHint(request.language, request.gender, prosody),
    };
  }

  /** Voices whose provider is configured, in selection order. */
  usable(selection: VoiceSelection): VoiceProfile[] {
    return [selection.primary, ...selection.fallbacks].filter((v) => this.enabledProviders.has(v.provider));
  }
}
