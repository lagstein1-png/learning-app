import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, runGuardrails, stripSsml, toShortParagraphs } from "../src/guardrails.ts";

test("hebrew: acronyms, sign numbers, nikud context, math symbols, breathing", () => {
  const r = runGuardrails({
    raw_text: 'המהירות המותרת היא 50 קמ"ש. תמרור 615 מסמן מפגש מסילת רכבת. 3 × 4 = 12. יש 1,000 מטרים בק"מ אחד.',
    language_code: "he-IL",
    layout: "quiz",
    options: ['50 קמ"ש', '70 קמ"ש'],
  });
  assert.equal(r.language_code, "he-IL");
  assert.ok(r.tts_plain.includes("קילומטר לשעה"));
  assert.ok(r.tts_ssml.includes('<say-as interpret-as="characters">615</say-as>'));
  assert.ok(r.tts_plain.includes("מִפְגַּשׁ"), "context rule vowels מפגש before מסילת");
  assert.ok(r.tts_plain.includes("3 כפול 4 שווה 12"));
  assert.ok(r.tts_plain.includes("1000 מטרים"));
  assert.ok(r.tts_ssml.includes('<break time="350ms"/>'));
  assert.ok(r.tts_ssml.includes("האפשרויות הן"));
  assert.equal(r.options_tts[0], "50 קילומטר לשעה");
  // Display text keeps the plain spelling and the original abbreviation.
  assert.ok(r.display_text.includes('קמ"ש'));
  assert.ok(!r.display_text.includes("מִפְגַּשׁ"));
  // No rule may rewrite the inside of a tag.
  assert.ok(!/time שווה/.test(r.tts_ssml));
  assert.ok(!/<[^>]*(שווה|equals)[^>]*>/.test(r.tts_ssml));
});

test("english: abbreviations, units, percent, acronyms, reveal suspense", () => {
  const r = runGuardrails({
    raw_text: "The limit is 50 km/h, e.g. in town. Sign 615 marks a crossing and ADHD is common. 25% of 1,200 is 300. The correct answer is B.",
    language_code: "en-US",
  });
  assert.ok(r.tts_plain.includes("50 kilometres per hour, for example, in town"));
  assert.ok(r.tts_ssml.includes('<say-as interpret-as="characters">ADHD</say-as>'));
  assert.ok(r.tts_plain.includes("25 percent of 1200"));
  assert.ok(r.tts_ssml.includes('The correct answer is… <break time="500ms"/>'));
  assert.ok(!r.tts_ssml.includes("$1"), "string replacements expand capture groups");
});

test("spanish: abbreviation with dots does not split a sentence; decimal comma", () => {
  const r = runGuardrails({
    raw_text: "La velocidad máxima es 50 km/h, p. ej. en la ciudad. El resultado es 3.5 y la señal 615 indica peligro.",
    language_code: "es-ES",
  });
  assert.equal(r.display_text.split("\n\n").length, 1);
  assert.ok(r.tts_plain.includes("por ejemplo, en la ciudad"));
  assert.ok(r.tts_plain.includes("3,5"));
  assert.ok(r.tts_ssml.includes('<say-as interpret-as="characters">615</say-as>'));
});

test("arabic: km/h, tashkeel on ambiguous words, arabic comma pause, tatweel removed", () => {
  const r = runGuardrails({
    raw_text: "السرعة القصوى هي 50 كم/س داخل المدينة: انتبه. المـسافة مهمة.",
    language_code: "ar-XA",
  });
  assert.ok(r.tts_plain.includes("كيلومتر في الساعة"));
  assert.ok(r.tts_plain.includes("السُّرْعَة"));
  assert.ok(r.tts_ssml.includes('، <break time="350ms"/>'));
  assert.ok(!r.tts_plain.includes("ـ"));
  assert.equal(r.language_code, "ar-XA");
});

test("language verification corrects a wrong language_code and reports it", () => {
  const r = runGuardrails({ raw_text: "This is clearly English text about the road.", language_code: "he-IL" });
  assert.equal(r.language_code, "en-US");
  assert.equal(r.language_verified, false);
  assert.ok(r.warnings[0]?.includes("corrected"));
  assert.ok(r.hits.some((h) => h.rule === "lang.verify"));
});

test("detectLanguage distinguishes the four scripts", () => {
  assert.equal(detectLanguage("זכות קדימה בצומת"), "he-IL");
  assert.equal(detectLanguage("حق الأولوية عند التقاطع"), "ar-XA");
  assert.equal(detectLanguage("La prioridad de paso en el cruce es de la derecha"), "es-ES");
  assert.equal(detectLanguage("The right of way at the junction is for the car on the right"), "en-US");
  assert.equal(detectLanguage("42"), null);
});

test("long sentences get one breathing comma before a connective", () => {
  const r = runGuardrails({
    raw_text: "This is a very long sentence that keeps going on and on without any pause because nobody stopped to breathe at all here.",
    language_code: "en-US",
  });
  assert.ok(r.tts_plain.includes("pause, because"));
  assert.ok(r.hits.some((h) => h.rule === "cadence.comma"));
});

test("display text is broken into short paragraphs", () => {
  const p = toShortParagraphs("One. Two. Three. Four. Five.");
  assert.equal(p.split("\n\n").length, 3);
});

test("answer leakage in the question body is flagged", () => {
  const r = runGuardrails({
    raw_text: "Which number is 12? The answer is 12.",
    language_code: "en-US",
    layout: "quiz",
    options: ["12", "13"],
    forbidden_in_tts: ["12"],
  });
  assert.ok(r.warnings.some((w) => w.includes("contains the correct answer")));
});

test("markdown is stripped and stripSsml removes every tag", () => {
  const r = runGuardrails({ raw_text: "# Heading\n\n**Bold** and `code`.\n- item one\n- item two", language_code: "en-US" });
  assert.ok(!r.display_text.includes("**"));
  assert.ok(!r.display_text.includes("#"));
  assert.equal(stripSsml('<speak>a <break time="1ms"/> b</speak>'), "a b");
  assert.ok(!/<[^>]+>/.test(r.tts_plain));
});

test("voice preference: explicit wins, otherwise layout default", () => {
  assert.equal(runGuardrails({ raw_text: "Hello there friend.", language_code: "en-US", layout: "quiz" }).voice_preference, "male_clear");
  assert.equal(runGuardrails({ raw_text: "Hello there friend.", language_code: "en-US", layout: "explanation" }).voice_preference, "female_warm");
  assert.equal(runGuardrails({ raw_text: "Hello there friend.", language_code: "en-US", layout: "quiz", voice_preference: "female_warm" }).voice_preference, "female_warm");
});
