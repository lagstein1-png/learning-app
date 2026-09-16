/**
 * LAYER B — Multilingual pronunciation guardrails (the trust layer).
 *
 * Deterministic middleware that runs on every module before it reaches the
 * client or a TTS engine. It never calls a model. It produces:
 *
 *   display text   — short paragraphs, normalised punctuation, no markdown
 *   TTS text       — abbreviations spelled out, symbols read as words,
 *                    identifiers spelled digit-by-digit, Hebrew nikud on
 *                    ambiguous words, Arabic tashkeel on ambiguous words,
 *                    breathing pauses as SSML-lite <break/> tags
 *   verification   — the language_code is checked against the script of the
 *                    text and corrected if the model got it wrong
 *
 * Every replacement is recorded in `hits`, so a reviewer can see exactly what
 * the layer changed and why.
 */
import {
  LANGUAGE_CODES,
  VOICE_PREFERENCES,
  type LanguageCode,
  type Layout,
  type VoicePreference,
} from "./schemas.ts";

export interface GuardrailHit {
  rule: string;
  from: string;
  to: string;
}

export interface GuardrailInput {
  raw_text: string;
  options?: string[];
  language_code: string;
  voice_preference?: string | null;
  layout?: Layout;
  /** Words the TTS must never say (e.g. the answer before it is revealed). */
  forbidden_in_tts?: string[];
}

