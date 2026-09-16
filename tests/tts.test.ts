/**
 * End-to-end integration tests over the HTTP surface: the four language
 * tracks, dictionary lookups and overrides, the Gemini pre-processing
 * contract (including its failure modes), audio streaming, provider
 * fallback and device fallback, retries, caching, auth and validation.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Response as SuperagentResponse } from "superagent";
import { buildTestApp, echoModel, FakeModel, FakeProvider } from "./helpers/mocks.js";
import type { LanguageCode, ProcessTextResponse } from "../src/types/index.js";
import { escapeXml } from "../src/utils/text.js";

const SAMPLES: Readonly<Record<LanguageCode, string>> = {
  he: 'בצומת עם תמרור עצור חובה לעצור. המהירות המרבית בעיר היא 50 קמ"ש. האם נהג חדש רשאי לנהוג בלילה?',
  en: "At a junction with a stop sign you must stop. The speed limit in town is 50 km/h. May a new driver drive at night?",
  ar: "عند تقاطع فيه إشارة قف يجب التوقف. السرعة القصوى في المدينة 50 كم/س. هل يجوز للسائق الجديد القيادة ليلاً؟",
  ru: "На перекрёстке со знаком «стоп» нужно остановиться. Максимальная скорость в городе 50 км/ч. Можно ли новичку ездить ночью?",
};

async function processText(app: ReturnType<typeof buildTestApp>["app"], body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<ProcessTextResponse> {
  const res = await request(app).post("/process-text").set(headers).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ProcessTextResponse;
}

describe("health and catalogue", () => {
  it("reports the four languages and configured providers", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.languages).toEqual(["he", "en", "ar", "ru"]);
    expect(res.body.providers).toEqual({ azure: true, google: true });
    expect(res.body.gemini).toBe(false);
    expect(res.body.supabase).toBe(false);
  });

  it("lists voices per language with female voices first", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/voices?language=he");
    expect(res.status).toBe(200);
    const voices = res.body.voices as { id: string; gender: string; language: string }[];
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.every((v) => v.language === "he")).toBe(true);
    expect(voices[0]?.gender).toBe("female");
  });
});

describe("language matrix", () => {
  for (const language of ["he", "en", "ar", "ru"] as const) {
    it(`builds a plan in ${language} with a female neural voice and consistent chunk offsets`, async () => {
      const { app } = buildTestApp();
      const plan = await processText(app, { text: SAMPLES[language], language });
      expect(plan.language).toBe(language);
      expect(plan.direction).toBe(language === "he" || language === "ar" ? "rtl" : "ltr");
      expect(plan.voice.gender).toBe("female");
      expect(plan.voice.provider).toBe("azure");
      expect(plan.voice.id.startsWith({ he: "he-IL", en: "en-US", ar: "ar-", ru: "ru-RU" }[language])).toBe(true);
      expect(plan.preprocess.source).toBe("rules");
      expect(plan.plan.chunks.length).toBeGreaterThan(0);
      for (const chunk of plan.plan.chunks) {
        expect(plan.preprocess.text.slice(chunk.start, chunk.end)).toBe(chunk.text);
        expect(chunk.estimatedDurationMs).toBeGreaterThan(0);
        expect(chunk.cacheKey).toMatch(/^[0-9a-f]{32}$/);
      }
      expect(plan.plan.chunks[plan.plan.chunks.length - 1]?.boundary).toBe("end");
      expect(plan.planToken.startsWith("plan_")).toBe(true);
    });
  }

  it("expands the seeded speed-unit abbreviation in every language", async () => {
    const { app } = buildTestApp();
    const expectations: Record<LanguageCode, string> = { he: "קילומטר לשעה", en: "kilometres per hour", ar: "كيلومتر في الساعة", ru: "километров в час" };
    for (const language of ["he", "en", "ar", "ru"] as const) {
      const plan = await processText(app, { text: SAMPLES[language], language });
      expect(plan.preprocess.text, language).toContain(expectations[language]);
      expect(plan.overrides.some((o) => o.spokenForm === expectations[language])).toBe(true);
    }
  });

  it("selects a male voice when asked and a slower cadence lowers the rate", async () => {
    const { app } = buildTestApp();
    const plan = await processText(app, { text: SAMPLES.he, language: "he", gender: "male", cadence: "slow" });
    expect(plan.voice.id).toBe("he-IL-AvriNeural");
    expect(plan.voice.prosody.rate).toBeLessThan(0.9);
    expect(plan.voice.deviceHint.gender).toBe("male");
    expect(plan.voice.deviceHint.preferredNames[0]).toContain("Avri");
  });

  it("prefers Google when Azure is not configured", async () => {
    const { app } = buildTestApp({ providers: [new FakeProvider("google")], env: { AZURE_SPEECH_KEY: "" } });
    const plan = await processText(app, { text: SAMPLES.ru, language: "ru" });
    expect(plan.voice.provider).toBe("google");
    expect(plan.voice.id).toBe("ru-RU-Wavenet-C");
    expect(plan.voice.gender).toBe("female");
  });
});

describe("dictionary overrides", () => {
  it("applies a learner override over the global one and lists both", async () => {
    const { app } = buildTestApp();
    const created = await request(app).post("/dictionary-override").send({ language: "he", term: 'קמ"ש', spokenForm: "קילומטרים בשעה", userId: "learner-1" });
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.body.override.userId).toBe("learner-1");

    const again = await request(app).post("/dictionary-override").send({ language: "he", term: 'קמ"ש', spokenForm: "קילומטרים בשעה", userId: "learner-1" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.override.id).toBe(created.body.override.id);

    const scoped = await processText(app, { text: SAMPLES.he, language: "he", userId: "learner-1" });
    expect(scoped.preprocess.text).toContain("קילומטרים בשעה");
    expect(scoped.overrides.find((o) => o.term === 'קמ"ש')?.scope).toBe("user");

    const anonymous = await processText(app, { text: SAMPLES.he, language: "he" });
    expect(anonymous.preprocess.text).toContain("קילומטר לשעה");
    expect(anonymous.preprocess.text).not.toContain("קילומטרים בשעה");

    const list = await request(app).get("/dictionary-override?language=he&userId=learner-1");
    expect(list.status).toBe(200);
    const terms = (list.body.overrides as { term: string; userId: string | null }[]).filter((o) => o.term === 'קמ"ש');
    expect(terms.map((o) => o.userId).sort()).toEqual([null, "learner-1"].sort());

    const removed = await request(app).delete(`/dictionary-override/${created.body.override.id as string}?language=he&userId=learner-1`);
    expect(removed.status).toBe(204);
    const after = await processText(app, { text: SAMPLES.he, language: "he", userId: "learner-1" });
    expect(after.preprocess.text).toContain("קילומטר לשעה");
  });

  it("reads the learner id from the x-user-id header", async () => {
    const { app } = buildTestApp();
    await request(app).post("/dictionary-override").send({ language: "en", term: "km/h", spokenForm: "kilometers an hour", userId: "u-header" }).expect(201);
    const plan = await processText(app, { text: SAMPLES.en, language: "en" }, { "x-user-id": "u-header" });
    expect(plan.preprocess.text).toContain("kilometers an hour");
  });

  it("emits an IPA phoneme tag when the override carries one", async () => {
    const { app, azure } = buildTestApp();
    const plan = await processText(app, { text: "Reading with dyslexia takes effort. Take your time.", language: "en" });
    const res = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`);
    expect(res.status).toBe(200);
    expect(azure.calls[0]?.ssml).toContain('<phoneme alphabet="ipa" ph="dɪsˈlɛksiə">dyslexia</phoneme>');
  });
});

describe("linguistic pre-processing with Gemini", () => {
  it("uses the model output, locates emphasis after dictionary rewrites, and applies annotations", async () => {
    const model = new FakeModel(
      echoModel({
        mood: "calm",
        context: "driving-theory rule",
        emphasis: [{ phrase: "חובה לעצור", level: "strong", reason: "the rule" }],
        phoneticAnnotations: [{ term: "תמרור", spokenForm: "תַּמְרוּר" }],
      }),
    );
    const { app, azure } = buildTestApp({ model });
    const plan = await processText(app, { text: SAMPLES.he, language: "he", domain: "driving-theory" });
    expect(plan.preprocess.source).toBe("gemini");
    expect(plan.preprocess.mood).toBe("calm");
    expect(plan.preprocess.context).toBe("driving-theory rule");
    expect(model.prompts[0]?.startsWith("Domain: driving-theory")).toBe(true);
    expect(plan.preprocess.text).toContain("תַּמְרוּר");
    expect(plan.preprocess.text).toContain("קילומטר לשעה");
    const marker = plan.preprocess.emphasis[0];
    expect(marker).toBeDefined();
    expect(plan.preprocess.text.slice(marker?.start, marker?.end)).toBe("חובה לעצור");
    expect(plan.voice.prosody.rate).toBeLessThan(0.9);

    await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`).expect(200);
    expect(azure.calls[0]?.ssml).toContain('<emphasis level="strong">חובה לעצור</emphasis>');
  });

  it("falls back to the rule layer when the model fails, after retrying transient errors", async () => {
    const model = new FakeModel(echoModel()).failNext(new Error("fetch failed"), 5);
    const { app } = buildTestApp({ model });
    const plan = await processText(app, { text: SAMPLES.en, language: "en" });
    expect(plan.preprocess.source).toBe("rules");
    expect(model.prompts.length).toBe(3);
  });

  it("rejects model output that drifts from the source and keeps the rule text", async () => {
    const model = new FakeModel(() => ({ text: "Completely different and much longer text that clearly is not the original at all and keeps going on and on and on and on.", context: "", mood: "warm", emphasis: [], homographs: [], phoneticAnnotations: [] }));
    const { app } = buildTestApp({ model });
    const plan = await processText(app, { text: "Short input.", language: "en" });
    expect(plan.preprocess.source).toBe("rules");
    expect(plan.preprocess.text).toBe("Short input.");
  });

  it("rejects a language switch in the model output", async () => {
    const model = new FakeModel(() => ({ text: "This is an English rendering of the Hebrew sentence about a stop sign at a junction.", context: "", mood: "warm", emphasis: [], homographs: [], phoneticAnnotations: [] }));
    const { app } = buildTestApp({ model });
    const plan = await processText(app, { text: "בצומת עם תמרור עצור חובה לעצור לפני קו העצירה ולתת זכות קדימה.", language: "he" });
    expect(plan.preprocess.source).toBe("rules");
  });

  it("skips the model for very short text and when skipAi is set", async () => {
    const model = new FakeModel(echoModel());
    const { app } = buildTestApp({ model });
    await processText(app, { text: "שלום.", language: "he" });
    await processText(app, { text: SAMPLES.he, language: "he", skipAi: true });
    expect(model.prompts.length).toBe(0);
  });

  it("uses a homograph reading as a per-text replacement", async () => {
    const model = new FakeModel(echoModel({ homographs: [{ surface: "read", reading: "red", meaning: "past tense" }] }));
    const { app } = buildTestApp({ model });
    const plan = await processText(app, { text: "Yesterday I read the whole chapter twice.", language: "en" });
    expect(plan.preprocess.text).toBe("Yesterday I red the whole chapter twice.");
  });
});

describe("audio pipeline", () => {
  it("returns MP3 for a single chunk and serves the second request from cache", async () => {
    const { app, azure } = buildTestApp();
    const plan = await processText(app, { text: SAMPLES.en, language: "en" });
    const first = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`).buffer(true).parse(binaryParser);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("audio/mpeg");
    expect(first.headers["x-tts-provider"]).toBe("azure");
    expect(first.headers["x-tts-voice"]).toBe("en-US-JennyNeural");
    expect(first.headers["x-tts-cached"]).toBe("0");
    expect((first.body as Buffer).toString("utf8").startsWith("MP3|azure|en-US-JennyNeural|")).toBe(true);
    expect(azure.calls[0]?.ssml).toContain('<voice name="en-US-JennyNeural">');
    expect(azure.calls[0]?.ssml).toContain('<mstts:express-as style="friendly"');

    const second = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`).buffer(true).parse(binaryParser);
    expect(second.headers["x-tts-cached"]).toBe("1");
    expect(azure.calls.length).toBe(1);
  });

  it("streams the whole plan as one MP3 body with all chunks in order", async () => {
    const { app, azure } = buildTestApp();
    const plan = await processText(app, { text: SAMPLES.ru, language: "ru", maxChunkChars: 80 });
    expect(plan.plan.chunks.length).toBeGreaterThan(1);
    const res = await request(app).get(`/get-audio?planToken=${plan.planToken}`).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["x-tts-chunks"]).toBe(String(plan.plan.chunks.length));
    const body = (res.body as Buffer).toString("utf8");
    const pieces = body.split("MP3|").filter((p) => p.length > 0);
    expect(pieces.length).toBe(plan.plan.chunks.length);
    expect(azure.calls.length).toBe(plan.plan.chunks.length);
    for (const [i, call] of azure.calls.entries()) {
      expect(call.ssml).toContain(escapeXml(plan.plan.chunks[i]?.text ?? ""));
    }
  });

  it("retries a transient provider failure with backoff and then succeeds", async () => {
    const azure = new FakeProvider("azure").failNext(1, 503);
    const { app, delays } = buildTestApp({ providers: [azure, new FakeProvider("google")] });
    const plan = await processText(app, { text: SAMPLES.ar, language: "ar" });
    const res = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`);
    expect(res.status).toBe(200);
    expect(res.headers["x-tts-provider"]).toBe("azure");
    expect(azure.calls.length).toBe(2);
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeLessThanOrEqual(300);
  });

  it("does not retry a non-transient failure and falls through to the next provider", async () => {
    const azure = new FakeProvider("azure").alwaysFail(400, "bad ssml");
    const google = new FakeProvider("google");
    const { app } = buildTestApp({ providers: [azure, google] });
    const plan = await processText(app, { text: SAMPLES.he, language: "he" });
    const res = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`);
    expect(res.status).toBe(200);
    expect(res.headers["x-tts-provider"]).toBe("google");
    expect(res.headers["x-tts-voice"]).toBe("he-IL-Wavenet-A");
    expect(azure.calls.length).toBe(1);
    expect(google.calls[0]?.ssml.startsWith("<speak>")).toBe(true);
    expect(google.calls[0]?.ssml).not.toContain("mstts");
  });

  it("returns a device-fallback directive when every provider is down", async () => {
    const azure = new FakeProvider("azure").alwaysFail(500);
    const google = new FakeProvider("google").alwaysFail(503);
    const { app } = buildTestApp({ providers: [azure, google] });
    const plan = await processText(app, { text: SAMPLES.he, language: "he" });
    const res = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`);
    expect(res.status).toBe(200);
    expect(res.headers["x-tts-fallback"]).toBe("device");
    expect(res.body.fallback).toBe("device");
    expect(res.body.directive.hint.locale).toBe("he-IL");
    expect(res.body.directive.hint.gender).toBe("female");
    expect(res.body.directive.ssml).toContain('xml:lang="he-IL"');
    expect(res.body.directive.plainText).toContain("קילומטר לשעה");
    expect(res.body.directive.reason).toContain("azure");
    expect(res.body.directive.reason).toContain("google");
    expect(azure.calls.length).toBe(3);
    expect(google.calls.length).toBe(3);
  });

  it("opens the breaker after repeated failures so later chunks skip the dead provider", async () => {
    const azure = new FakeProvider("azure").alwaysFail(500);
    const google = new FakeProvider("google");
    const { app } = buildTestApp({ providers: [azure, google] });
    const plan = await processText(app, { text: SAMPLES.en, language: "en", maxChunkChars: 80 });
    await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`).expect(200);
    const azureCallsAfterFirst = azure.calls.length;
    expect(azureCallsAfterFirst).toBe(3);
    await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=1`).expect(200);
    expect(azure.calls.length).toBe(azureCallsAfterFirst);
    const health = await request(app).get("/health");
    expect(health.body.providers.azure).toBe(false);
    expect(health.body.providers.google).toBe(true);
  });

  it("rejects an unknown plan token and an out-of-range chunk", async () => {
    const { app } = buildTestApp();
    const missing = await request(app).get("/get-audio?planToken=plan_nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("E_NOT_FOUND");
    const plan = await processText(app, { text: "One sentence only.", language: "en" });
    const range = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=99`);
    expect(range.status).toBe(404);
  });

  it("expires a plan after its TTL", async () => {
    let now = 1_000_000;
    const { app } = buildTestApp({ overrides: { now: () => now } });
    const plan = await processText(app, { text: "One sentence only.", language: "en" });
    now += 31 * 60 * 1000;
    const res = await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("E_PLAN_EXPIRED");
  });
});

describe("preferences and user state", () => {
  it("stores accessibility preferences and applies them to later plans", async () => {
    const { app } = buildTestApp();
    const put = await request(app).put("/preferences/learner-9").send({ language: "ar", gender: "male", cadence: "slow", maxChunkChars: 100, wordHighlighting: false });
    expect(put.status).toBe(200);
    expect(put.body.gender).toBe("male");
    const get = await request(app).get("/preferences/learner-9");
    expect(get.body.cadence).toBe("slow");
    expect(get.body.wordHighlighting).toBe(false);
    const plan = await processText(app, { text: SAMPLES.ar, language: "ar", userId: "learner-9" });
    expect(plan.voice.gender).toBe("male");
    expect(plan.plan.maxChunkChars).toBe(100);
    expect(plan.voice.prosody.rate).toBeLessThan(0.85);
  });

  it("returns defaults for an unknown learner", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/preferences/nobody?language=ru");
    expect(res.status).toBe(200);
    expect(res.body.language).toBe("ru");
    expect(res.body.gender).toBe("female");
    expect(res.body.cadence).toBe("relaxed");
  });
});

describe("auth, validation and errors", () => {
  it("requires the api key when one is configured, on every route but /health", async () => {
    const { app } = buildTestApp({ env: { CLIENT_API_KEY: "s3cret" } });
    await request(app).get("/health").expect(200);
    const denied = await request(app).post("/process-text").send({ text: "hi there friend", language: "en" });
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe("E_UNAUTHORIZED");
    const wrong = await request(app).post("/process-text").set("x-api-key", "nope").send({ text: "hi there friend", language: "en" });
    expect(wrong.status).toBe(401);
    const ok = await request(app).post("/process-text").set("authorization", "Bearer s3cret").send({ text: "hi there friend", language: "en" });
    expect(ok.status).toBe(200);
  });

  it("rejects an unsupported language, empty text and malformed JSON with E_VALIDATION", async () => {
    const { app } = buildTestApp();
    const lang = await request(app).post("/process-text").send({ text: "Bonjour", language: "fr" });
    expect(lang.status).toBe(400);
    expect(lang.body.error.code).toBe("E_VALIDATION");
    expect(lang.body.error.details[0].path).toBe("language");
    const empty = await request(app).post("/process-text").send({ text: "", language: "en" });
    expect(empty.status).toBe(400);
    const malformed = await request(app).post("/process-text").set("content-type", "application/json").send("{not json");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("E_VALIDATION");
  });

  it("rejects text that is only markup or emoji", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/process-text").send({ text: "🎉🎉 ** **", language: "en" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("nothing left to speak");
  });

  it("returns 404 with a request id for unknown routes and echoes trace headers", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/nope").set("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(res.status).toBe(404);
    expect(res.headers["x-trace-id"]).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(res.headers["x-request-id"]).toBe(res.body.error.requestId);
  });

  it("allows native clients (no Origin) and configured web origins, and blocks others", async () => {
    const { app } = buildTestApp({ env: { CORS_ORIGINS: "https://lagstein1-png.github.io" } });
    const native = await request(app).get("/health");
    expect(native.headers["access-control-allow-origin"]).toBeUndefined();
    const allowed = await request(app).get("/health").set("origin", "https://lagstein1-png.github.io");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://lagstein1-png.github.io");
    const shell = await request(app).get("/health").set("origin", "capacitor://localhost");
    expect(shell.headers["access-control-allow-origin"]).toBe("capacitor://localhost");
    const blocked = await request(app).get("/health").set("origin", "https://evil.example");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes counters and latencies on /metrics", async () => {
    const { app } = buildTestApp();
    const plan = await processText(app, { text: SAMPLES.en, language: "en" });
    await request(app).get(`/get-audio?planToken=${plan.planToken}&chunk=0`).expect(200);
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.body.counters["tts.success.azure"]).toBe(1);
    expect(res.body.latencies["tts.provider.call"].count).toBe(1);
    expect(res.body.plans).toBe(1);
  });
});

function binaryParser(res: SuperagentResponse, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => {
    callback(null, Buffer.concat(chunks));
  });
  res.on("error", (err: Error) => {
    callback(err, Buffer.alloc(0));
  });
}
