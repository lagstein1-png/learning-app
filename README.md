# Multilingual TTS Learning Backend

A Python backend for a mobile learning app whose core feature is read-aloud
text in four languages (English, Hebrew, Spanish, Arabic) for learners who
struggle with reading: dyslexia, ADHD, new immigrants, older adults.

It is built on three pillars of the Claude ecosystem, in one process:

| Pillar | Package | What it does here |
|---|---|---|
| **Claude API** | `anthropic` | Pre-processes raw text for TTS: simplifies it, adds pronunciation marks (nikud, tashkeel, accents), emits SSML with natural pacing. Structured output, adaptive thinking, prompt caching, refusal fallbacks. |
| **Claude Agent SDK** | `claude-agent-sdk` | A stateful, patient learning coach that reads one sentence at a time, explains flagged words, asks one gentle check question, and tracks progress through in-process MCP tools. |
| **MCP** | `mcp` | `learning_materials_mcp`: a read-only server that serves study texts from a directory, used both by the pipeline (Python client) and by the coach (Agent SDK spawns it). |

```
materials/ ──MCP stdio──► MaterialsClient ──► TTSPreprocessor ──► TTSScript ──► LearningSession
                                                    │  (Claude API / Agent SDK / local)     │
                                                    └──── coach tool simplify_sentence ◄────┤
                                                                                            ▼
                                       LearningAgent (Claude Agent SDK) ◄── coach MCP tools (in-process)
                                                │                     ◄── materials MCP server (stdio)
                                                ▼
                                       CoachReply: text + voice-ready SSML
```

## Quick start

```bash
./setup.sh                     # venv + dependencies + .env
source .venv/bin/activate
pytest -q                      # 48 offline tests, no network, ~3 s
python main.py                 # end-to-end run on the Hebrew sample
python main.py --material en/photosynthesis.md
python main.py --backend local --skip-agent   # fully offline dry run
```

Credentials: put `ANTHROPIC_API_KEY` in `.env` for the production path. On a
machine logged in to Claude Code, leave it empty: pre-processing then runs
through the Agent SDK, which reuses that login (`PREPROCESS_BACKEND=auto`).

## Layout

```
main.py                              end-to-end pipeline with staged console output
tts_backend/
  config.py                          Settings from env / .env
  languages.py                       four languages: script detection, voice ranking, pronunciation rules
  preprocess/                        STEP 2  Claude API pre-processing
    schema.py                        TTSScriptDraft (model output) / TTSScript (system object)
    prompts.py                       frozen system prompt + per-request user message
    backends.py                      AnthropicBackend · AgentSdkBackend · LocalBackend
    preprocessor.py                  validate → route → verify → fall back → cache
    ssml.py                          sentence split, SSML sanitiser (whitelist), local SSML
  agent/                             STEP 3  Claude Agent SDK learning coach
    state.py                         LearningSession + atomic JSON SessionStore
    tools.py                         8 coach tools as an in-process MCP server
    prompts.py                       coach system prompt (speech-safe behaviour rules)
    learning_agent.py                ClaudeSDKClient wrapper: start / send / flag_word
    voice.py                         coach reply → voice-ready SSML, no second model call
  mcp_server/                        STEP 4  MCP
    materials_server.py              learning_materials_mcp (MCPServer, stdio)
    client.py                        MaterialsClient (Python) + config for the Agent SDK
materials/{en,he,es,ar}/             sample study texts with front matter
tests/                               offline suite (fake HTTP API, in-memory MCP, stdio MCP)
```

## Data contracts

`TTSScript` is the one object that crosses all three pillars:

```json
{
  "language": "he", "bcp47": "he-IL", "direction": "rtl",
  "title": "מחזור המים", "reading_level": "simple",
  "voice": {"gender": "female", "rate": 0.9, "pitch": "default", "style": "calm"},
  "segments": [
    {"index": 0, "original": "…source sentence…", "simplified": "…display text…",
     "speech": "…with nikud / tashkeel, numbers as words…",
     "ssml": "<s><prosody rate=\"90%\">…<break time=\"300ms\"/>…</prosody></s>",
     "pause_after_ms": 600, "key_terms": ["תהליך"]}
  ],
  "glossary": [{"term": "מתעבים", "simple_meaning": "…", "pronunciation": "מִתְעַבִּים"}],
  "source": "anthropic", "degraded": false, "warnings": [], "text_sha256": "…"
}
```

