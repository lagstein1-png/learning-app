/**
 * Environment parsing. Every value is validated once at start-up with zod so
 * a mis-configured deployment fails immediately and loudly, never on the
 * first request.
 */
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { ProviderId } from "../types/index.js";

loadDotenv({ quiet: true });

const booleanFromEnv = z
  .union([z.literal("1"), z.literal("0"), z.literal("true"), z.literal("false")])
  .transform((v) => v === "1" || v === "true");

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0));

const cloudProvider = z.enum(["azure", "google"]);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "debug"]).default("info"),
  SERVICE_NAME: z.string().min(1).default("learning-app-tts"),
  CORS_ORIGINS: csv,
  CLIENT_API_KEY: z.string().default(""),

  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  GEMINI_ENABLED: booleanFromEnv.default("1"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(12000),

  SUPABASE_URL: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),

  AZURE_SPEECH_KEY: z.string().default(""),
  AZURE_SPEECH_REGION: z.string().min(1).default("westeurope"),
  GOOGLE_TTS_API_KEY: z.string().default(""),
  TTS_PROVIDER_ORDER: z
    .string()
    .default("azure,google")
    .transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0))
    .pipe(z.array(cloudProvider).min(1)),
  TTS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  TTS_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  TTS_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(120),
  TTS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

  AUDIO_CACHE_MAX_ITEMS: z.coerce.number().int().min(0).default(500),
  AUDIO_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(604800),
});

export type RawEnv = z.infer<typeof envSchema>;

/** Fully resolved, typed application configuration. */
export interface AppConfig {
  readonly nodeEnv: RawEnv["NODE_ENV"];
  readonly port: number;
  readonly logLevel: RawEnv["LOG_LEVEL"];
  readonly serviceName: string;
  readonly corsOrigins: readonly string[];
  readonly clientApiKey: string;
  readonly gemini: {
    readonly apiKey: string;
    readonly model: string;
    readonly enabled: boolean;
    readonly timeoutMs: number;
  };
  readonly supabase: {
    readonly url: string;
    readonly serviceRoleKey: string;
    readonly enabled: boolean;
  };
  readonly tts: {
    readonly azure: { readonly key: string; readonly region: string; readonly enabled: boolean };
    readonly google: { readonly apiKey: string; readonly enabled: boolean };
    readonly providerOrder: readonly Exclude<ProviderId, "device">[];
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly rateLimitRpm: number;
    readonly maxConcurrency: number;
  };
  readonly audioCache: {
    readonly maxItems: number;
    readonly ttlSeconds: number;
  };
}

/**
 * Parse `source` (defaults to `process.env`) into an `AppConfig`.
 * Throws a descriptive error listing every invalid variable.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const azureEnabled = e.AZURE_SPEECH_KEY.length > 0;
  const googleEnabled = e.GOOGLE_TTS_API_KEY.length > 0;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    serviceName: e.SERVICE_NAME,
    corsOrigins: e.CORS_ORIGINS,
    clientApiKey: e.CLIENT_API_KEY,
    gemini: {
      apiKey: e.GEMINI_API_KEY,
      model: e.GEMINI_MODEL,
      enabled: e.GEMINI_ENABLED && e.GEMINI_API_KEY.length > 0,
      timeoutMs: e.GEMINI_TIMEOUT_MS,
    },
    supabase: {
      url: e.SUPABASE_URL,
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
      enabled: e.SUPABASE_URL.length > 0 && e.SUPABASE_SERVICE_ROLE_KEY.length > 0,
    },
    tts: {
      azure: { key: e.AZURE_SPEECH_KEY, region: e.AZURE_SPEECH_REGION, enabled: azureEnabled },
      google: { apiKey: e.GOOGLE_TTS_API_KEY, enabled: googleEnabled },
      providerOrder: e.TTS_PROVIDER_ORDER,
      timeoutMs: e.TTS_TIMEOUT_MS,
      maxRetries: e.TTS_MAX_RETRIES,
      rateLimitRpm: e.TTS_RATE_LIMIT_RPM,
      maxConcurrency: e.TTS_MAX_CONCURRENCY,
    },
    audioCache: {
      maxItems: e.AUDIO_CACHE_MAX_ITEMS,
      ttlSeconds: e.AUDIO_CACHE_TTL_SECONDS,
    },
  };
}
