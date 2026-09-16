/**
 * Application assembly: build every service from configuration (or from
 * injected test doubles), wire the Express app, and expose both.
 *
 * Nothing here talks to the network at construction time. Providers are
 * only instantiated when their credentials exist, and Supabase-backed stores
 * are swapped for in-memory stores when the database is not configured, so
 * the same binary runs in CI, on a laptop and in production.
 */
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type winston from "winston";
import { LANGUAGE_CODES, type HealthResponse } from "./types/index.js";
import { LIMITS, SERVICE_VERSION } from "./config/constants.js";
import { SEED_OVERRIDES } from "./config/seedDictionary.js";
import type { AppConfig } from "./config/env.js";
import { apiKeyAuth } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { requestContext } from "./middleware/requestContext.js";
import { PlanStore, TtsPipeline } from "./orchestration/pipeline.js";
import { MemoryAudioCache, SupabaseAudioCache, TieredAudioCache, type AudioCacheStore } from "./services/audioCache.js";
import { AudioEngine, AzureSpeechProvider, GoogleTtsProvider, type FetchLike, type SynthesisProvider } from "./services/audioEngine.js";
import { DictionaryService, MemoryDictionaryStore, SupabaseDictionaryStore, type DictionaryStore } from "./services/dictionary.js";
import { Observability, type SpanRecord } from "./services/observability.js";
import { GeminiClient, Preprocessor, type LanguageModelClient } from "./services/preprocessor.js";
import { createSupabaseClient, type Db } from "./services/supabase.js";
import { MemoryPreferencesStore, SupabasePreferencesStore, UserStateService, type PreferencesStore } from "./services/userState.js";
import { VoiceSelector, type CloudProvider } from "./services/voiceSelector.js";
import { createTtsRouter } from "./routes/tts.js";

