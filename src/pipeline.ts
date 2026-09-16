/**
 * The single execution stream:
 *
 *   validate → semantic cache → prompt → provider routes (with tool loop)
 *            → local fallback → guardrails → rigid output validation → cache
 *
 * Nothing in here knows about HTTP. server.ts adapts requests to
 * `generateModule`, and tests call it directly with fake providers.
 */
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { CostLedger, InMemoryStore, SemanticCache } from "./cacheService.ts";
import { localFallback } from "./fallback.ts";
import { runGuardrails } from "./guardrails.ts";
import { AnthropicClient, GeminiClient, Router, type FetchLike, type LlmClient } from "./llmClient.ts";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompts.ts";
import {
  GenerateResponseSchema,
  LearningPayloadSchema,
  type GenerateRequest,
  type GenerateResponse,
  type LearningPayload,
  type ModuleDraft,
  type ModuleType,
  type ToolResult,
  type Usage,
} from "./schemas.ts";
import { executeTool } from "./tools.ts";

export interface PipelineDeps {
  config: Config;
  cache: SemanticCache;
  ledger: CostLedger;
  router: Router;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

const MAX_TOOL_ROUNDS = 3;

/** Which layouts are acceptable for each module type. */
const LAYOUT_FOR: Record<ModuleType, ReadonlyArray<ModuleDraft["ui_metadata"]["layout"]>> = {
  quiz: ["quiz"],
  driving_scenario: ["quiz", "scenario"],
  math_puzzle: ["quiz"],
  explanation: ["explanation"],
  flashcard: ["flashcard"],
};

function draftFits(req: GenerateRequest, draft: ModuleDraft): string | null {
  if (!LAYOUT_FOR[req.module_type].includes(draft.ui_metadata.layout)) {
    return `layout ${draft.ui_metadata.layout} does not fit module_type ${req.module_type}`;
  }
  if (draft.language_code !== req.language) return `language_code ${draft.language_code} != ${req.language}`;
  return null;
}

function finalise(
  req: GenerateRequest,
  draft: ModuleDraft,
  degraded: boolean,
  extraWarnings: string[],
): LearningPayload {
  const ui = draft.ui_metadata;
  const isQuiz = ui.layout === "quiz";
  const correct = isQuiz ? ui.options[ui.correct_index] : undefined;
  const g = runGuardrails({
    raw_text: draft.raw_text,
    options: ui.options,
    language_code: draft.language_code,
    voice_preference: req.voice_preference ?? draft.voice_preference,
    layout: ui.layout,
    forbidden_in_tts: correct ? [correct] : [],
  });
  const payload: LearningPayload = {
    title: draft.title.trim(),
    raw_text: g.display_text,
    tts_optimized_payload: g.tts_ssml,
    tts_plain_payload: g.tts_plain,
    language_code: g.language_code,
    voice_preference: g.voice_preference,
    ui_metadata: {
      layout: ui.layout,
      options: g.options_display,
      options_tts: g.options_tts,
      correct_index: ui.correct_index,
      explanation: ui.explanation,
      degraded,
    },
    guardrail_report: {
      language_verified: g.language_verified,
      detected_language: g.detected_language,
      hits: g.hits,
      warnings: [...extraWarnings, ...g.warnings],
    },
  };
  // The contract to the client is rigid: fail loudly here rather than ship a
  // malformed payload.
  return LearningPayloadSchema.parse(payload);
}

export async function generateModule(
  req: GenerateRequest,
  deps: PipelineDeps,
  requestId: string = randomUUID(),
): Promise<GenerateResponse> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const log = deps.log ?? (() => {});
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const budget = () => {
    const s = deps.ledger.snapshot();
    return { tokens_used_today: s.tokens_used_today, daily_token_budget: s.daily_token_budget, estimated_usd_today: s.estimated_usd_today };
  };

  // 1. Cache.
  const lookup = await deps.cache.lookup(req);
  if (lookup.hit && lookup.payload) {
    deps.ledger.recordCacheHit();
    const res: GenerateResponse = {
      payload: lookup.payload,
      meta: {
        request_id: requestId,
        source: "cache",
        model: null,
        latency_ms: now() - t0,
        cache: { hit: true, similarity: lookup.similarity, key: lookup.key },
        tool_calls: [],
        route_log: [lookup.exact ? "cache: exact hit" : `cache: semantic hit (${lookup.similarity})`],
        usage,
        budget: budget(),
      },
    };
    log({ event: "generate", request_id: requestId, source: "cache", latency_ms: res.meta.latency_ms });
    return GenerateResponseSchema.parse(res);
  }

