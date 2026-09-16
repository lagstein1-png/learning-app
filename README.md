# learning-app-tts

A multilingual, accessibility-first Text-to-Speech orchestration backend for
learners with dyslexia, ADHD and new immigrants. Four language tracks —
Hebrew, English, Arabic, Russian — with natural female neural voices by
default, contextual pre-processing by Gemini, a per-language pronunciation
dictionary, smart chunking for long read-aloud sessions, and a device
fallback so the learner always hears the text.

Node.js 20+, TypeScript strict, Express, Supabase, Winston/Morgan, Vitest,
multi-stage Docker.

```
mobile / PWA client
      │  POST /process-text  ──▶  plan (chunks · voice · prosody · planToken)
      │  GET  /get-audio     ──▶  audio/mpeg stream, one chunk or the whole plan
      ▼
┌──────────────────────────── orchestration graph ───────────────────────────┐
│ preprocess ─▶ dictionary ─▶ emphasis ─▶ voice ─▶ chunk ─▶ END              │
│   Gemini +      Supabase      locate      gender ▸   sentence-aware         │
│   rule layer    overrides     phrases     provider ▸ segments + offsets     │
│                                          rank                               │
└─────────────────────────────────────────────────────────────────────────────┘
      ▼ per chunk, on demand
┌──────────────────────────────── audio engine ──────────────────────────────┐
│ cache ─▶ Azure Neural ─▶ Google Neural2/WaveNet ─▶ device-fallback directive│
│ token bucket · concurrency gate · full-jitter backoff · circuit breaker     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
cp .env.example .env        # fill in the keys you have; every provider is optional
npm ci
npm run dev                 # http://localhost:8080
npm run check               # typecheck + lint + tests
```

