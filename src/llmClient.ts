/**
 * LAYER A (part 2) + LAYER D — Provider clients, structured output, and the
 * fallback router.
 *
 *  GeminiClient    — Google AI Studio `generateContent` over HTTPS with
 *                    responseMimeType=application/json + responseSchema, so
 *                    the model cannot return markdown fences or prose.
 *  AnthropicClient — official SDK, `messages.parse` with a Zod output format
 *                    (`output_config.format`), same contract.
 *  Router          — ordered routes with a per-route circuit breaker. A
 *                    failure of any kind on route N moves to route N+1 inside
 *                    the same request. The caller adds the local generator as
 *                    the final, never-failing step.
 *
 * Every failure is normalised to LlmError with a `kind`, so the pipeline can
 * log why a route was skipped without string-matching messages.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmOutputSchema, llmOutputGeminiSchema, type LlmOutput, type Usage } from "./schemas.ts";

export type Provider = "gemini" | "anthropic";

export type LlmErrorKind =
  | "timeout"
  | "network"
  | "rate_limit"
  | "auth"
  | "bad_request"
  | "server"
  | "refusal"
  | "invalid_output"
  | "no_key";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | null;
  readonly provider: Provider;
  readonly model: string;
  constructor(kind: LlmErrorKind, provider: Provider, model: string, message: string, status: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
    this.provider = provider;
    this.model = model;
  }
}

export interface LlmCallInput {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmCallResult {
  output: LlmOutput;
  usage: Usage;
  provider: Provider;
  model: string;
}

export interface LlmClient {
  readonly provider: Provider;
  readonly model: string;
  readonly configured: boolean;
  call(input: LlmCallInput, signal: AbortSignal): Promise<LlmCallResult>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function parseAndValidate(provider: Provider, model: string, text: string): LlmOutput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new LlmError("invalid_output", provider, model, `response is not JSON: ${(e as Error).message}`);
  }
  const res = LlmOutputSchema.safeParse(json);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new LlmError("invalid_output", provider, model, `schema violation: ${issues}`);
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

export class GeminiClient implements LlmClient {
  readonly provider: Provider = "gemini";
  readonly model: string;
  readonly configured: boolean;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly schema = llmOutputGeminiSchema();

  constructor(o: GeminiOptions) {
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.configured = Boolean(o.apiKey);
    this.fetchImpl = o.fetchImpl ?? ((i, init) => fetch(i, init));
    this.baseUrl = (o.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  }

  async call(input: LlmCallInput, signal: AbortSignal): Promise<LlmCallResult> {
    if (!this.configured) throw new LlmError("no_key", "gemini", this.model, "GEMINI_API_KEY is not set");
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: this.schema,
        maxOutputTokens: input.maxTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      const err = e as Error & { name?: string };
      if (err.name === "AbortError" || signal.aborted) throw new LlmError("timeout", "gemini", this.model, "request timed out");
      throw new LlmError("network", "gemini", this.model, err.message);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const kind: LlmErrorKind =
        res.status === 429 ? "rate_limit" : res.status === 401 || res.status === 403 ? "auth" : res.status >= 500 ? "server" : "bad_request";
      throw new LlmError(kind, "gemini", this.model, `HTTP ${res.status}: ${text}`, res.status);
    }
    const data = (await res.json().catch(() => null)) as GeminiResponse | null;
    if (!data) throw new LlmError("invalid_output", "gemini", this.model, "empty body");
    if (data.promptFeedback?.blockReason) {
      throw new LlmError("refusal", "gemini", this.model, `prompt blocked: ${data.promptFeedback.blockReason}`);
    }
    const cand = data.candidates?.[0];
    if (!cand) throw new LlmError("invalid_output", "gemini", this.model, "no candidates");
    if (cand.finishReason === "SAFETY" || cand.finishReason === "RECITATION" || cand.finishReason === "PROHIBITED_CONTENT") {
      throw new LlmError("refusal", "gemini", this.model, `finishReason ${cand.finishReason}`);
    }
    const text = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (cand.finishReason === "MAX_TOKENS") {
      throw new LlmError("invalid_output", "gemini", this.model, "output truncated at maxOutputTokens");
    }
    const output = parseAndValidate("gemini", this.model, text);
    return {
      output,
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      provider: "gemini",
      model: this.model,
    };
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  timeoutMs: number;
  baseUrl?: string;
}

const OUTPUT_FORMAT = zodOutputFormat(LlmOutputSchema);

export class AnthropicClient implements LlmClient {
  readonly provider: Provider = "anthropic";
  readonly model: string;
  readonly configured: boolean;
  private readonly client: Anthropic | null;

  constructor(o: AnthropicOptions) {
    this.model = o.model;
    this.configured = Boolean(o.apiKey);
    this.client = o.apiKey
      ? new Anthropic({
          apiKey: o.apiKey,
          timeout: o.timeoutMs,
          maxRetries: 0, // the Router owns retries and fallbacks
          ...(o.fetchImpl ? { fetch: o.fetchImpl as unknown as typeof fetch } : {}),
          ...(o.baseUrl ? { baseURL: o.baseUrl } : {}),
        })
      : null;
  }

  async call(input: LlmCallInput, signal: AbortSignal): Promise<LlmCallResult> {
    if (!this.client) throw new LlmError("no_key", "anthropic", this.model, "ANTHROPIC_API_KEY is not set");
    // Haiku 4.5 does not accept output_config.effort; the current Opus/Sonnet
    // generation does, and "low" is the right setting for a short module.
    const supportsEffort = !/haiku/i.test(this.model);
    let msg: Anthropic.Message & { parsed_output: unknown };
    try {
      msg = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: input.maxTokens,
          system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: input.user }],
          output_config: { format: OUTPUT_FORMAT, ...(supportsEffort ? { effort: "low" as const } : {}) },
        },
        { signal },
      );
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError || signal.aborted) {
        throw new LlmError("timeout", "anthropic", this.model, "request timed out");
      }
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("rate_limit", "anthropic", this.model, e.message, e.status);
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new LlmError("auth", "anthropic", this.model, e.message, e.status);
      }
      if (e instanceof Anthropic.InternalServerError) throw new LlmError("server", "anthropic", this.model, e.message, e.status);
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new LlmError("timeout", "anthropic", this.model, e.message);
      if (e instanceof Anthropic.APIConnectionError) throw new LlmError("network", "anthropic", this.model, e.message);
      if (e instanceof Anthropic.APIError) throw new LlmError("bad_request", "anthropic", this.model, e.message, e.status ?? null);
      throw new LlmError("network", "anthropic", this.model, (e as Error).message);
    }
    if (msg.stop_reason === "refusal") {
      const why = msg.stop_details?.type === "refusal" ? msg.stop_details.category ?? "unspecified" : "unspecified";
      throw new LlmError("refusal", "anthropic", this.model, `model refused (${why})`);
    }
    if (msg.stop_reason === "max_tokens") {
      throw new LlmError("invalid_output", "anthropic", this.model, "output truncated at max_tokens");
    }
    const parsed = msg.parsed_output;
    if (!parsed) {
      const text = msg.content
        .filter((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      // Falls through to the shared validator so the error carries the issues.
      return {
        output: parseAndValidate("anthropic", this.model, text),
        usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
        provider: "anthropic",
        model: this.model,
      };
    }
    const validated = LlmOutputSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new LlmError("invalid_output", "anthropic", this.model, `schema violation: ${issues}`);
    }
    return {
      output: validated.data,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
      provider: "anthropic",
      model: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker + router
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  constructor(threshold: number, cooldownMs: number, now: () => number = Date.now) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
  }
  /** True when the route may be tried (closed, or half-open after cooldown). */
  allows(): boolean {
    return this.now() >= this.openUntil;
  }
  success(): void {
    this.failures = 0;
    this.openUntil = 0;
  }
  failure(): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs;
  }
  state(): "closed" | "open" | "half_open" {
    if (this.openUntil === 0) return "closed";
    return this.now() >= this.openUntil ? "half_open" : "open";
  }
}

