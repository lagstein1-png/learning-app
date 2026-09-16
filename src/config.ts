/**
 * Central configuration. Every environment variable is read here, once,
 * and validated. No other module touches process.env.
 */
import { z } from "zod";

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v.trim())));

const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const PriceEntry = z.object({
  input_per_1m: z.number().nonnegative(),
  output_per_1m: z.number().nonnegative(),
});

export const ConfigSchema = z.object({
  PORT: intFrom(8787, 0, 65535),
  HOST: z.string().default("127.0.0.1"),
  ALLOW_ORIGINS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  RATE_LIMIT_PER_MINUTE: intFrom(60, 1, 100_000),

  PRIMARY_PROVIDER: z.enum(["gemini", "anthropic"]).default("gemini"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.6-flash"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  ANTHROPIC_FALLBACK_MODEL: z.string().default("claude-haiku-4-5"),
  PROVIDER_TIMEOUT_MS: intFrom(20_000, 1_000, 600_000),
  CIRCUIT_FAILURE_THRESHOLD: intFrom(3, 1, 100),
  CIRCUIT_COOLDOWN_MS: intFrom(60_000, 1_000, 3_600_000),

  CACHE_ENABLED: boolish.default(true),
  CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
  CACHE_TTL_SECONDS: intFrom(86_400, 1, 30 * 86_400),
  CACHE_MAX_ENTRIES: intFrom(2000, 1, 1_000_000),

  DAILY_TOKEN_BUDGET: intFrom(2_000_000, 0, 1_000_000_000),
  MAX_TOKENS_PER_REQUEST: intFrom(4000, 256, 64_000),
  PRICE_TABLE_JSON: z
    .string()
    .default("")
    .transform((s, ctx) => {
      if (!s.trim()) return {} as Record<string, z.infer<typeof PriceEntry>>;
      try {
        return z.record(z.string(), PriceEntry).parse(JSON.parse(s));
      } catch (e) {
        ctx.addIssue({ code: "custom", message: `PRICE_TABLE_JSON invalid: ${(e as Error).message}` });
        return z.NEVER;
      }
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parse a raw env-like object. Throws a readable error on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const picked: Record<string, string> = {};
  for (const key of Object.keys(ConfigSchema.shape)) {
    const v = env[key];
    if (v !== undefined && v !== "") picked[key] = v;
  }
  const res = ConfigSchema.safeParse(picked);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return res.data;
}
