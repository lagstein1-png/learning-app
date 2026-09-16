/**
 * Smoke run: boots the app in-process on an ephemeral port and requests one
 * module per language and module type. Works with no API keys (every answer
 * then comes from the local fallback and says so); with keys it exercises the
 * real routes. Prints one line per request and exits non-zero on any failure.
 *
 *   node scripts/smoke.ts
 */
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";

const cases = [
  { module_type: "quiz", topic: "זכות קדימה בצומת ללא תמרורים", language: "he" },
  { module_type: "math_puzzle", topic: "two-digit multiplication", language: "en", difficulty: "medium" },
  { module_type: "explanation", topic: "las fracciones equivalentes", language: "es" },
  { module_type: "driving_scenario", topic: "الدوار والأولوية", language: "ar" },
  { module_type: "flashcard", topic: "photosynthesis", language: "en" },
  { module_type: "quiz", topic: "Right of way at a junction without signs", language: "he" }, // cache-adjacent to the first
] as const;

const app = createApp(loadConfig({ ...process.env, PORT: "0" }), { log: () => {} });
await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
let failed = 0;

for (const c of cases) {
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/modules/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(c),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    failed++;
    console.log(`FAIL ${res.status} ${c.language} ${c.module_type}: ${await res.text()}`);
    continue;
  }
  const j = (await res.json()) as { payload: { tts_plain_payload: string; ui_metadata: { degraded: boolean; options: string[] } }; meta: { source: string; model: string | null; cache: { hit: boolean; similarity: number | null }; tool_calls: unknown[] } };
  console.log(
    `${c.language.padEnd(2)} ${c.module_type.padEnd(16)} ${j.meta.source.padEnd(9)} ${String(j.meta.model ?? "-").padEnd(18)} ${String(ms).padStart(5)}ms` +
      ` cache=${j.meta.cache.hit ? `hit(${j.meta.cache.similarity})` : "miss"} tools=${j.meta.tool_calls.length} degraded=${j.payload.ui_metadata.degraded}` +
      `\n     ${j.payload.tts_plain_payload.slice(0, 110)}`,
  );
}

const health = (await (await fetch(`${base}/v1/health`)).json()) as { routes: { route: string; configured: boolean; breaker: string }[]; budget: { tokens_used_today: number } };
console.log("\nroutes:", health.routes.map((r) => `${r.route}${r.configured ? "" : " (no key)"} [${r.breaker}]`).join(", "));
console.log("tokens used today:", health.budget.tokens_used_today);
await new Promise<void>((r) => app.server.close(() => r()));
process.exit(failed ? 1 : 0);
