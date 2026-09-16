import { test } from "node:test";
import assert from "node:assert/strict";
import { convertUnit, dateDiffDays, evaluateExpression, executeTool } from "../src/tools.ts";
import { LlmOutputSchema, UiMetadataSchema, llmOutputGeminiSchema } from "../src/schemas.ts";

test("calculator: precedence, right-assoc power, functions, percent, unicode operators", () => {
  assert.equal(evaluateExpression("2 + 3 * 4"), 14);
  assert.equal(evaluateExpression("2 ^ 3 ^ 2"), 512);
  assert.equal(evaluateExpression("-(2 + 3) * 2"), -10);
  assert.equal(evaluateExpression("sqrt(144) + round(10/3, 2)"), 15.33);
  assert.equal(evaluateExpression("1,200 × 25%"), 300);
  assert.equal(evaluateExpression("10 ÷ 4"), 2.5);
  assert.equal(evaluateExpression("max(1, 7, 3) - min(2, 9)"), 5);
  assert.throws(() => evaluateExpression("1/0"), /division by zero/);
  assert.throws(() => evaluateExpression("2 +"), /unexpected end/);
  assert.throws(() => evaluateExpression("process.exit(1)"), /unknown identifier|unexpected|bad number/);
  assert.throws(() => evaluateExpression("1 $ 2"), /unexpected character/);
});

test("unit_convert and date_diff", () => {
  assert.equal(convertUnit(90, "km/h", "m/s"), 25);
  assert.equal(Math.round(convertUnit(100, "f", "c") * 100) / 100, 37.78);
  assert.equal(convertUnit(1.5, "km", "m"), 1500);
  assert.throws(() => convertUnit(1, "kg", "m"), /cannot convert/);
  assert.throws(() => convertUnit(1, "parsec", "m"), /unknown unit/);
  assert.equal(dateDiffDays("2026-01-01", "2026-09-16"), 258);
  assert.equal(dateDiffDays("2026-03-01", "2026-02-27"), -2);
});

test("executeTool validates arguments and never throws", () => {
  assert.equal(executeTool({ name: "calculator", arguments_json: "not json", reason: "r" }).ok, false);
  assert.equal(executeTool({ name: "unit_convert", arguments_json: '{"value":"x"}', reason: "r" }).ok, false);
  assert.equal(executeTool({ name: "date_diff", arguments_json: '{"from":"01/01/2026","to":"2026-02-01"}', reason: "r" }).ok, false);
  const ok = executeTool({ name: "calculator", arguments_json: '{"expression":"7*8"}', reason: "r" });
  assert.equal(ok.ok, true);
  assert.equal(ok.result, "7*8 = 56");
});

test("schemas: quiz invariants and envelope discriminator are enforced", () => {
  assert.equal(UiMetadataSchema.safeParse({ layout: "quiz", options: ["a"], correct_index: 0, explanation: null }).success, false);
  assert.equal(UiMetadataSchema.safeParse({ layout: "quiz", options: ["a", "b"], correct_index: 2, explanation: null }).success, false);
  assert.equal(UiMetadataSchema.safeParse({ layout: "quiz", options: ["a", "A "], correct_index: 0, explanation: null }).success, false);
  assert.equal(UiMetadataSchema.safeParse({ layout: "explanation", options: ["a", "b"], correct_index: 0, explanation: null }).success, false);
  assert.equal(UiMetadataSchema.safeParse({ layout: "explanation", options: [], correct_index: 0, explanation: "why" }).success, true);
  assert.equal(LlmOutputSchema.safeParse({ kind: "module", module: null, tool_call: null }).success, false);
  assert.equal(LlmOutputSchema.safeParse({ kind: "tool_call", module: null, tool_call: { name: "calculator", arguments_json: "{}", reason: "x" } }).success, true);
  assert.equal(LlmOutputSchema.safeParse({ kind: "tool_call", module: null, tool_call: { name: "web_search", arguments_json: "{}", reason: "x" } }).success, false);
});

test("gemini responseSchema is an OpenAPI subset (no anyOf, no additionalProperties, nullable flags)", () => {
  const s = JSON.stringify(llmOutputGeminiSchema());
  assert.ok(!s.includes("anyOf"));
  assert.ok(!s.includes("additionalProperties"));
  assert.ok(!s.includes("$schema"));
  assert.ok(s.includes('"nullable":true'));
  assert.ok(s.includes('"propertyOrdering"'));
});
