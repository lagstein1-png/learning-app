# Accessible AI Learning Backend

A small, auditable Node.js + TypeScript backend that turns LLM output into
learning modules a mobile client can show **and read aloud** to people with
dyslexia, ADHD, low reading fluency or a screen reader. Four languages are
first-class: Hebrew (`he-IL`), English (`en-US`), Spanish (`es-ES`), Arabic
(`ar-XA`).

Every request runs through one execution stream:

```
validate ─► semantic cache ─► prompt ─► provider routes ─► local fallback ─► guardrails ─► rigid validation ─► cache
             (Layer C)        (A)       (A + D)             (D)               (B)
```

| Layer | File | What it does |
|---|---|---|
| A. Model call & structured output | `src/llmClient.ts`, `src/prompts.ts`, `src/schemas.ts` | Gemini (`responseSchema`, JSON mime) and Anthropic (`messages.parse` + `output_config.format` from the same Zod schema). The model can only emit a module **or** a tool invocation. No markdown fences, no prose. |
| B. Pronunciation guardrails | `src/guardrails.ts` | Deterministic middleware. Abbreviations spelled out, math symbols read as words, label numbers spelled digit by digit, Hebrew nikud / Arabic tashkeel on ambiguous words, breathing pauses as SSML-lite `<break/>`, language code verified against the script of the text. Every change is recorded in `guardrail_report.hits`. |
| C. Semantic cache & budgets | `src/cacheService.ts` | Hashed word + character-trigram vectors, cosine similarity, hard partitions by language / module type / difficulty. LRU + TTL in memory behind a `CacheStore` interface (a Redis adapter implements the same five methods). Token ledger per UTC day, USD only when a price table is configured. |
| D. Tools & fallbacks | `src/tools.ts`, `src/fallback.ts`, `src/llmClient.ts` (`Router`) | `calculator` (hand-written parser, no `eval`), `unit_convert`, `date_diff`. Ordered routes with per-route circuit breakers; any failure moves to the next route inside the same request; the final route is an offline generator that always answers and marks itself `degraded: true`. |
| HTTP edge | `src/server.ts` | `node:http`, JSON only, rate limit, CORS allow-list, 64 KB body cap, structured error envelope. |

Dependencies at runtime: `zod` and `@anthropic-ai/sdk`. Nothing else.

## Run

```bash
npm install
cp .env.example .env          # put GEMINI_API_KEY and/or ANTHROPIC_API_KEY in .env, never in code
npm run dev                   # node src/server.ts (Node 22.18+ strips types natively)

npm test                      # 39 tests, no network, ~1s
npm run typecheck
npm run build && npm start    # compiled to dist/
node scripts/smoke.ts         # one request per language and module type
```

Without any key the server still answers every request from the local
fallback and says so (`meta.source: "local"`, `ui_metadata.degraded: true`).

## Endpoints

### `POST /v1/modules/generate`

```json
{
  "module_type": "quiz",
  "topic": "זכות קדימה בצומת ללא תמרורים",
  "language": "he",
  "difficulty": "medium",
  "context": "",
  "learner_profile": { "dyslexia": true, "screen_reader": false, "reading_level": "simple", "age_group": "adult" },
  "voice_preference": "male_clear",
  "bypass_cache": false
}
```

`module_type`: `quiz` · `explanation` · `driving_scenario` · `math_puzzle` · `flashcard`.
`language`: `he` `en` `es` `ar` or a full code.

Response (`GenerateResponseSchema`):

```json
{
  "payload": {
    "title": "…",
    "raw_text": "short paragraphs separated by blank lines",
    "tts_optimized_payload": "<speak>… <break time=\"350ms\"/> … <say-as interpret-as=\"characters\">615</say-as> …</speak>",
    "tts_plain_payload": "same text with every tag removed (for Web Speech)",
    "language_code": "he-IL",
    "voice_preference": "male_clear",
    "ui_metadata": {
      "layout": "quiz",
      "options": ["…", "…", "…", "…"],
      "options_tts": ["…"],
      "correct_index": 2,
      "explanation": "…",
      "degraded": false
    },
    "guardrail_report": { "language_verified": true, "detected_language": "he-IL", "hits": [{ "rule": "he.abbr", "from": "קמ\"ש", "to": "קילומטר לשעה" }], "warnings": [] }
  },
  "meta": {
    "request_id": "…", "source": "gemini | anthropic | local | cache", "model": "gemini-3.6-flash",
    "latency_ms": 812,
    "cache": { "hit": false, "similarity": 0.41, "key": "…" },
    "tool_calls": [{ "name": "calculator", "arguments": { "expression": "48*12" }, "ok": true, "result": "48*12 = 576" }],
    "route_log": ["gemini:gemini-3.6-flash: ok in 790ms (attempt 1)"],
    "usage": { "input_tokens": 1421, "output_tokens": 233 },
    "budget": { "tokens_used_today": 1654, "daily_token_budget": 2000000, "estimated_usd_today": null }
  }
}
```