export interface GuardrailOutput {
  display_text: string;
  tts_ssml: string;
  tts_plain: string;
  options_display: string[];
  options_tts: string[];
  language_code: LanguageCode;
  language_verified: boolean;
  detected_language: LanguageCode | null;
  voice_preference: VoicePreference;
  hits: GuardrailHit[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------

const HEBREW = /[֐-׿]/g;
const ARABIC = /[؀-ۿݐ-ݿ]/g;
const LATIN = /[A-Za-zÀ-ɏ]/g;
const SPANISH_MARKERS = /[ñáéíóúü¿¡]|\b(el|la|los|las|de|que|es|una?|para|por|con)\b/gi;
const ENGLISH_MARKERS = /\b(the|and|is|are|of|to|with|that|this|you|for)\b/gi;

export function detectLanguage(text: string): LanguageCode | null {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const he = count(HEBREW);
  const ar = count(ARABIC);
  const la = count(LATIN);
  const total = he + ar + la;
  if (total < 3) return null;
  if (he / total > 0.4 && he >= ar) return "he-IL";
  if (ar / total > 0.4) return "ar-XA";
  if (la / total > 0.6) {
    const es = count(SPANISH_MARKERS);
    const en = count(ENGLISH_MARKERS);
    return es > en ? "es-ES" : "en-US";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Rule = { rule: string; re: RegExp; to: string | ((...m: string[]) => string) };

function applyRules(text: string, rules: Rule[], hits: GuardrailHit[]): string {
  let out = text;
  for (const r of rules) {
    out = out.replace(r.re, (...args: unknown[]) => {
      const m = args as string[];
      const from = m[0] ?? "";
      const to =
        typeof r.to === "string"
          ? r.to.replace(/\$(\d)/g, (_x, n: string) => m[Number(n)] ?? "")
          : r.to(...m);
      if (from !== to) hits.push({ rule: r.rule, from, to });
      return to;
    });
  }
  return out;
}

/** Right-to-left safe "word boundary": a char that is not a letter/digit of any script. */
const NW = "(?<![\\p{L}\\p{N}])";
const NWE = "(?![\\p{L}\\p{N}])";
const bounded = (s: string, flags = "gu") => new RegExp(NW + s + NWE, flags);

const HE_GERSHAYIM = /[״"״]/g; // gershayim / straight quote used as gershayim
const HE_GERESH = /[׳'׳]/g;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, (m) => m.trim() + " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function stripHebrewNikud(s: string): string {
  return s.replace(/[֑-ׇ]/g, "");
}
function stripArabicTashkeel(s: string): string {
  return s.replace(/[ً-ٰٟـ]/g, "");
}

// ---------------------------------------------------------------------------
// Per-language tables
// ---------------------------------------------------------------------------

interface LangPack {
  digits: string[]; // 0..9 as words
  math: { times: string; div: string; plus: string; minus: string; eq: string; neq: string; lt: string; gt: string; le: string; ge: string; sq: string; cube: string; sqrt: string; pct: string; deg: string; and: string; arrow: string };
  range: (a: string, b: string) => string;
  abbreviations: Rule[];
  connectives: string[];
  revealCues: RegExp[];
  optionLabel: (i: number) => string;
  optionsIntro: string;
  decimalComma: boolean;
  identifierCue?: RegExp; // a word after which a number is a label, not a quantity
}

// Hebrew digit names: from תאוריה מדברת tools/number-rules.js (HE_DIGIT).
const HE: LangPack = {
  digits: ["אפס", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע"],
  math: { times: "כפול", div: "חלקי", plus: "ועוד", minus: "פחות", eq: "שווה", neq: "לא שווה", lt: "קטן מ", gt: "גדול מ", le: "קטן או שווה ל", ge: "גדול או שווה ל", sq: "בריבוע", cube: "בשלישית", sqrt: "שורש של", pct: "אחוז", deg: "מעלות", and: "ו", arrow: "ואז" },
  range: (a, b) => `${a} עד ${b}`,
  abbreviations: [
    { rule: "he.abbr", re: bounded('קמ[״"]ש'), to: "קילומטר לשעה" },
    { rule: "he.abbr", re: bounded('ק[״"]מ'), to: "קילומטר" },
    { rule: "he.abbr", re: bounded('ס[״"]מ'), to: "סנטימטר" },
    { rule: "he.abbr", re: bounded('מ[״"]מ'), to: "מילימטר" },
    { rule: "he.abbr", re: bounded('ק[״"]ג'), to: "קילוגרם" },
    { rule: "he.abbr", re: bounded('מ[״"]ר'), to: "מטר רבוע" },
    { rule: "he.abbr", re: bounded('ד[״"]ר'), to: "דוקטור" },
    { rule: "he.abbr", re: bounded('בע[״"]מ'), to: "בערבון מוגבל" },
    { rule: "he.abbr", re: bounded('ת[״"]א'), to: "תל אביב" },
    { rule: "he.abbr", re: bounded('ב[״"]ש'), to: "באר שבע" },
    { rule: "he.abbr", re: bounded('משרד הת[״"]ת'), to: "משרד התחבורה" },
    { rule: "he.abbr", re: bounded("וכו[׳']"), to: "וכולי" },
    { rule: "he.abbr", re: bounded("וכד[׳']"), to: "וכדומה" },
    { rule: "he.abbr", re: bounded("לדוג[׳']"), to: "לדוגמה" },
    { rule: "he.abbr", re: bounded("עמ[׳']"), to: "עמוד" },
    { rule: "he.abbr", re: bounded("מס[׳']"), to: "מספר" },
    { rule: "he.abbr", re: bounded("שנ[׳']"), to: "שנייה" },
    { rule: "he.abbr", re: bounded("דק[׳']"), to: "דקה" },
    { rule: "he.abbr", re: bounded("מ[׳']"), to: "מטר" },
    { rule: "he.abbr", re: bounded("ש[״\"]ח"), to: "שקלים" },
  ],
  connectives: ["אבל", "ולכן", "לכן", "כי", "כאשר", "אם", "או", "וגם", "למשל", "כלומר", "אז"],
  revealCues: [/התשובה( הנכונה)? היא/g, /הפתרון הוא/g, /התוצאה היא/g],
  optionLabel: (i) => ["א", "ב", "ג", "ד", "ה", "ו"][i] ?? String(i + 1),
  optionsIntro: "האפשרויות הן",
  decimalComma: false,
  identifierCue: /(תמרור|שלט|קו|אוטובוס|כביש|סעיף|דף|עמוד|תקנה)\s*(מספר\s*)?$/,
};

const EN: LangPack = {
  digits: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
  math: { times: "times", div: "divided by", plus: "plus", minus: "minus", eq: "equals", neq: "is not equal to", lt: "is less than", gt: "is greater than", le: "is less than or equal to", ge: "is greater than or equal to", sq: "squared", cube: "cubed", sqrt: "the square root of", pct: "percent", deg: "degrees", and: "and", arrow: "then" },
  range: (a, b) => `${a} to ${b}`,
  abbreviations: [
    { rule: "en.abbr", re: /\be\.g\.,?/gi, to: "for example," },
    { rule: "en.abbr", re: /\bi\.e\.,?/gi, to: "that is," },
    { rule: "en.abbr", re: /\betc\.?(?=[\s,.;)]|$)/gi, to: "et cetera" },
    { rule: "en.abbr", re: /\bvs\.?(?=\s)/gi, to: "versus" },
    { rule: "en.abbr", re: /\bapprox\.?(?=\s)/gi, to: "approximately" },
    { rule: "en.abbr", re: /\bkm\/h\b/gi, to: "kilometres per hour" },
    { rule: "en.abbr", re: /\bkph\b/gi, to: "kilometres per hour" },
    { rule: "en.abbr", re: /\bmph\b/gi, to: "miles per hour" },
    { rule: "en.abbr", re: /\bm\/s\b/gi, to: "metres per second" },
    { rule: "en.unit", re: /(\d)\s?km\b/gi, to: "$1 kilometres" },
    { rule: "en.unit", re: /(\d)\s?m\b(?!\/)/g, to: "$1 metres" },
    { rule: "en.unit", re: /(\d)\s?cm\b/gi, to: "$1 centimetres" },
    { rule: "en.unit", re: /(\d)\s?mm\b/gi, to: "$1 millimetres" },
    { rule: "en.unit", re: /(\d)\s?kg\b/gi, to: "$1 kilograms" },
    { rule: "en.unit", re: /(\d)\s?g\b/g, to: "$1 grams" },
    { rule: "en.unit", re: /(\d)\s?(hrs?|h)\b/gi, to: "$1 hours" },
    { rule: "en.unit", re: /(\d)\s?(mins?)\b/gi, to: "$1 minutes" },
    { rule: "en.unit", re: /(\d)\s?(secs?|s)\b/g, to: "$1 seconds" },
    { rule: "en.abbr", re: /\bDr\.(?=\s)/g, to: "Doctor" },
    { rule: "en.abbr", re: /\bMr\.(?=\s)/g, to: "Mister" },
    { rule: "en.abbr", re: /\bMrs\.(?=\s)/g, to: "Missus" },
    { rule: "en.abbr", re: /\bNo\.(?=\s?\d)/g, to: "number" },
    { rule: "en.abbr", re: /\bmax\.(?=\s)/gi, to: "maximum" },
    { rule: "en.abbr", re: /\bmin\.(?=\s)/gi, to: "minimum" },
    { rule: "en.abbr", re: /\bw\/o\b/gi, to: "without" },
    { rule: "en.abbr", re: /\bw\/(?=\s)/gi, to: "with" },
    { rule: "en.abbr", re: /\bN\/A\b/g, to: "not applicable" },
    { rule: "en.abbr", re: /\b(\d{1,2})\s?a\.?m\.?(?=[\s,.;)]|$)/gi, to: "$1 A M" },
    { rule: "en.abbr", re: /\b(\d{1,2})\s?p\.?m\.?(?=[\s,.;)]|$)/gi, to: "$1 P M" },
  ],
  connectives: ["but", "because", "so", "when", "if", "which", "although", "for example", "then", "while"],
  revealCues: [/the (correct )?answer is/gi, /the solution is/gi, /the result is/gi],
  optionLabel: (i) => ["A", "B", "C", "D", "E", "F"][i] ?? String(i + 1),
  optionsIntro: "The options are",
  decimalComma: false,
  identifierCue: /(sign|route|bus|road|section|page|rule|item|number|no\.?)\s*$/i,
};

const ES: LangPack = {
  digits: ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"],
  math: { times: "por", div: "entre", plus: "más", minus: "menos", eq: "es igual a", neq: "no es igual a", lt: "es menor que", gt: "es mayor que", le: "es menor o igual que", ge: "es mayor o igual que", sq: "al cuadrado", cube: "al cubo", sqrt: "la raíz cuadrada de", pct: "por ciento", deg: "grados", and: "y", arrow: "luego" },
  range: (a, b) => `de ${a} a ${b}`,
  abbreviations: [
    { rule: "es.abbr", re: /\bp\.\s?ej\.,?/gi, to: "por ejemplo," },
    { rule: "es.abbr", re: /\betc\.?(?=[\s,.;)]|$)/gi, to: "etcétera" },
    { rule: "es.abbr", re: /\bkm\/h\b/gi, to: "kilómetros por hora" },
    { rule: "es.abbr", re: /\bm\/s\b/gi, to: "metros por segundo" },
    { rule: "es.unit", re: /(\d)\s?km\b/gi, to: "$1 kilómetros" },
    { rule: "es.unit", re: /(\d)\s?m\b(?!\/)/g, to: "$1 metros" },
    { rule: "es.unit", re: /(\d)\s?cm\b/gi, to: "$1 centímetros" },
    { rule: "es.unit", re: /(\d)\s?mm\b/gi, to: "$1 milímetros" },
    { rule: "es.unit", re: /(\d)\s?kg\b/gi, to: "$1 kilogramos" },
    { rule: "es.unit", re: /(\d)\s?g\b/g, to: "$1 gramos" },
    { rule: "es.unit", re: /(\d)\s?(mins?)\b/gi, to: "$1 minutos" },
    { rule: "es.unit", re: /(\d)\s?(h|hrs?)\b/gi, to: "$1 horas" },
    { rule: "es.unit", re: /(\d)\s?(s|seg)\b/g, to: "$1 segundos" },
    { rule: "es.abbr", re: /\bSr\.(?=\s)/g, to: "señor" },
    { rule: "es.abbr", re: /\bSra\.(?=\s)/g, to: "señora" },
    { rule: "es.abbr", re: /\bSrta\.(?=\s)/g, to: "señorita" },
    { rule: "es.abbr", re: /\bDr\.(?=\s)/g, to: "doctor" },
    { rule: "es.abbr", re: /\bDra\.(?=\s)/g, to: "doctora" },
    { rule: "es.abbr", re: /\b(núm\.|n\.?º|nº|N\.?º)(?=\s?\d)/g, to: "número" },
    { rule: "es.abbr", re: /\bpág\.(?=\s)/gi, to: "página" },
    { rule: "es.abbr", re: /\baprox\.(?=\s)/gi, to: "aproximadamente" },
    { rule: "es.abbr", re: /\bUds?\.(?=\s)/g, to: (m) => (m.startsWith("Uds") ? "ustedes" : "usted") },
    { rule: "es.abbr", re: /\bEE\.\s?UU\./g, to: "Estados Unidos" },
    { rule: "es.abbr", re: /\bmáx\.(?=\s)/gi, to: "máximo" },
    { rule: "es.abbr", re: /\bmín\.(?=\s)/gi, to: "mínimo" },
  ],
  connectives: ["pero", "porque", "cuando", "si", "entonces", "por ejemplo", "aunque", "luego", "mientras"],
  revealCues: [/la respuesta( correcta)? es/gi, /la solución es/gi, /el resultado es/gi],
  optionLabel: (i) => ["A", "B", "C", "D", "E", "F"][i] ?? String(i + 1),
  optionsIntro: "Las opciones son",
  decimalComma: true,
  identifierCue: /(señal|ruta|autobús|carretera|sección|página|regla|número|n\.?º)\s*$/i,
};

const AR: LangPack = {
  digits: ["صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"],
  math: { times: "ضرب", div: "على", plus: "زائد", minus: "ناقص", eq: "يساوي", neq: "لا يساوي", lt: "أصغر من", gt: "أكبر من", le: "أصغر من أو يساوي", ge: "أكبر من أو يساوي", sq: "تربيع", cube: "تكعيب", sqrt: "الجذر التربيعي لـ", pct: "بالمئة", deg: "درجة", and: "و", arrow: "ثم" },
  range: (a, b) => `من ${a} إلى ${b}`,
  abbreviations: [
    { rule: "ar.abbr", re: bounded("كم\\s?/\\s?س"), to: "كيلومتر في الساعة" },
    { rule: "ar.abbr", re: bounded("م\\s?/\\s?ث"), to: "متر في الثانية" },
    { rule: "ar.time", re: /(\d{1,2}:\d{2})\s?ص(?![\p{L}])/gu, to: "$1 صباحًا" },
    { rule: "ar.time", re: /(\d{1,2}:\d{2})\s?م(?![\p{L}])/gu, to: "$1 مساءً" },
    { rule: "ar.unit", re: /(\d)\s?كم(?![\p{L}])/gu, to: "$1 كيلومتر" },
    { rule: "ar.unit", re: /(\d)\s?م(?![\p{L}])/gu, to: "$1 متر" },
    { rule: "ar.unit", re: /(\d)\s?سم(?![\p{L}])/gu, to: "$1 سنتيمتر" },
    { rule: "ar.unit", re: /(\d)\s?مم(?![\p{L}])/gu, to: "$1 مليمتر" },
    { rule: "ar.unit", re: /(\d)\s?كغ(?![\p{L}])/gu, to: "$1 كيلوغرام" },
    { rule: "ar.unit", re: /(\d)\s?د(?![\p{L}])/gu, to: "$1 دقيقة" },
    { rule: "ar.unit", re: /(\d)\s?ث(?![\p{L}])/gu, to: "$1 ثانية" },
    { rule: "ar.abbr", re: bounded("د\\."), to: "دكتور" },
    { rule: "ar.abbr", re: bounded("إلخ\\.?"), to: "إلى آخره" },
    { rule: "ar.abbr", re: bounded("ص\\.?ب\\.?"), to: "صندوق بريد" },
  ],
  connectives: ["لكن", "لأن", "عندما", "إذا", "ثم", "مثلا", "مثلاً", "بينما", "لذلك"],
  revealCues: [/الإجابة( الصحيحة)? هي/g, /الجواب( الصحيح)? هو/g, /الحل هو/g, /النتيجة هي/g],
  optionLabel: (i) => ["أ", "ب", "ج", "د", "هـ", "و"][i] ?? String(i + 1),
  optionsIntro: "الخيارات هي",
  decimalComma: false,
  identifierCue: /(إشارة|لافتة|خط|حافلة|طريق|بند|صفحة|قاعدة|رقم)\s*$/,
};

const PACKS: Record<LanguageCode, LangPack> = { "he-IL": HE, "en-US": EN, "es-ES": ES, "ar-XA": AR };

// ---------------------------------------------------------------------------
// Hebrew phonetic stabilisation (nikud on words TTS engines misread)
//
// The word list and the context rules are a subset of
// תאוריה מדברת data/speech-rules.json (generated by export-speech-rules.js):
// driving-theory terms whose unvowelled spelling is ambiguous. Nikud is added
// only in the TTS string; the display text keeps the plain spelling.
// ---------------------------------------------------------------------------

const HE_WORDS: Record<string, string> = {
  "פרט": "פְּרָט",
  "שלט": "שֶׁלֶט", "השלט": "הַשֶּׁלֶט", "בשלט": "בַּשֶּׁלֶט", "ושלט": "וְשֶׁלֶט", "שבשלט": "שֶׁבַּשֶּׁלֶט", "ושלטים": "וּשְׁלָטִים",
  "מפגש": "מִפְגָּשׁ", "המפגש": "הַמִּפְגָּשׁ", "למפגש": "לַמִּפְגָּשׁ", "במפגש": "בַּמִּפְגָּשׁ", "מהמפגש": "מֵהַמִּפְגָּשׁ", "כשהמפגש": "כְּשֶׁהַמִּפְגָּשׁ",
  "פולט": "פּוֹלֵט",
  "סטרי": "סִטְרִי", "סטרית": "סִטְרִית",
  "מראות": "מַרְאוֹת", "המראות": "הַמַּרְאוֹת", "במראות": "בַּמַּרְאוֹת",
  "פנסי": "פָּנָסֵי", "פנסים": "פָּנָסִים", "הפנסים": "הַפָּנָסִים",
  "לאותת": "לְאוֹתֵת", "מאותת": "מְאוֹתֵת",
  "לרכב": "לְרֶכֶב", "מרכב": "מֵרֶכֶב", "ורכב": "וְרֶכֶב", "רכבים": "רְכָבִים",
  "רוכב": "רוֹכֵב", "הרוכב": "הָרוֹכֵב", "רוכבי": "רוֹכְבֵי", "לרוכבי": "לְרוֹכְבֵי",
};

interface HeContextRule { word: string; before: string | null; after: string | null; voweled: string }
const HE_CONTEXT: HeContextRule[] = [
  { word: "המראה", before: null, after: "(השמאלית|הימנית|האחורית|הפנימית|החיצונית|ברכב|הפנורמית)", voweled: "הַמַּרְאָה" },
  { word: "המראה", before: null, after: "(הנשקף|הנשקפת|היפה|הנוף|שנשקף)", voweled: "הַמַּרְאֶה" },
  { word: "מראה", before: "(התמרור|הרמזור|השלט|התימרור)", after: "(לאן|כיוון|איפה|היכן|את|לך)", voweled: "מַרְאֶה" },
  { word: "מראה", before: null, after: "(פנורמית|צדדית|פנימית|חיצונית)", voweled: "מַרְאָה" },
  { word: "מפגש", before: null, after: "(מסילת|מסילות|רכבת|דרכים)", voweled: "מִפְגַּשׁ" },
  { word: "למפגש", before: null, after: "(מסילת|מסילות|רכבת|דרכים)", voweled: "לְמִפְגַּשׁ" },
  { word: "במפגש", before: null, after: "(מסילת|מסילות|רכבת|דרכים)", voweled: "בְּמִפְגַּשׁ" },
  { word: "ברירת", before: null, after: "(מחדל|המחדל)", voweled: "בְּרֵירַת" },
  { word: "קדימה", before: "(זכות|הזכות|זכויות)", after: null, voweled: "קְדִימָה" },
  { word: "קדימה", before: "(ישר|סע|נסע|להמשיך|המשך)", after: null, voweled: "קָדִימָה" },
];

function hebrewNikud(text: string, hits: GuardrailHit[]): string {
  let out = text;
  // Context rules first: they are more specific than the bare word list.
  for (const r of HE_CONTEXT) {
    const before = r.before ? `(?<=${r.before}\\s)` : "";
    const after = r.after ? `(?=\\s${r.after})` : "";
    const re = new RegExp(`${before}${NW}${r.word}${NWE}${after}`, "gu");
    out = out.replace(re, () => {
      hits.push({ rule: "he.nikud.context", from: r.word, to: r.voweled });
      return r.voweled;
    });
  }
  for (const [plain, voweled] of Object.entries(HE_WORDS)) {
    const re = bounded(plain);
    out = out.replace(re, (m) => {
      if (/[֑-ׇ]/.test(m)) return m; // already vowelled
      hits.push({ rule: "he.nikud", from: plain, to: voweled });
      return voweled;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arabic phonetic stabilisation (tashkeel on ambiguous learning/driving terms)
// ---------------------------------------------------------------------------

const AR_WORDS: Record<string, string> = {
  "سرعة": "سُرْعَة", "السرعة": "السُّرْعَة",
  "مركبة": "مَرْكَبَة", "المركبة": "المَرْكَبَة",
  "إشارة": "إِشَارَة", "الإشارة": "الإِشَارَة",
  "منعطف": "مُنْعَطَف", "المنعطف": "المُنْعَطَف",
  "مسافة": "مَسَافَة", "المسافة": "المَسَافَة",
  "علم": "عِلْم", "العلم": "العِلْم",
  "كتب": "كَتَبَ",
  "درس": "دَرْس", "الدرس": "الدَّرْس",
  "جمع": "جَمْع", "الجمع": "الجَمْع",
  "طرح": "طَرْح", "الطرح": "الطَّرْح",
  "ضرب": "ضَرْب", "الضرب": "الضَّرْب",
  "قسمة": "قِسْمَة", "القسمة": "القِسْمَة",
};

function arabicTashkeel(text: string, hits: GuardrailHit[]): string {
  let out = text;
  for (const [plain, voweled] of Object.entries(AR_WORDS)) {
    out = out.replace(bounded(plain), (m) => {
      if (/[ً-ٟ]/.test(m)) return m;
      hits.push({ rule: "ar.tashkeel", from: plain, to: voweled });
      return voweled;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numbers, symbols, identifiers
// ---------------------------------------------------------------------------

function spellDigits(digits: string, pack: LangPack): string {
  return digits.split("").map((d) => pack.digits[Number(d)] ?? d).join(" ");
}

function numbersAndSymbols(text: string, pack: LangPack, hits: GuardrailHit[]): string {
  const m = pack.math;
  const rules: Rule[] = [
    // Thousands separators: "1,000" / "1.000" (es) / "1 000" -> "1000".
    { rule: "num.thousands", re: /\b(\d{1,3})(?:,(\d{3}))+\b(?!\.\d)/g, to: (s) => s.replace(/,/g, "") },
    // Ranges written without spaces: 50-70, 50–70.
    { rule: "num.range", re: /(?<![\d.,])(\d+(?:[.,]\d+)?)\s?[-–]\s?(\d+(?:[.,]\d+)?)(?![\d.,])/g, to: (_s, a, b) => pack.range(a ?? "", b ?? "") },
    // Ratios / fractions like 3/4 read as division.
    { rule: "math.frac", re: /(?<=\d)\s*\/\s*(?=\d)/g, to: ` ${m.div} ` },
    { rule: "math.times", re: /(?<=\d\s?)[×x*](?=\s?\d)/gi, to: ` ${m.times} ` },
    { rule: "math.div", re: /(?<=\d\s?)[÷:](?=\s?\d)(?!\d{2}\b)/g, to: ` ${m.div} ` },
    { rule: "math.plus", re: /(?<=\d\s?)\+(?=\s?\d)/g, to: ` ${m.plus} ` },
    { rule: "math.minus", re: /(?<=\d)\s[-−]\s(?=\d)/g, to: ` ${m.minus} ` },
    { rule: "math.sqrt", re: /√\s?/g, to: `${m.sqrt} ` },
    { rule: "math.pow", re: /(?<=\d|\))²/g, to: ` ${m.sq}` },
    { rule: "math.pow", re: /(?<=\d|\))³/g, to: ` ${m.cube}` },
    { rule: "math.pow", re: /(\d)\^2\b/g, to: `$1 ${m.sq}` },
    { rule: "math.pow", re: /(\d)\^3\b/g, to: `$1 ${m.cube}` },
    { rule: "math.cmp", re: /\s(≠)\s/g, to: ` ${m.neq} ` },
    { rule: "math.cmp", re: /\s(≤|<=)\s/g, to: ` ${m.le} ` },
    { rule: "math.cmp", re: /\s(≥|>=)\s/g, to: ` ${m.ge} ` },
    { rule: "math.cmp", re: /\s<\s/g, to: ` ${m.lt} ` },
    { rule: "math.cmp", re: /\s>\s/g, to: ` ${m.gt} ` },
    { rule: "math.eq", re: /\s?=\s?/g, to: ` ${m.eq} ` },
    { rule: "sym.pct", re: /(\d)\s?%/g, to: `$1 ${m.pct}` },
    { rule: "sym.deg", re: /(\d)\s?°C?/g, to: `$1 ${m.deg}` },
    { rule: "sym.and", re: /\s&\s/g, to: ` ${m.and} ` },
    { rule: "sym.arrow", re: /\s?(→|->|=>)\s?/g, to: `, ${m.arrow} ` },
  ];
  let out = applyRules(text, rules, hits);
  if (pack.decimalComma) {
    out = out.replace(/(\d)\.(\d)/g, (s, a, b) => {
      hits.push({ rule: "num.decimal-comma", from: s, to: `${a},${b}` });
      return `${a},${b}`;
    });
  }
  return out;
}

/**
 * A number that is a label (sign 615, bus 18) is spelled digit by digit:
 * "six hundred fifteen" and "six hundred thirteen" differ by one buried word,
 * "six one five" and "six one three" do not. Quantities keep their reading.
 */
function identifiers(text: string, pack: LangPack, hits: GuardrailHit[]): string {
  if (!pack.identifierCue) return text;
  const cue = pack.identifierCue;
  return text.replace(/(\d{2,5})(?![\d.,:])/g, (num, _d, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 24), offset);
    if (!cue.test(before)) return num;
    const spelled = `<say-as interpret-as="characters">${num}</say-as>`;
    hits.push({ rule: "num.identifier", from: num, to: spellDigits(num, pack) });
    return spelled;
  });
}

/** Latin uppercase acronyms (ADHD, GPS, ABS) are spelled; known words stay. */
const ACRONYM_WORDS = new Set(["OK", "NASA", "UNESCO", "PIN", "RAM", "LED", "PDF", "SIM", "AIDS", "NATO"]);
function acronyms(text: string, hits: GuardrailHit[]): string {
  return text.replace(/\b([A-Z]{2,5})\b/g, (m) => {
    if (ACRONYM_WORDS.has(m)) return m;
    hits.push({ rule: "acronym.spell", from: m, to: m.split("").join(" ") });
    return `<say-as interpret-as="characters">${m}</say-as>`;
  });
}

// ---------------------------------------------------------------------------
// Display text: short paragraphs for dyslexic readers
// ---------------------------------------------------------------------------

// Split after . ! ? ؟ … when the next token starts a sentence: an uppercase
// Latin letter, a digit, a quote/bracket, or a non-Latin letter. "p. ej. en"
// and "e.g. in" stay together because the next word is lowercase Latin.
const SENTENCE_END = /(?<=[.!?؟…])\s+(?=[\p{Lu}\p{N}"'(\[¿¡]|[^\p{Script=Latin}\s\p{P}])/u;

function splitSentences(text: string): string[] {
  return text.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
}

function ensureTerminal(sentence: string): string {
  return /[.!?؟…:]$/.test(sentence) ? sentence : sentence + ".";
}

export function toShortParagraphs(text: string, maxSentences = 2, maxChars = 160): string {
  const paras = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}|\n(?=\S)/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of paras) {
    const sentences = splitSentences(p).map(ensureTerminal);
    let cur: string[] = [];
    let len = 0;
    for (const s of sentences) {
      if (cur.length && (cur.length >= maxSentences || len + s.length > maxChars)) {
        out.push(cur.join(" "));
        cur = [];
        len = 0;
      }
      cur.push(s);
      len += s.length + 1;
    }
    if (cur.length) out.push(cur.join(" "));
  }
  return out.join("\n\n");
}

function normaliseDisplay(text: string): string {
  return toShortParagraphs(
    stripMarkdown(text)
      .replace(/[‘’‚]/g, "'")
      .replace(/[“”„]/g, '"')
      .replace(/\.{3}/g, "…")
      .replace(/[ \t]+/g, " ")
      .replace(/ ([,.;:!?])/g, "$1"),
  );
}

// ---------------------------------------------------------------------------
// Cadence: pauses, comma breathing, reveal suspense
// ---------------------------------------------------------------------------

const BREAK_SENTENCE = '<break time="350ms"/>';
const BREAK_PARAGRAPH = '<break time="650ms"/>';
const BREAK_REVEAL = '<break time="500ms"/>';
const BREAK_OPTION = '<break time="400ms"/>';

function breathe(sentence: string, pack: LangPack, hits: GuardrailHit[]): string {
  const words = sentence.split(/\s+/);
  if (words.length < 14 || /[,،;:]/.test(sentence)) return sentence;
  // Insert one comma before the first connective that appears after word 4.
  for (let i = 4; i < words.length - 2; i++) {
    const w = stripHebrewNikud(stripArabicTashkeel(words[i] ?? "")).toLowerCase();
    if (pack.connectives.includes(w)) {
      const to = words.slice(0, i).join(" ") + ", " + words.slice(i).join(" ");
      hits.push({ rule: "cadence.comma", from: words[i - 1] + " " + words[i], to: words[i - 1] + ", " + words[i] });
      return to;
    }
  }
  return sentence;
}

function revealSuspense(text: string, pack: LangPack, hits: GuardrailHit[]): string {
  let out = text;
  for (const cue of pack.revealCues) {
    out = out.replace(cue, (m) => {
      hits.push({ rule: "cadence.reveal", from: m, to: `${m}…` });
      return `${m}… ${BREAK_REVEAL}`;
    });
  }
  return out;
}

function cadence(
  displayText: string,
  lang: LanguageCode,
  hits: GuardrailHit[],
  transform: (sentence: string) => string,
): string {
  const pack = PACKS[lang];
  const paragraphs = displayText.split(/\n\n+/);
  const rendered = paragraphs.map((p) => {
    const sentences = splitSentences(p).map((raw) => {
      let s = transform(breathe(raw, pack, hits));
      // Colons and semicolons are read flat by most engines; make them a pause.
      s = s.replace(/[:;]\s/g, `${lang === "ar-XA" ? "،" : ","} ${BREAK_SENTENCE} `);
      s = s.replace(/…/g, `… ${BREAK_REVEAL}`);
      s = revealSuspense(s, pack, hits);
      return s;
    });
    return sentences.join(` ${BREAK_SENTENCE} `);
  });
  return rendered.join(` ${BREAK_PARAGRAPH} `).replace(/\s{2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Voice preference
// ---------------------------------------------------------------------------

const DEFAULT_VOICE: Record<Layout, VoicePreference> = {
  explanation: "female_warm",
  flashcard: "female_warm",
  quiz: "male_clear",
  scenario: "male_clear",
};

export function resolveVoice(pref: string | null | undefined, layout: Layout): VoicePreference {
  if (pref && (VOICE_PREFERENCES as readonly string[]).includes(pref)) return pref as VoicePreference;
  return DEFAULT_VOICE[layout];
}

// ---------------------------------------------------------------------------
// Public pipeline
// ---------------------------------------------------------------------------

/** Full TTS transformation of one text fragment (no <speak> wrapper). */
export function ttsFragment(text: string, lang: LanguageCode, hits: GuardrailHit[]): string {
  const pack = PACKS[lang];
  let t = stripMarkdown(text);
  t = t.replace(HE_GERSHAYIM, '"').replace(HE_GERESH, "'");
  t = applyRules(t, pack.abbreviations, hits);
  t = numbersAndSymbols(t, pack, hits);
  t = identifiers(t, pack, hits);
  t = acronyms(t, hits);
  if (lang === "he-IL") t = hebrewNikud(t, hits);
  if (lang === "ar-XA") {
    t = t.replace(/ـ/g, ""); // tatweel: pure typography, breaks some engines
    t = arabicTashkeel(t, hits);
  }
  return t.replace(/\s{2,}/g, " ").trim();
}

export function stripSsml(ssml: string): string {
  return ssml
    .replace(/<break[^>]*\/>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/ ([,.;:!?،؟])/g, "$1")
    .trim();
}

export function runGuardrails(input: GuardrailInput): GuardrailOutput {
  const hits: GuardrailHit[] = [];
  const warnings: string[] = [];
  const layout: Layout = input.layout ?? "explanation";

  // 1. Language verification.
  const claimed = (LANGUAGE_CODES as readonly string[]).includes(input.language_code)
    ? (input.language_code as LanguageCode)
    : null;
  const detected = detectLanguage(input.raw_text);
  let lang: LanguageCode;
  let verified = true;
  if (claimed && (!detected || detected === claimed)) {
    lang = claimed;
  } else if (detected) {
    lang = detected;
    verified = false;
    warnings.push(`language_code corrected from ${input.language_code || "(none)"} to ${detected}`);
    hits.push({ rule: "lang.verify", from: input.language_code, to: detected });
  } else {
    lang = claimed ?? "en-US";
    verified = claimed !== null;
    if (!claimed) warnings.push("language_code missing and not detectable; defaulted to en-US");
  }
  const pack = PACKS[lang];

  // 2. Display text.
  const display = normaliseDisplay(input.raw_text);
  const optionsDisplay = (input.options ?? []).map((o) => stripMarkdown(o).replace(/\s+/g, " ").trim());

  // 3. TTS body.
  const ttsBody = cadence(display, lang, hits, (sentence) => ttsFragment(sentence, lang, hits));

  // 4. Options (quiz): labelled, paused, and guarded.
  const optionsTts = optionsDisplay.map((o) => ttsFragment(o, lang, hits));
  let optionsSsml = "";
  if (layout === "quiz" && optionsTts.length) {
    const parts = optionsTts.map((o, i) => `${pack.optionLabel(i)}. ${o}`);
    const comma = lang === "ar-XA" ? "،" : ",";
    optionsSsml = ` ${BREAK_PARAGRAPH} ${pack.optionsIntro}${comma} ${BREAK_SENTENCE} ${parts.join(` ${BREAK_OPTION} `)}`;
  }

  // 5. Forbidden strings (answer leakage) — checked on the question body only.
  for (const f of input.forbidden_in_tts ?? []) {
    const needle = stripHebrewNikud(stripArabicTashkeel(f)).trim().toLowerCase();
    if (needle.length < 2) continue;
    const hay = stripHebrewNikud(stripArabicTashkeel(stripSsml(ttsBody))).toLowerCase();
    const re = new RegExp(NW + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + NWE, "u");
    if (re.test(hay)) warnings.push(`tts body contains the correct answer "${f}" before the options`);
  }

  const ssml = `<speak>${ttsBody}${optionsSsml}</speak>`.replace(/\s{2,}/g, " ");

  return {
    display_text: display,
    tts_ssml: ssml,
    tts_plain: stripSsml(ssml),
    options_display: optionsDisplay,
    options_tts: optionsTts.map(stripSsml),
    language_code: lang,
    language_verified: verified,
    detected_language: detected,
    voice_preference: resolveVoice(input.voice_preference, layout),
    hits,
    warnings,
  };
}
