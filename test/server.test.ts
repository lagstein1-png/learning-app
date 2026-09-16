import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";
import { FakeClient, okModule, testConfig } from "./helpers.ts";

async function withServer(fn: (base: string, app: ReturnType<typeof createApp>) => Promise<void>, cfg: Record<string, string> = {}) {
  const app = createApp(testConfig(cfg), { routes: [new FakeClient("gemini", "g", [okModule(), okModule()])], log: () => {} });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn(base, app);
  } finally {
    await new Promise<void>((r) => app.server.close(() => r()));
  }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("generate: 200 with the rigid response shape and x-source header", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/v1/modules/generate", { module_type: "quiz", topic: "right of way", language: "en" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-source"), "gemini");
    const body = (await res.json()) as { payload: Record<string, unknown>; meta: Record<string, unknown> };
    for (const k of ["raw_text", "tts_optimized_payload", "tts_plain_payload", "language_code", "voice_preference", "ui_metadata", "guardrail_report"]) {
      assert.ok(k in body.payload, `payload.${k}`);
    }
    assert.equal(body.payload.language_code, "en-US");
    const again = await post(base, "/v1/modules/generate", { module_type: "quiz", topic: "right of way", language: "en" });
    assert.equal(again.headers.get("x-source"), "cache");
  });
});

test("validation errors are 400 with field paths; bad JSON 400; unknown route 404; body cap 413", async () => {
  await withServer(async (base) => {
    const bad = await post(base, "/v1/modules/generate", { module_type: "essay", topic: "x", language: "fr" });
    assert.equal(bad.status, 400);
    const j = (await bad.json()) as { error: { code: string; issues: { path: string }[] } };
    assert.equal(j.error.code, "validation");
    assert.deepEqual(j.error.issues.map((i) => i.path).sort(), ["language", "module_type", "topic"]);
    assert.equal((await post(base, "/v1/modules/generate", "{nope")).status, 400);
    assert.equal((await fetch(base + "/v1/nothing")).status, 404);
    const huge = await post(base, "/v1/modules/generate", { module_type: "quiz", topic: "x".repeat(70_000), language: "en" });
    assert.equal(huge.status, 413);
  });
});

test("health, budget, schema, cache stats and clear", async () => {
  await withServer(async (base) => {
    const h = (await (await fetch(base + "/v1/health")).json()) as { ok: boolean; routes: unknown[] };
    assert.equal(h.ok, true);
    assert.equal(h.routes.length, 1);
    const s = (await (await fetch(base + "/v1/schema")).json()) as { type: string };
    assert.equal(s.type, "object");
    await post(base, "/v1/modules/generate", { module_type: "quiz", topic: "fractions", language: "en" });
    assert.equal(((await (await fetch(base + "/v1/cache/stats")).json()) as { entries: number }).entries, 1);
    assert.equal((await fetch(base + "/v1/cache", { method: "DELETE" })).status, 200);
    assert.equal(((await (await fetch(base + "/v1/cache/stats")).json()) as { entries: number }).entries, 0);
    assert.equal(typeof ((await (await fetch(base + "/v1/budget")).json()) as { tokens_used_today: number }).tokens_used_today, "number");
  });
});

test("tts/prepare runs guardrails on client text", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/v1/tts/prepare", { text: 'המהירות היא 50 קמ"ש.', language: "he", options: ["כן", "לא"] });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { tts_plain_payload: string; language_code: string; options_tts: string[] };
    assert.ok(j.tts_plain_payload.includes("קילומטר לשעה"));
    assert.equal(j.language_code, "he-IL");
    assert.equal(j.options_tts.length, 2);
  });
});

test("rate limit returns 429 after the per-minute quota; CORS only for allowed origins", async () => {
  await withServer(
    async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await fetch(base + "/v1/health")).status);
      assert.deepEqual(statuses, [200, 200, 200, 429]);
    },
    { RATE_LIMIT_PER_MINUTE: "3" },
  );
  await withServer(
    async (base) => {
      const ok = await fetch(base + "/v1/health", { headers: { origin: "https://app.example" } });
      assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example");
      const no = await fetch(base + "/v1/health", { headers: { origin: "https://evil.example" } });
      assert.equal(no.headers.get("access-control-allow-origin"), null);
      const pre = await fetch(base + "/v1/modules/generate", { method: "OPTIONS", headers: { origin: "https://app.example" } });
      assert.equal(pre.status, 204);
    },
    { ALLOW_ORIGINS: "https://app.example" },
  );
});