`source` and `degraded` are set by the pre-processor, never by the model: the
client can show a small "simplified by the local engine" notice when the model
was unreachable, and the learner still hears the text.

## Decision: this is the learning-app stack (2026-09-16)

The repository also carries `claude/accessible-ai-learning-backend-6luk45`, a
Node/TypeScript service from an earlier session. The Python backend on this
branch is the product: it is the stack the owner specified in full, it is the
only one exercised end to end against the live model, and it carries the three
pillars (Claude API, Claude Agent SDK, MCP). The TypeScript branch stays as a
reference and receives no further work. Making this branch the default is one
setting in GitHub (Settings → Branches → Default branch).

## `speech` or `ssml`: the client decides per engine

Every segment carries both a plain `speech` text and an `ssml` fragment. Not
every engine understands SSML, and one that does not will read the tags aloud,
which is exactly the failure the server-side sanitiser exists to prevent. Rule
for the mobile client:

| Engine | Send |
|---|---|
| Web Speech API in a browser | `speech` (SSML is ignored or spoken) |
| Android `TextToSpeech` | `speech` |
| iOS `AVSpeechSynthesizer`, iOS 16 or later | `ssml` via `AVSpeechUtterance(ssmlRepresentation:)`, `speech` on older iOS |
| Cloud voices (Azure, Google, Polly) | `ssml_document` |

Verify on the real device before enabling `ssml` for an engine; when in doubt,
`speech` is always safe. The `pause_after_ms` value lets a client that sends
`speech` still insert the sentence pause itself.

## Guarantees

* **The learner always hears something.** Every model or network failure in
  pre-processing falls back to deterministic local normalisation. The coach's
  spending is capped per session (`COACH_MAX_BUDGET_USD`).
* **Only supported SSML reaches the device.** The model proposes markup; the
  sanitiser keeps `s p break prosody emphasis say-as sub lang phoneme`, drops
  everything else, clamps pauses to 3 s, and discards malformed XML entirely.
* **The right voice for the script.** Text is checked against its Unicode
  script before any TTS work; Hebrew text requested as English is read as
  Hebrew, and the mismatch is recorded in `warnings`.
* **Low cognitive load by construction.** The coach prompt forbids lists,
  markup and multiple questions, caps sentence length, and the tools expose
  one sentence at a time.
* **Every state change is a tool call.** The coach cannot touch the session
  except through the eight tools, so the transcript is the audit log.

## Measured on 2026-09-16 (this repository, `python main.py`)

| Stage | Result |
|---|---|
| MCP fetch | `he/water-cycle.md`, 608 chars, 108 words, over stdio |
| Pre-processing (Agent SDK backend, effort medium) | 16 segments, 8 glossary entries, nikud on ambiguous words, `<break>` at clause boundaries; $0.1927, 62.5 s |
| Coach session (4 turns) | tools used: get_reading_position, simplify_sentence, ask_check_question, note_word_explained, record_check_result, mark_sentence_done |
| Coach cost | $0.2950 for the four coach turns (reported by the Agent SDK) |
| Wall time | 98.8 s end to end |
| Same lesson, `COACH_EFFORT=low` | per-turn $0.0459 / $0.0651 / $0.0802 / $0.1028, total $0.2940 (medium: $0.0455 / $0.0644 / $0.0816 / $0.1035, total $0.2950) |

The `low` versus `medium` comparison shows that effort is not what drives the
coach's cost: the curve is identical, and it rises with the conversation
because every turn resends the growing history. The lever, when it is needed,
is context size (clearing old tool results), not effort. Effort stays `medium`.

## Mobile deployment shape

The backend is transport-agnostic. Wrap `TTSPreprocessor.prepare` and
`LearningAgent` in the HTTP framework of your choice; the mobile client sends
`{text | material path, language, installed voices}` and receives a
`TTSScript` plus, per coach turn, `{text, ssml}`. Speech synthesis stays on
the device (AVSpeechSynthesizer / Android TextToSpeech, or a cloud voice with
the same SSML), so audio never leaves the learner's phone unless you choose a
cloud voice. `rank_voices` tells the client which installed voice to use.
