/**
 * Rigid data contracts for the whole pipeline.
 *
 *  - Request schema        : what the mobile client sends.
 *  - LlmOutputSchema       : what the model is FORCED to emit (structured output).
 *                            Either a learning module or a tool invocation.
 *  - LearningPayloadSchema : what the client receives after guardrails.
 *  - Provider schema export: the same contract as a JSON Schema / Gemini
 *                            responseSchema so both providers are constrained
 *                            by one definition.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Languages, voices, layouts
// ---------------------------------------------------------------------------

export const LANGUAGE_CODES = ["he-IL", "en-US", "es-ES", "ar-XA"] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export const SHORT_TO_CODE: Record<string, LanguageCode> = {
  he: "he-IL",
  iw: "he-IL",
  en: "en-US",
  es: "es-ES",
  ar: "ar-XA",
};

export const VOICE_PREFERENCES = ["female_warm", "male_clear"] as const;
export type VoicePreference = (typeof VOICE_PREFERENCES)[number];

export const MODULE_TYPES = [
  "quiz",
  "explanation",
  "driving_scenario",
  "math_puzzle",
  "flashcard",
] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

export const LAYOUTS = ["quiz", "explanation", "flashcard", "scenario"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export const TOOL_NAMES = ["calculator", "unit_convert", "date_diff"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Inbound request
// ---------------------------------------------------------------------------

const LanguageInput = z
  .string()
  .trim()
  .transform((s, ctx) => {
    if ((LANGUAGE_CODES as readonly string[]).includes(s)) return s as LanguageCode;
    const short = SHORT_TO_CODE[s.toLowerCase().split(/[-_]/)[0] ?? ""];
    if (short) return short;
    ctx.addIssue({ code: "custom", message: `unsupported language "${s}"; use he, en, es or ar` });
    return z.NEVER;
  });

export const LearnerProfileSchema = z
  .object({
    dyslexia: z.boolean().default(false),
    screen_reader: z.boolean().default(false),
    reading_level: z.enum(["simple", "standard"]).default("simple"),
    age_group: z.enum(["child", "teen", "adult", "senior"]).default("adult"),
  })
  .default({ dyslexia: false, screen_reader: false, reading_level: "simple", age_group: "adult" });

export const GenerateRequestSchema = z.object({
  module_type: z.enum(MODULE_TYPES),
  topic: z.string().trim().min(2).max(300),
  language: LanguageInput,
  difficulty: z.enum(DIFFICULTIES).default("medium"),
  context: z.string().trim().max(2000).default(""),
  learner_profile: LearnerProfileSchema,
  voice_preference: z.enum(VOICE_PREFERENCES).optional(),
  bypass_cache: z.boolean().default(false),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const PrepareTtsRequestSchema = z.object({
  text: z.string().min(1).max(8000),
  language: LanguageInput,
  options: z.array(z.string().max(300)).max(8).default([]),
  voice_preference: z.enum(VOICE_PREFERENCES).optional(),
});
export type PrepareTtsRequest = z.infer<typeof PrepareTtsRequestSchema>;

// ---------------------------------------------------------------------------
// What the model must emit (provider-agnostic)
// ---------------------------------------------------------------------------

/**
 * `ui_metadata` as the model writes it. For non-quiz layouts `options` is an
 * empty array and `correct_index` is 0. Refinements below enforce the quiz
 * invariants (2..6 options, index in range, exactly one correct answer).
 */
export const UiMetadataSchema = z
  .object({
    layout: z.enum(LAYOUTS),
    options: z.array(z.string().min(1).max(400)).max(6),
    correct_index: z.number().int().min(0).max(5),
    explanation: z.string().max(1500).nullable(),
  })
  .superRefine((ui, ctx) => {
    if (ui.layout === "quiz") {
      if (ui.options.length < 2) {
        ctx.addIssue({ code: "custom", path: ["options"], message: "a quiz needs at least 2 options" });
      }
      if (ui.correct_index >= ui.options.length) {
        ctx.addIssue({ code: "custom", path: ["correct_index"], message: "correct_index out of range" });
      }
      const norm = ui.options.map((o) => o.trim().toLowerCase());
      if (new Set(norm).size !== norm.length) {
        ctx.addIssue({ code: "custom", path: ["options"], message: "duplicate options" });
      }
    } else if (ui.options.length !== 0 || ui.correct_index !== 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "options only allowed for layout=quiz" });
    }
  });

export const ModuleDraftSchema = z.object({
  title: z.string().min(1).max(160),
  raw_text: z.string().min(1).max(6000),
  language_code: z.enum(LANGUAGE_CODES),
  voice_preference: z.enum(VOICE_PREFERENCES),
  ui_metadata: UiMetadataSchema,
});
export type ModuleDraft = z.infer<typeof ModuleDraftSchema>;