Other routes: `POST /v1/tts/prepare` (guardrails only, for text the client already
has), `GET /v1/health`, `GET /v1/cache/stats`, `DELETE /v1/cache`,
`GET /v1/budget`, `GET /v1/schema` (the model contract as JSON Schema).

Errors: `{ "error": { "code": "validation", "message": "…", "issues": [{ "path": "language", "message": "…" }], "request_id": "…" } }`
with status 400 / 404 / 413 / 429 / 500.

## Route order and fallbacks

`PRIMARY_PROVIDER=gemini` (default): `gemini:GEMINI_MODEL` → `anthropic:ANTHROPIC_FALLBACK_MODEL` → local.
`PRIMARY_PROVIDER=anthropic`: `anthropic:ANTHROPIC_MODEL` → `gemini:GEMINI_MODEL` → local.

A route is skipped when it has no key, when its circuit breaker is open
(`CIRCUIT_FAILURE_THRESHOLD` consecutive availability failures, for
`CIRCUIT_COOLDOWN_MS`), or when the daily token budget is exhausted. Refusals
and schema violations do not trip the breaker; a schema violation earns one
corrected retry on the same route. `meta.route_log` tells the story of each
request.

## Guardrail rules (Layer B) at a glance

| Rule family | he | en | es | ar |
|---|---|---|---|---|
| Abbreviations | קמ"ש ק"מ ס"מ ק"ג ד"ר וכו' עמ' מס' ש"ח … | e.g. i.e. etc. km/h mph Dr. No. a.m./p.m. … | p. ej. km/h Sr. Sra. núm. pág. EE. UU. … | كم/س، د.، إلخ، وحدات بعد الأرقام |
| Units after numbers | via abbreviations | km m cm kg h min s | km m cm kg h min s | كم م سم كغ د ث |
| Math & symbols | כפול חלקי ועוד פחות שווה בריבוע שורש אחוז מעלות | times, divided by, plus, minus, equals, squared, … | por, entre, más, menos, es igual a, … | ضرب، على، زائد، ناقص، يساوي، … |
| Ranges `50-70` | 50 עד 70 | 50 to 70 | de 50 a 70 | من 50 إلى 70 |
| Label numbers after "sign / bus / page …" | spelled digit by digit (`<say-as characters>`) | same | same | same |
| Phonetic stabilisation | nikud dictionary + context rules (from תאוריה מדברת `speech-rules.json`) | Latin acronyms spelled | decimal comma | tashkeel dictionary, tatweel removed |
| Cadence | 350 ms between sentences, 650 ms between paragraphs, 500 ms after "the answer is…", comma before a connective in sentences over 14 words, 400 ms between quiz options | | | |

Display text keeps the original spelling; only the TTS string is rewritten.

## Configuration

See `.env.example`. Keys are read from the environment only. `PRICE_TABLE_JSON`
is optional: without it the ledger reports tokens and `estimated_usd_today`
is `null`; it never guesses a price.

## Layout

```
src/
  config.ts        env → validated Config (zod)
  schemas.ts       every contract; JSON Schema and Gemini responseSchema exports
  guardrails.ts    Layer B
  cacheService.ts  Layer C: SemanticCache, InMemoryStore, CostLedger
  tools.ts         Layer D: calculator, unit_convert, date_diff
  llmClient.ts     Layer A/D: GeminiClient, AnthropicClient, CircuitBreaker, Router
  prompts.ts       stable system prompt + per-request user message
  fallback.ts      offline module generator (route of last resort)
  pipeline.ts      generateModule(): the unified stream; buildDeps() wiring
  server.ts        HTTP edge
test/              node:test suites (guardrails, cache, tools, providers, pipeline, server)
scripts/smoke.ts   end-to-end smoke run
```