  // 2. Provider routes with the tool loop.
  const routeLog: string[] = [];
  const toolResults: ToolResult[] = [];
  const warnings: string[] = [];
  let draft: ModuleDraft | null = null;
  let source: GenerateResponse["meta"]["source"] = "local";
  let model: string | null = null;
  const seenCalls = new Set<string>();

  for (let round = 0; round < MAX_TOOL_ROUNDS && !draft; round++) {
    const input = { system: SYSTEM_PROMPT, user: buildUserMessage(req, toolResults), maxTokens: deps.config.MAX_TOKENS_PER_REQUEST };
    const routed = await deps.router.call(input);
    routeLog.push(...routed.log);
    if (!routed.result) break;
    usage.input_tokens += routed.result.usage.input_tokens;
    usage.output_tokens += routed.result.usage.output_tokens;
    source = routed.result.provider;
    model = routed.result.model;

    const out = routed.result.output;
    if (out.kind === "tool_call" && out.tool_call) {
      const sig = `${out.tool_call.name}:${out.tool_call.arguments_json}`;
      if (seenCalls.has(sig)) {
        routeLog.push(`tool: repeated call ${out.tool_call.name} ignored`);
        break;
      }
      seenCalls.add(sig);
      const result = executeTool(out.tool_call);
      toolResults.push(result);
      routeLog.push(`tool: ${result.name} ${result.ok ? "ok" : "error"} — ${result.result.slice(0, 120)}`);
      continue;
    }
    if (out.kind === "module" && out.module) {
      const problem = draftFits(req, out.module);
      if (problem) {
        routeLog.push(`draft rejected: ${problem}`);
        warnings.push(`model draft rejected: ${problem}`);
        break;
      }
      draft = out.module;
    }
  }

  // 3. Route of last resort.
  let degraded = false;
  if (!draft) {
    draft = localFallback(req, toolResults);
    degraded = true;
    source = "local";
    model = null;
    routeLog.push("local: deterministic fallback module");
  }

  // 4. Guardrails + rigid validation.
  const payload = finalise(req, draft, degraded, warnings);

  // 5. Cache only real content; a degraded module must not shadow a future
  //    good one.
  let key: string | null = null;
  if (!degraded) key = await deps.cache.store(req, payload);

  const res: GenerateResponse = {
    payload,
    meta: {
      request_id: requestId,
      source,
      model,
      latency_ms: now() - t0,
      cache: { hit: false, similarity: lookup.similarity, key },
      tool_calls: toolResults,
      route_log: routeLog,
      usage,
      budget: budget(),
    },
  };
  log({ event: "generate", request_id: requestId, source, model, latency_ms: res.meta.latency_ms, tools: toolResults.length, degraded });
  return GenerateResponseSchema.parse(res);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface BuildOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  /** Override the route list (tests inject fakes). */
  routes?: LlmClient[];
}

export function buildRoutes(config: Config, fetchImpl?: FetchLike): LlmClient[] {
  const gemini = new GeminiClient({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL, fetchImpl });
  const anthropicPrimary = new AnthropicClient({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
    fetchImpl,
    timeoutMs: config.PROVIDER_TIMEOUT_MS,
  });
  const anthropicLight = new AnthropicClient({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_FALLBACK_MODEL,
    fetchImpl,
    timeoutMs: config.PROVIDER_TIMEOUT_MS,
  });
  // Primary first, then the lightweight secondary route on the other provider.
  return config.PRIMARY_PROVIDER === "gemini" ? [gemini, anthropicLight] : [anthropicPrimary, gemini];
}

export function buildDeps(config: Config, o: BuildOptions = {}): PipelineDeps {
  const now = o.now ?? Date.now;
  const ledger = new CostLedger(config.DAILY_TOKEN_BUDGET, config.PRICE_TABLE_JSON, now);
  const cache = new SemanticCache({
    enabled: config.CACHE_ENABLED,
    threshold: config.CACHE_SIMILARITY_THRESHOLD,
    ttlSeconds: config.CACHE_TTL_SECONDS,
    store: new InMemoryStore(config.CACHE_MAX_ENTRIES, now),
    now,
  });
  const router = new Router({
    routes: o.routes ?? buildRoutes(config, o.fetchImpl),
    timeoutMs: config.PROVIDER_TIMEOUT_MS,
    failureThreshold: config.CIRCUIT_FAILURE_THRESHOLD,
    cooldownMs: config.CIRCUIT_COOLDOWN_MS,
    now,
    onUsage: (model, usage) => ledger.record(model, usage),
    canSpend: (tokens) => ledger.canSpend(tokens),
  });
  return { config, cache, ledger, router, now, log: o.log };
}