export interface RouterOptions {
  routes: LlmClient[];
  timeoutMs: number;
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
  /** A hook for the ledger: called with every successful call's usage. */
  onUsage?: (model: string, usage: Usage) => void;
  /** Returns false when the budget forbids any paid call. */
  canSpend?: (estimatedTokens: number) => boolean;
}

export interface RoutedResult {
  result: LlmCallResult | null;
  log: string[];
}

export class Router {
  private readonly routes: LlmClient[];
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly timeoutMs: number;
  private readonly onUsage: (model: string, usage: Usage) => void;
  private readonly canSpend: (estimatedTokens: number) => boolean;

  constructor(o: RouterOptions) {
    this.routes = o.routes;
    this.timeoutMs = o.timeoutMs;
    this.onUsage = o.onUsage ?? (() => {});
    this.canSpend = o.canSpend ?? (() => true);
    this.breakers = new Map(o.routes.map((r) => [routeId(r), new CircuitBreaker(o.failureThreshold, o.cooldownMs, o.now)]));
  }

  status(): { route: string; configured: boolean; breaker: string }[] {
    return this.routes.map((r) => ({ route: routeId(r), configured: r.configured, breaker: this.breakers.get(routeId(r))!.state() }));
  }

  /**
   * Try every configured route in order. Returns null when all failed or were
   * skipped; the log says why for each one. An invalid_output on a route earns
   * one immediate retry on the same route with the validation issues appended.
   */
  async call(input: LlmCallInput): Promise<RoutedResult> {
    const log: string[] = [];
    const estimate = Math.ceil((input.system.length + input.user.length) / 4) + input.maxTokens;
    if (!this.canSpend(estimate)) {
      log.push("budget: daily token budget exhausted; skipping all provider routes");
      return { result: null, log };
    }
    for (const route of this.routes) {
      const id = routeId(route);
      if (!route.configured) {
        log.push(`${id}: skipped (no API key)`);
        continue;
      }
      const breaker = this.breakers.get(id)!;
      if (!breaker.allows()) {
        log.push(`${id}: skipped (circuit open)`);
        continue;
      }
      let attemptInput = input;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        const t0 = Date.now();
        try {
          const result = await route.call(attemptInput, ctl.signal);
          breaker.success();
          this.onUsage(result.model, result.usage);
          log.push(`${id}: ok in ${Date.now() - t0}ms (attempt ${attempt})`);
          return { result, log };
        } catch (e) {
          const err = e instanceof LlmError ? e : new LlmError("network", route.provider, route.model, (e as Error).message);
          log.push(`${id}: ${err.kind}${err.status ? ` ${err.status}` : ""} after ${Date.now() - t0}ms — ${err.message.slice(0, 160)}`);
          if (err.kind === "invalid_output" && attempt === 1) {
            attemptInput = {
              ...input,
              user: `${input.user}\n\nYour previous output was rejected: ${err.message}. Return a corrected JSON object.`,
            };
            continue;
          }
          // Refusals and bad requests are not the route's health; only
          // availability failures trip the breaker.
          if (["timeout", "network", "rate_limit", "server", "auth"].includes(err.kind)) breaker.failure();
          break;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    return { result: null, log };
  }
}

export function routeId(r: LlmClient): string {
  return `${r.provider}:${r.model}`;
}
