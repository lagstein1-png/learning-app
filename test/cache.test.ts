import { test } from "node:test";
import assert from "node:assert/strict";
import { CostLedger, InMemoryStore, SemanticCache, cosine, vectorise } from "../src/cacheService.ts";
import { GenerateRequestSchema, type LearningPayload } from "../src/schemas.ts";

const payload = (title: string): LearningPayload => ({
  title,
  raw_text: "x",
  tts_optimized_payload: "<speak>x</speak>",
  tts_plain_payload: "x",
  language_code: "en-US",
  voice_preference: "female_warm",
  ui_metadata: { layout: "explanation", options: [], options_tts: [], correct_index: 0, explanation: null, degraded: false },
  guardrail_report: { language_verified: true, detected_language: "en-US", hits: [], warnings: [] },
});
const req = (o: Record<string, unknown>) => GenerateRequestSchema.parse({ module_type: "explanation", language: "en", ...o });

function makeCache(now: () => number, threshold = 0.8, ttl = 60, max = 3) {
  return new SemanticCache({ enabled: true, threshold, ttlSeconds: ttl, store: new InMemoryStore(max, now), now });
}

test("cosine: paraphrases score high, unrelated topics score low", () => {
  const near = cosine(vectorise("right of way at an unmarked junction"), vectorise("right-of-way at unmarked junctions"));
  const far = cosine(vectorise("right of way at an unmarked junction"), vectorise("fractions with unlike denominators"));
  assert.ok(near > 0.8, `near=${near}`);
  assert.ok(far < 0.2, `far=${far}`);
  const he = cosine(vectorise("זכות קדימה בצומת ללא תמרורים"), vectorise("זְכוּת קדימה בצומת בלי תמרורים"));
  assert.ok(he > 0.8, `he=${he}`);
});

test("exact hit, semantic hit, and miss under threshold", async () => {
  let t = 1_000_000;
  const cache = makeCache(() => t);
  const a = req({ topic: "right of way at an unmarked junction" });
  assert.equal((await cache.lookup(a)).hit, false);
  await cache.store(a, payload("A"));

  const exact = await cache.lookup(a);
  assert.equal(exact.hit, true);
  assert.equal(exact.exact, true);
  assert.equal(exact.similarity, 1);

  const near = await cache.lookup(req({ topic: "Right-of-way at unmarked junctions" }));
  assert.equal(near.hit, true);
  assert.equal(near.exact, false);
  assert.ok((near.similarity ?? 0) >= 0.8);
  assert.equal(near.payload?.title, "A");

  const far = await cache.lookup(req({ topic: "fractions with unlike denominators" }));
  assert.equal(far.hit, false);
  assert.ok((far.similarity ?? 1) < 0.8);
});

test("partitions: language, module type and difficulty never cross", async () => {
  const cache = makeCache(() => 1);
  const a = req({ topic: "right of way at an unmarked junction" });
  await cache.store(a, payload("A"));
  assert.equal((await cache.lookup(req({ topic: a.topic, language: "es" }))).hit, false);
  assert.equal((await cache.lookup(req({ topic: a.topic, module_type: "quiz" }))).hit, false);
  assert.equal((await cache.lookup(req({ topic: a.topic, difficulty: "hard" }))).hit, false);
});

test("bypass_cache skips lookup; TTL expires; LRU evicts oldest", async () => {
  let t = 0;
  const cache = makeCache(() => t, 0.8, 10, 2);
  const a = req({ topic: "topic alpha one" });
  await cache.store(a, payload("A"));
  assert.equal((await cache.lookup(req({ topic: a.topic, bypass_cache: true }))).hit, false);
  assert.equal((await cache.lookup(a)).hit, true);
  t = 11_000;
  assert.equal((await cache.lookup(a)).hit, false, "expired after ttl");

  t = 20_000;
  await cache.store(req({ topic: "first entry" }), payload("1"));
  await cache.store(req({ topic: "second entry" }), payload("2"));
  await cache.store(req({ topic: "third entry" }), payload("3"));
  assert.equal((await cache.stats()).entries, 2);
  assert.equal((await cache.lookup(req({ topic: "first entry" }))).hit, false, "oldest evicted");
  assert.equal((await cache.lookup(req({ topic: "third entry" }))).hit, true);
});

test("semantic hit latency stays under 100ms with a full store", async () => {
  const cache = new SemanticCache({ enabled: true, threshold: 0.8, ttlSeconds: 60, store: new InMemoryStore(3000), now: Date.now });
  for (let i = 0; i < 2000; i++) await cache.store(req({ topic: `topic number ${i} about something ${i % 7}` }), payload(String(i)));
  await cache.store(req({ topic: "right of way at an unmarked junction" }), payload("target"));
  const t0 = performance.now();
  const hit = await cache.lookup(req({ topic: "right-of-way at unmarked junctions" }));
  const ms = performance.now() - t0;
  assert.equal(hit.payload?.title, "target");
  assert.ok(ms < 100, `lookup took ${ms.toFixed(1)}ms`);
});

test("ledger: tokens, budget gate, price table, and daily rollover", () => {
  let t = Date.UTC(2026, 8, 16, 12);
  const ledger = new CostLedger(1000, { "claude-haiku-4-5": { input_per_1m: 1, output_per_1m: 5 } }, () => t);
  assert.equal(ledger.canSpend(500), true);
  ledger.record("claude-haiku-4-5", { input_tokens: 400, output_tokens: 200 });
  ledger.record("gemini-3.6-flash", { input_tokens: 100, output_tokens: 100 });
  const s = ledger.snapshot();
  assert.equal(s.tokens_used_today, 800);
  assert.equal(s.remaining_tokens, 200);
  assert.equal(s.estimated_usd_today, null, "unknown price for one model => no total in USD");
  assert.equal(s.by_model["claude-haiku-4-5"]?.estimated_usd, 0.0014);
  assert.equal(ledger.canSpend(201), false);
  assert.equal(ledger.canSpend(200), true);
  t += 24 * 3600 * 1000;
  assert.equal(ledger.tokensUsedToday(), 0, "new UTC day resets");
  assert.equal(new CostLedger(0, {}).canSpend(1), false, "budget 0 disables paid routes");
});
