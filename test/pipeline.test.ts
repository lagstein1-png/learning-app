import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeps, generateModule } from "../src/pipeline.ts";
import { LlmError } from "../src/llmClient.ts";
import { GenerateRequestSchema } from "../src/schemas.ts";
import { FakeClient, okModule, testConfig, toolCall } from "./helpers.ts";

const req = (o: Record<string, unknown> = {}) =>
  GenerateRequestSchema.parse({ module_type: "quiz", topic: "right of way at an unmarked junction", language: "en", ...o });

test("primary route returns a module: guardrails applied, cached, then served from cache", async () => {
  const gemini = new FakeClient("gemini", "g", [okModule()]);
  const deps = buildDeps(testConfig(), { routes: [gemini] });

  const first = await generateModule(req(), deps);
  assert.equal(first.meta.source, "gemini");
  assert.equal(first.meta.model, "g");
  assert.equal(first.payload.ui_metadata.degraded, false);
  assert.equal(first.payload.ui_metadata.layout, "quiz");
  assert.ok(first.payload.tts_optimized_payload.startsWith("<speak>"));
  assert.ok(first.payload.tts_optimized_payload.includes("The options are"));
  assert.equal(first.payload.ui_metadata.options.length, 4);
  assert.equal(first.meta.usage.input_tokens, 100);
  assert.equal(first.meta.budget.tokens_used_today, 150);

  const second = await generateModule(req({ topic: "Right-of-way at unmarked junctions" }), deps);
  assert.equal(second.meta.source, "cache");
  assert.equal(second.meta.cache.hit, true);
  assert.equal(gemini.calls.length, 1, "no second provider call");
  assert.ok(second.meta.latency_ms < 100);
  assert.equal(deps.ledger.snapshot().cache_saved_calls, 1);
});

test("tool routing: model asks for the calculator, result is fed back, module follows", async () => {
  const gemini = new FakeClient("gemini", "g", [
    toolCall("calculator", { expression: "48 * 12" }),
    (input) => {
      assert.ok(input.user.includes("48 * 12 = 576"), "tool result is in the follow-up prompt");
      return okModule({
        title: "Multiplication",
        raw_text: "A bus carries 48 people. 12 buses leave. How many people travel?",
        ui_metadata: { layout: "quiz", options: ["576", "560", "586", "480"], correct_index: 0, explanation: "48 times 12 is 576." },
      });
    },
  ]);
  const deps = buildDeps(testConfig(), { routes: [gemini] });
  const out = await generateModule(req({ module_type: "math_puzzle", topic: "multiplication word problems" }), deps);
  assert.equal(out.meta.source, "gemini");
  assert.equal(out.meta.tool_calls.length, 1);
  assert.equal(out.meta.tool_calls[0]?.result, "48 * 12 = 576");
  assert.equal(gemini.calls.length, 2);
  assert.equal(out.payload.ui_metadata.options[out.payload.ui_metadata.correct_index], "576");
});

test("fallback chain: primary 5xx -> secondary answers; all down -> local module, never an error", async () => {
  const gemini = new FakeClient("gemini", "g", [new LlmError("server", "gemini", "g", "HTTP 503", 503)]);
  const anthropic = new FakeClient("anthropic", "a", [okModule({ title: "from secondary" })]);
  const deps = buildDeps(testConfig(), { routes: [gemini, anthropic] });
  const out = await generateModule(req(), deps);
  assert.equal(out.meta.source, "anthropic");
  assert.equal(out.payload.title, "from secondary");
  assert.ok(out.meta.route_log.some((l) => l.startsWith("gemini:g: server 503")));

  const down = buildDeps(testConfig(), {
    routes: [
      new FakeClient("gemini", "g", [new LlmError("rate_limit", "gemini", "g", "429", 429)]),
      new FakeClient("anthropic", "a", [new LlmError("timeout", "anthropic", "a", "timed out")]),
    ],
  });
  const local = await generateModule(req({ topic: "roundabouts", bypass_cache: true }), down);
  assert.equal(local.meta.source, "local");
  assert.equal(local.payload.ui_metadata.degraded, true);
  assert.equal(local.payload.ui_metadata.layout, "quiz");
  assert.equal(local.payload.language_code, "en-US");
  assert.equal(local.meta.cache.key, null, "degraded modules are not cached");
});