Without any credentials the service still runs: pre-processing uses the
deterministic rule layer, the dictionary and preferences live in memory, and
`/get-audio` answers with a device-fallback directive that tells the client
which on-device voice to use and what SSML/plain text to speak.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/process-text` | Run the pipeline. Body: `{ text, language, userId?, gender?, cadence?, mood?, domain?, maxChunkChars?, skipAi? }`. Returns the pre-processing result, applied overrides, the chosen voice with prosody and a device hint, the chunk plan and a `planToken`. |
| `GET` | `/get-audio?planToken=…` | Stream the whole plan as one `audio/mpeg` body (chunks in order, `x-tts-chunks` header, `x-tts-completed-chunks` trailer). |
| `GET` | `/get-audio?planToken=…&chunk=N` | One chunk as `audio/mpeg`, with `x-tts-provider`, `x-tts-voice`, `x-tts-cached` headers — the recommended path for mobile clients that want per-chunk highlighting. |
| `POST` | `/dictionary-override` | Create or update a pronunciation override: `{ language, term, spokenForm, ipa?, userId?, domain? }`. Omit `userId` for a global override. |
| `GET` | `/dictionary-override?language=he&userId=…` | Global overrides plus the learner's. |
| `DELETE` | `/dictionary-override/:id?language=he&userId=…` | Remove one. |
| `GET` / `PUT` | `/preferences/:userId` | Learner accessibility preferences (language, gender, cadence, mood, max chunk size, word highlighting). |
| `GET` | `/voices?language=ar` | The neural voice catalogue. |
| `GET` | `/health` | Languages, provider breaker state, whether Gemini and Supabase are configured. |
| `GET` | `/metrics` | Counters and p50/p95 latencies per span. |

Authentication: set `CLIENT_API_KEY` and clients send it as `x-api-key` (or
`Authorization: Bearer …`). `/health` is always open. Learner identity comes
from `userId` in the body/query or the `x-user-id` header.

Device fallback: when no cloud provider can produce audio, `/get-audio`
returns `200` with header `x-tts-fallback: device` and a JSON body
`{ fallback: "device", chunkIndex, directive: { reason, hint, ssml, plainText } }`.
`hint` carries locale, gender, rate, pitch and preferred on-device voice
names, best first. The client speaks `plainText` (or `ssml` where the engine
accepts it) with those settings.

Errors are always `{ error: { code, message, requestId, details? } }` with a
stable `code` (`E_VALIDATION`, `E_UNAUTHORIZED`, `E_NOT_FOUND`,
`E_PLAN_EXPIRED`, `E_RATE_LIMITED`, `E_PROVIDER_UNAVAILABLE`,
`E_PREPROCESS_FAILED`, `E_STORAGE`, `E_INTERNAL`). Every response carries
`x-request-id` and `x-trace-id`; an incoming W3C `traceparent` is honoured.

## Subsystems

**Linguistic pre-processing** (`src/services/preprocessor.ts`). A rule layer
always runs: NFC normalisation, zero-width/emoji/markdown removal, URL
neutralisation, punctuation spacing, gershayim → ASCII quotes, coarse mood.
When `GEMINI_API_KEY` is set, Gemini (`@google/genai`, JSON-schema
constrained) returns cleaned text, context, mood, emphasis phrases,
resolved homographs and per-text phonetic annotations. The reply is validated
with zod and sanity-checked for length drift and script change; any failure
falls back to the rule layer with `source: "rules"`.

**Pronunciation dictionary** (`src/services/dictionary.ts`). Overrides are
matched on Unicode-aware word boundaries (Hebrew clitic prefixes such as
ו/ב/ל/ה are preserved), longer terms first, learner rows beating global rows
beating AI annotations. Overrides with IPA become `<phoneme>` tags. A seed
dictionary for the four languages ships in `src/config/seedDictionary.ts`
and in the SQL migration.

**Voice selector** (`src/services/voiceSelector.ts`). Ordering is a sort,
not a score: gender preference, then provider availability in configured
order, then catalogue rank. Female voices rank first in every language
(Hila, Jenny/Aria, Salma/Zariyah, Svetlana/Dariya). Cadence presets
(`slow`, `relaxed`, `natural`, `brisk`) and moods map to rate, pitch, pauses
and — where the voice supports it — an Azure speaking style.

**Chunker** (`src/services/chunker.ts`). Paragraph → sentence (language
terminators, including `؟` and `׃`; never on decimals) → clause → whitespace,
packed up to `maxChunkChars` (80–600, default 320). Every chunk carries
source offsets for highlighting, an estimated duration and a cache key
derived from language, voice, prosody and text.

**Audio engine** (`src/services/audioEngine.ts`). Azure Speech REST and
Google Cloud TTS REST via `fetch`, no SDKs. Each call goes through a token
bucket + concurrency gate, a timeout, full-jitter exponential backoff on
transient errors (408/429/5xx/network), and a per-provider circuit breaker.
Audio is cached in memory (LRU) and, when configured, in Supabase.
Streaming keeps one chunk of look-ahead in flight.

**Observability** (`src/services/observability.ts`). Winston JSON logs with
`trace_id`, `span_id`, `service.name`, `duration_ms`, `error.code`; Morgan
access logs routed through the same logger; `AsyncLocalStorage` request
context; spans for every graph node and provider call; `/metrics` for
counters and latency percentiles.

## Configuration

See `.env.example`. Everything is validated at start-up (`src/config/env.ts`).
Product constants — language matrix, voice catalogue, cadence and mood
presets, limits — live in `src/config/constants.ts`.

| Variable | Notes |
|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Google AI Studio key; default model `gemini-2.5-flash`. Leave empty to run rule-based only. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Apply `supabase/migrations/0001_init.sql` first. Leave empty for in-memory stores. |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | Azure AI Speech. |
| `GOOGLE_TTS_API_KEY` | Google Cloud Text-to-Speech API key. |
| `TTS_PROVIDER_ORDER` | `azure,google` by default. |
| `TTS_RATE_LIMIT_RPM`, `TTS_MAX_CONCURRENCY`, `TTS_MAX_RETRIES`, `TTS_TIMEOUT_MS` | Outbound resilience. |
| `CORS_ORIGINS` | Web/PWA origins. Native apps (no `Origin`) and Capacitor/Ionic shells are always allowed. |
| `CLIENT_API_KEY` | Shared secret for mobile builds. |

## Tests

```bash
npm test                    # 74 tests, no network, no credentials
npm run test:coverage
```

`tests/tts.test.ts` drives the HTTP surface end to end with fake providers
and a fake model: all four language tracks, dictionary precedence, the
Gemini contract and its failure modes (transient errors, drift, language
switch), single-chunk and streamed audio, caching, retry with backoff,
provider fallback, breaker behaviour, device fallback, preferences, auth,
validation and CORS. The other files cover the chunker, the dictionary
rewrite, the state graph, retry/rate-limit/cache primitives, SSML and voice
selection.

## Docker

```bash
npm run docker:build
npm run docker:run          # reads .env, serves on :8080
```

The image is three stages (production deps → typecheck + build → alpine
runtime), runs as a non-root user, exposes a `HEALTHCHECK` on `/health`,
and shuts down cleanly on `SIGTERM`.

## Layout

```
src/
  app.ts                    assembly, CORS, middleware, routes
  server.ts                 process entry, graceful shutdown
  config/constants.ts       language matrix, voice catalogue, presets, limits
  config/env.ts             validated environment → AppConfig
  config/seedDictionary.ts  shipped pronunciation overrides
  orchestration/graph.ts    typed state graph (LangGraph-style)
  orchestration/pipeline.ts the TTS graph + plan store
  services/preprocessor.ts  rule layer + Gemini
  services/dictionary.ts    override stores + text rewrite
  services/voiceSelector.ts gender/provider/rank ordering, prosody
  services/chunker.ts       sentence-aware segmentation
  services/audioEngine.ts   providers, rate limit, retry, breaker, cache
  services/audioCache.ts    memory LRU + Supabase tier
  services/userState.ts     accessibility preferences
  services/observability.ts winston/morgan/spans/metrics
  services/supabase.ts      typed client + row validators
  routes/tts.ts             HTTP handlers
  middleware/               request context, api-key auth, error boundary
  utils/                    retry, rate limiter, ssml, text, hash, errors
tests/                      vitest suites + fakes
supabase/migrations/        schema + seed
```
