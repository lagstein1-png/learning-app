/**
 * Global pronunciation overrides shipped with the service. They bootstrap the
 * in-memory store and are mirrored in `supabase/migrations/0001_init.sql`.
 * Terms are matched after `normaliseText`, so Hebrew gershayim (״) is written
 * as an ASCII double quote here.
 */
import type { PhoneticOverrideInput } from "../types/index.js";

export const SEED_OVERRIDES: readonly PhoneticOverrideInput[] = [
  // ── Hebrew: driving theory, units, common acronyms ───────────────────
  { language: "he", term: 'קמ"ש', spokenForm: "קילומטר לשעה", domain: "driving-theory" },
  { language: "he", term: 'ק"מ', spokenForm: "קילומטר", domain: "units" },
  { language: "he", term: 'ס"מ', spokenForm: "סנטימטר", domain: "units" },
  { language: "he", term: 'מ"ר', spokenForm: "מטר רבוע", domain: "units" },
  { language: "he", term: 'ק"ג', spokenForm: "קילוגרם", domain: "units" },
  { language: "he", term: 'ד"ר', spokenForm: "דוקטור", domain: "general" },
  { language: "he", term: 'בע"מ', spokenForm: "בערבון מוגבל", domain: "general" },
  { language: "he", term: 'ת"א', spokenForm: "תל אביב", domain: "general" },
  { language: "he", term: "ADHD", spokenForm: "איי די אייץ' די", domain: "accessibility" },
  { language: "he", term: "GPS", spokenForm: "ג'י פי אס", domain: "driving-theory" },
  { language: "he", term: "ABS", spokenForm: "איי בי אס", domain: "driving-theory" },
  { language: "he", term: 'רמ"ז', spokenForm: "רמזור", domain: "driving-theory" },
  // ── Arabic ────────────────────────────────────────────────────────────
  { language: "ar", term: "كم/س", spokenForm: "كيلومتر في الساعة", domain: "driving-theory" },
  { language: "ar", term: "كم", spokenForm: "كيلومتر", domain: "units" },
  { language: "ar", term: "د.", spokenForm: "دكتور", domain: "general" },
  { language: "ar", term: "إلخ", spokenForm: "إلى آخره", domain: "general" },
  { language: "ar", term: "ص.ب", spokenForm: "صندوق بريد", domain: "general" },
  { language: "ar", term: "GPS", spokenForm: "جي بي إس", domain: "driving-theory" },
  { language: "ar", term: "ADHD", spokenForm: "إيه دي إتش دي", domain: "accessibility" },
  // ── Russian ───────────────────────────────────────────────────────────
  { language: "ru", term: "км/ч", spokenForm: "километров в час", domain: "driving-theory" },
  { language: "ru", term: "км", spokenForm: "километров", domain: "units" },
  { language: "ru", term: "т.е.", spokenForm: "то есть", domain: "general" },
  { language: "ru", term: "т.д.", spokenForm: "так далее", domain: "general" },
  { language: "ru", term: "ПДД", spokenForm: "правила дорожного движения", domain: "driving-theory" },
  { language: "ru", term: "ГИБДД", spokenForm: "ги-бэ-дэ-дэ", domain: "driving-theory" },
  { language: "ru", term: "GPS", spokenForm: "джи-пи-эс", domain: "driving-theory" },
  { language: "ru", term: "СДВГ", spokenForm: "синдром дефицита внимания и гиперактивности", domain: "accessibility" },
  // ── English ───────────────────────────────────────────────────────────
  { language: "en", term: "km/h", spokenForm: "kilometres per hour", domain: "driving-theory" },
  { language: "en", term: "e.g.", spokenForm: "for example", domain: "general" },
  { language: "en", term: "i.e.", spokenForm: "that is", domain: "general" },
  { language: "en", term: "etc.", spokenForm: "et cetera", domain: "general" },
  { language: "en", term: "ADHD", spokenForm: "A D H D", domain: "accessibility" },
  { language: "en", term: "GPS", spokenForm: "G P S", domain: "driving-theory" },
  { language: "en", term: "ABS", spokenForm: "A B S", domain: "driving-theory" },
  { language: "en", term: "SSML", spokenForm: "S S M L", domain: "general" },
  { language: "en", term: "dyslexia", spokenForm: "dyslexia", ipa: "dɪsˈlɛksiə", domain: "accessibility" },
];