test("invalid output earns one corrected retry on the same route; refusal moves on", async () => {
  const gemini = new FakeClient("gemini", "g", [
    new LlmError("invalid_output", "gemini", "g", "schema violation: module.raw_text: Too small"),
    (input) => {
      assert.ok(input.user.includes("previous output was rejected"));
      return okModule();
    },
  ]);
  const deps = buildDeps(testConfig(), { routes: [gemini] });
  assert.equal((await generateModule(req(), deps)).meta.source, "gemini");
  assert.equal(gemini.calls.length, 2);

  const refusing = new FakeClient("anthropic", "a", [new LlmError("refusal", "anthropic", "a", "model refused (other)")]);
  const second = new FakeClient("gemini", "g2", [okModule({ title: "second" })]);
  const deps2 = buildDeps(testConfig(), { routes: [refusing, second] });
  const out = await generateModule(req({ topic: "junction priority rules" }), deps2);
  assert.equal(out.payload.title, "second");
  assert.equal(deps2.router.status()[0]?.breaker, "closed", "a refusal does not trip the breaker");
});

test("circuit breaker opens after repeated availability failures and skips the route", async () => {
  const gemini = new FakeClient("gemini", "g", [
    new LlmError("server", "gemini", "g", "500", 500),
    new LlmError("server", "gemini", "g", "500", 500),
    okModule({ title: "should not be reached" }),
  ]);
  const anthropic = new FakeClient("anthropic", "a", [okModule({ title: "a1" }), okModule({ title: "a2" }), okModule({ title: "a3" })]);
  const deps = buildDeps(testConfig({ CIRCUIT_FAILURE_THRESHOLD: "2" }), { routes: [gemini, anthropic] });
  await generateModule(req({ topic: "topic one", bypass_cache: true }), deps);
  await generateModule(req({ topic: "topic two", bypass_cache: true }), deps);
  assert.equal(deps.router.status()[0]?.breaker, "open");
  const third = await generateModule(req({ topic: "topic three", bypass_cache: true }), deps);
  assert.equal(third.payload.title, "a3");
  assert.ok(third.meta.route_log.includes("gemini:g: skipped (circuit open)"));
  assert.equal(gemini.calls.length, 2);
});

test("budget exhausted: no provider is called, local module is served", async () => {
  const gemini = new FakeClient("gemini", "g", [okModule()]);
  const deps = buildDeps(testConfig({ DAILY_TOKEN_BUDGET: "10" }), { routes: [gemini] });
  const out = await generateModule(req(), deps);
  assert.equal(out.meta.source, "local");
  assert.equal(gemini.calls.length, 0);
  assert.ok(out.meta.route_log[0]?.startsWith("budget:"));
});

test("a draft in the wrong language or layout is rejected and replaced", async () => {
  const gemini = new FakeClient("gemini", "g", [okModule({ language_code: "es-ES" })]);
  const deps = buildDeps(testConfig(), { routes: [gemini] });
  const out = await generateModule(req({ bypass_cache: true }), deps);
  assert.equal(out.meta.source, "local");
  assert.ok(out.payload.guardrail_report.warnings.some((w) => w.includes("language_code es-ES != en-US")));

  const wrongLayout = new FakeClient("gemini", "g", [okModule({ ui_metadata: { layout: "explanation", options: [], correct_index: 0, explanation: null } })]);
  const deps2 = buildDeps(testConfig(), { routes: [wrongLayout] });
  const out2 = await generateModule(req({ bypass_cache: true }), deps2);
  assert.equal(out2.payload.ui_metadata.degraded, true);
});

test("unconfigured routes are skipped with a reason", async () => {
  const noKey = new FakeClient("gemini", "g", [okModule()], false);
  const deps = buildDeps(testConfig(), { routes: [noKey] });
  const out = await generateModule(req(), deps);
  assert.equal(out.meta.source, "local");
  assert.equal(out.meta.route_log[0], "gemini:g: skipped (no API key)");
});
