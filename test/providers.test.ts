/**
 * The real provider clients against fake HTTP: proves the request shape
 * (structured-output settings, headers) and the error mapping without a key
 * that reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicClient, GeminiClient, LlmError, type FetchLike } from "../src/llmClient.ts";
import { moduleDraft } from "./helpers.ts";

const moduleJson = JSON.stringify({ kind: "module", module: moduleDraft(), tool_call: null });
const never = new AbortController().signal;

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): FetchLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

test("gemini: sends responseSchema + JSON mime, reads candidates and usage", async () => {
  const fetchImpl = fakeFetch(() => ({
    status: 200,
    body: {
      candidates: [{ content: { parts: [{ text: moduleJson }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 123 },
    },
  }));
  const client = new GeminiClient({ apiKey: "k", model: "gemini-3.6-flash", fetchImpl });
  const out = await client.call({ system: "S", user: "U", maxTokens: 500 }, never);
  assert.equal(out.output.kind, "module");
  assert.deepEqual(out.usage, { input_tokens: 321, output_tokens: 123 });
  const call = fetchImpl.calls[0]!;
  assert.ok(call.url.endsWith("/v1beta/models/gemini-3.6-flash:generateContent"));
  assert.equal((call.init.headers as Record<string, string>)["x-goog-api-key"], "k");
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema.type, "object");
  assert.equal(body.systemInstruction.parts[0].text, "S");
  assert.equal(body.contents[0].parts[0].text, "U");
});

test("gemini: error mapping (429, 401, 500, safety block, truncated, non-JSON)", async () => {
  const mk = (status: number, body: unknown) => new GeminiClient({ apiKey: "k", model: "m", fetchImpl: fakeFetch(() => ({ status, body })) });
  const kind = async (c: GeminiClient) => {
    try {
      await c.call({ system: "S", user: "U", maxTokens: 10 }, never);
      return "ok";
    } catch (e) {
      return (e as LlmError).kind;
    }
  };
  assert.equal(await kind(mk(429, {})), "rate_limit");
  assert.equal(await kind(mk(401, {})), "auth");
  assert.equal(await kind(mk(500, {})), "server");
  assert.equal(await kind(mk(404, {})), "bad_request");
  assert.equal(await kind(mk(200, { promptFeedback: { blockReason: "SAFETY" } })), "refusal");
  assert.equal(await kind(mk(200, { candidates: [{ content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" }] })), "invalid_output");
  assert.equal(await kind(mk(200, { candidates: [{ content: { parts: [{ text: "```json {}```" }] }, finishReason: "STOP" }] })), "invalid_output");
  assert.equal(await kind(new GeminiClient({ apiKey: "", model: "m" })), "no_key");
});

test("gemini: abort maps to timeout", async () => {
  const fetchImpl: FetchLike = (_u, init) =>
    new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const client = new GeminiClient({ apiKey: "k", model: "m", fetchImpl });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(client.call({ system: "S", user: "U", maxTokens: 10 }, ctl.signal), (e: LlmError) => e.kind === "timeout");
});

test("anthropic: uses output_config.format, prompt-cached system, and maps stop reasons", async () => {
  const fetchImpl = fakeFetch((url, init) => {
    const body = JSON.parse(String(init.body));
    assert.ok(url.endsWith("/v1/messages"));
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.output_config.effort, "low");
    assert.equal(body.system[0].cache_control.type, "ephemeral");
    return {
      status: 200,
      body: {
        id: "msg_1", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: moduleJson }],
        stop_reason: "end_turn", stop_sequence: null, stop_details: null,
        usage: { input_tokens: 11, output_tokens: 22 },
      },
    };
  });
  const client = new AnthropicClient({ apiKey: "k", model: "claude-opus-5", fetchImpl, timeoutMs: 2000 });
  const out = await client.call({ system: "S", user: "U", maxTokens: 500 }, never);
  assert.equal(out.output.kind, "module");
  assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 22 });

  const refusing = new AnthropicClient({
    apiKey: "k", model: "claude-haiku-4-5", timeoutMs: 2000,
    fetchImpl: fakeFetch((_u, init) => {
      assert.equal(JSON.parse(String(init.body)).output_config.effort, undefined, "haiku gets no effort");
      return {
        status: 200,
        body: { id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: "refusal",
          stop_sequence: null, stop_details: { type: "refusal", category: "other", explanation: null }, usage: { input_tokens: 1, output_tokens: 0 } },
      };
    }),
  });
  await assert.rejects(refusing.call({ system: "S", user: "U", maxTokens: 10 }, never), (e: LlmError) => e.kind === "refusal");

  const limited = new AnthropicClient({ apiKey: "k", model: "claude-opus-5", timeoutMs: 2000,
    fetchImpl: fakeFetch(() => ({ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } })) });
  await assert.rejects(limited.call({ system: "S", user: "U", maxTokens: 10 }, never), (e: LlmError) => e.kind === "rate_limit" && e.status === 429);
});