export const ToolCallSchema = z.object({
  name: z.enum(TOOL_NAMES),
  /** JSON object encoded as a string; validated against the tool's own schema. */
  arguments_json: z.string().min(2).max(2000),
  reason: z.string().min(1).max(300),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * Flat envelope: Gemini's responseSchema does not support discriminated
 * unions, so both branches are nullable fields under one `kind` tag, and the
 * refinement enforces that exactly the matching branch is present.
 */
export const LlmOutputSchema = z
  .object({
    kind: z.enum(["module", "tool_call"]),
    module: ModuleDraftSchema.nullable(),
    tool_call: ToolCallSchema.nullable(),
  })
  .superRefine((o, ctx) => {
    if (o.kind === "module" && !o.module) {
      ctx.addIssue({ code: "custom", path: ["module"], message: "kind=module requires module" });
    }
    if (o.kind === "tool_call" && !o.tool_call) {
      ctx.addIssue({ code: "custom", path: ["tool_call"], message: "kind=tool_call requires tool_call" });
    }
  });
export type LlmOutput = z.infer<typeof LlmOutputSchema>;

// ---------------------------------------------------------------------------
// Tool argument schemas
// ---------------------------------------------------------------------------

export const ToolArgSchemas = {
  calculator: z.object({ expression: z.string().min(1).max(300) }),
  unit_convert: z.object({
    value: z.number().finite(),
    from: z.string().min(1).max(12),
    to: z.string().min(1).max(12),
  }),
  date_diff: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  }),
} as const;

export const ToolResultSchema = z.object({
  name: z.enum(TOOL_NAMES),
  arguments: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  result: z.string(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

// ---------------------------------------------------------------------------
// Outbound payload (after guardrails)
// ---------------------------------------------------------------------------

export const GuardrailHitSchema = z.object({
  rule: z.string(),
  from: z.string(),
  to: z.string(),
});

export const LearningPayloadSchema = z.object({
  title: z.string(),
  /** Clean, high-accessibility display text: short paragraphs separated by \n\n. */
  raw_text: z.string(),
  /** SSML-lite string: <speak>, <break time="…"/>, <say-as interpret-as="characters">. */
  tts_optimized_payload: z.string(),
  /** Same content with every tag removed, for engines without SSML (Web Speech). */
  tts_plain_payload: z.string(),
  language_code: z.enum(LANGUAGE_CODES),
  voice_preference: z.enum(VOICE_PREFERENCES),
  ui_metadata: z.object({
    layout: z.enum(LAYOUTS),
    options: z.array(z.string()),
    /** Options as the TTS engine should say them (after guardrails). */
    options_tts: z.array(z.string()),
    correct_index: z.number().int(),
    explanation: z.string().nullable(),
    /** True when the module came from the local fallback, not a model. */
    degraded: z.boolean(),
  }),
  guardrail_report: z.object({
    language_verified: z.boolean(),
    detected_language: z.enum(LANGUAGE_CODES).nullable(),
    hits: z.array(GuardrailHitSchema),
    warnings: z.array(z.string()),
  }),
});
export type LearningPayload = z.infer<typeof LearningPayloadSchema>;

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const GenerateResponseSchema = z.object({
  payload: LearningPayloadSchema,
  meta: z.object({
    request_id: z.string(),
    source: z.enum(["cache", "gemini", "anthropic", "local"]),
    model: z.string().nullable(),
    latency_ms: z.number().nonnegative(),
    cache: z.object({
      hit: z.boolean(),
      similarity: z.number().nullable(),
      key: z.string().nullable(),
    }),
    tool_calls: z.array(ToolResultSchema),
    route_log: z.array(z.string()),
    usage: UsageSchema,
    budget: z.object({
      tokens_used_today: z.number().int().nonnegative(),
      daily_token_budget: z.number().int().nonnegative(),
      estimated_usd_today: z.number().nullable(),
    }),
  }),
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// ---------------------------------------------------------------------------
// Provider-facing schema exports
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/** Full JSON Schema of the model contract (draft 2020-12, from Zod). */
export function llmOutputJsonSchema(): JsonSchema {
  return z.toJSONSchema(LlmOutputSchema, { target: "draft-2020-12", io: "output" }) as JsonSchema;
}

/**
 * Gemini `responseSchema` is an OpenAPI 3.0 subset: no `$schema`,
 * no `additionalProperties`, no `anyOf`. Nullable fields are expressed with
 * `nullable: true`; `const` becomes a one-value enum.
 */
export function toGeminiSchema(node: unknown): JsonSchema {
  if (typeof node !== "object" || node === null) return {};
  const src = node as JsonSchema;
  const out: JsonSchema = {};

  const variants = (src.anyOf ?? src.oneOf) as JsonSchema[] | undefined;
  if (variants) {
    const nonNull = variants.filter((v) => v.type !== "null");
    const hasNull = nonNull.length !== variants.length;
    const base = nonNull.length === 1 ? toGeminiSchema(nonNull[0]) : { type: "string" };
    return hasNull ? { ...base, nullable: true } : base;
  }

  if (typeof src.type === "string") out.type = src.type;
  if (Array.isArray(src.type)) {
    const t = (src.type as string[]).filter((x) => x !== "null");
    out.type = t[0] ?? "string";
    if (t.length !== (src.type as string[]).length) out.nullable = true;
  }
  if (src.description) out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum;
  if (src.const !== undefined) out.enum = [src.const];
  if (src.format === "int64" || src.format === "int32") out.format = src.format;

  if (src.properties && typeof src.properties === "object") {
    const props: JsonSchema = {};
    for (const [k, v] of Object.entries(src.properties as JsonSchema)) props[k] = toGeminiSchema(v);
    out.properties = props;
    if (Array.isArray(src.required)) out.required = src.required;
    // Gemini honours propertyOrdering; keep the declaration order stable.
    out.propertyOrdering = Object.keys(props);
  }
  if (src.items) out.items = toGeminiSchema(src.items);
  return out;
}

export function llmOutputGeminiSchema(): JsonSchema {
  return toGeminiSchema(llmOutputJsonSchema());
}