/** Test seams. Everything is optional; production passes none of them. */
export interface AppOverrides {
  readonly model?: LanguageModelClient | null;
  readonly providers?: ReadonlyMap<CloudProvider, SynthesisProvider>;
  readonly fetch?: FetchLike;
  readonly dictionaryStore?: DictionaryStore;
  readonly preferencesStore?: PreferencesStore;
  readonly audioCache?: AudioCacheStore;
  readonly logTransports?: winston.transport[];
  readonly spanSink?: (span: SpanRecord) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface AppContainer {
  readonly config: AppConfig;
  readonly obs: Observability;
  readonly db: Db | null;
  readonly dictionary: DictionaryService;
  readonly userState: UserStateService;
  readonly preprocessor: Preprocessor;
  readonly selector: VoiceSelector;
  readonly engine: AudioEngine;
  readonly plans: PlanStore;
  readonly pipeline: TtsPipeline;
  readonly startedAt: number;
}

export function buildContainer(config: AppConfig, overrides: AppOverrides = {}): AppContainer {
  const obs = new Observability({
    serviceName: config.serviceName,
    version: SERVICE_VERSION,
    level: config.logLevel,
    environment: config.nodeEnv,
    ...(overrides.logTransports ? { transports: overrides.logTransports } : {}),
    ...(overrides.spanSink ? { spanSink: overrides.spanSink } : {}),
  });

  const db = config.supabase.enabled ? createSupabaseClient(config.supabase.url, config.supabase.serviceRoleKey) : null;

  const dictionaryStore = overrides.dictionaryStore ?? (db ? new SupabaseDictionaryStore(db) : new MemoryDictionaryStore(SEED_OVERRIDES));
  const preferencesStore = overrides.preferencesStore ?? (db ? new SupabasePreferencesStore(db) : new MemoryPreferencesStore());
  const durableCache = db ? new SupabaseAudioCache(db, config.audioCache.ttlSeconds) : null;
  const audioCache = overrides.audioCache ?? new TieredAudioCache(new MemoryAudioCache(config.audioCache.maxItems, config.audioCache.ttlSeconds * 1000, overrides.now), durableCache, obs);

  const dictionary = new DictionaryService(dictionaryStore, obs);
  const userState = new UserStateService(preferencesStore);

  const model: LanguageModelClient | null =
    overrides.model !== undefined ? overrides.model : config.gemini.enabled ? new GeminiClient(config.gemini.apiKey, config.gemini.model) : null;
  const preprocessor = new Preprocessor(model, { enabled: config.gemini.enabled || overrides.model !== undefined, timeoutMs: config.gemini.timeoutMs, maxRetries: 2 }, obs);

  const providers = new Map<CloudProvider, SynthesisProvider>();
  if (overrides.providers) {
    for (const [id, p] of overrides.providers) providers.set(id, p);
  } else {
    const fetchFn = overrides.fetch;
    if (config.tts.azure.enabled) providers.set("azure", new AzureSpeechProvider(config.tts.azure.key, config.tts.azure.region, fetchFn));
    if (config.tts.google.enabled) providers.set("google", new GoogleTtsProvider(config.tts.google.apiKey, fetchFn));
  }
  const selector = new VoiceSelector(new Set(providers.keys()), config.tts.providerOrder);
  const engine = new AudioEngine(
    providers,
    selector,
    audioCache,
    {
      timeoutMs: config.tts.timeoutMs,
      maxRetries: config.tts.maxRetries,
      rateLimitRpm: config.tts.rateLimitRpm,
      maxConcurrency: config.tts.maxConcurrency,
      breakerThreshold: 3,
      breakerCooldownMs: 30_000,
      ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
      ...(overrides.now ? { now: overrides.now } : {}),
    },
    obs,
  );
  const plans = new PlanStore(LIMITS.planTtlMs, LIMITS.maxPlansInMemory, overrides.now);
  const pipeline = new TtsPipeline({ preprocessor, dictionary, userState, selector, engine, plans, obs });

  return { config, obs, db, dictionary, userState, preprocessor, selector, engine, plans, pipeline, startedAt: Date.now() };
}

/** Origins hybrid mobile shells use; native apps send no Origin at all. */
const MOBILE_SHELL_ORIGINS = new Set(["capacitor://localhost", "ionic://localhost", "http://localhost", "https://localhost"]);

export function createApp(config: AppConfig, overrides: AppOverrides = {}): { app: Express; container: AppContainer } {
  const container = buildContainer(config, overrides);
  const { obs } = container;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin === undefined || MOBILE_SHELL_ORIGINS.has(origin) || config.corsOrigins.includes(origin) || config.corsOrigins.includes("*")) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "x-api-key", "authorization", "x-user-id", "traceparent"],
      exposedHeaders: ["x-request-id", "x-trace-id", "x-tts-chunks", "x-tts-provider", "x-tts-voice", "x-tts-cached", "x-tts-fallback", "x-tts-completed-chunks"],
      maxAge: 86400,
    }),
  );
  app.use(requestContext());
  app.use(obs.httpLogger());
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    const health = container.engine.providerHealth();
    const body: HealthResponse = {
      status: "ok",
      service: config.serviceName,
      version: SERVICE_VERSION,
      languages: LANGUAGE_CODES,
      providers: { azure: config.tts.azure.enabled && health.azure, google: config.tts.google.enabled && health.google },
      gemini: container.preprocessor.aiEnabled,
      supabase: container.db !== null,
      uptimeSeconds: Math.round((Date.now() - container.startedAt) / 1000),
    };
    res.status(200).json(body);
  });

  app.get("/metrics", apiKeyAuth(config.clientApiKey), (_req, res) => {
    res.status(200).json({ ...obs.metrics(), plans: container.plans.size });
  });

  app.use("/", apiKeyAuth(config.clientApiKey), createTtsRouter({ pipeline: container.pipeline, dictionary: container.dictionary, userState: container.userState }));

  app.use(notFound());
  app.use(errorHandler(obs, config.nodeEnv !== "production"));

  return { app, container };
}
