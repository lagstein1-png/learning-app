/**
 * Test doubles. Nothing here touches the network: the language model, the
 * voice providers and the clock are all replaced with deterministic fakes
 * so the suite runs identically in CI and on a laptop without credentials.
 */
import { Writable } from "node:stream";
import type { Schema } from "@google/genai";
import winston from "winston";
import { createApp, type AppContainer, type AppOverrides } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import type { SynthesisProvider } from "../../src/services/audioEngine.js";
import { ProviderHttpError } from "../../src/utils/errors.js";
import { Observability } from "../../src/services/observability.js";
import type { LanguageModelClient } from "../../src/services/preprocessor.js";
import type { CloudProvider } from "../../src/services/voiceSelector.js";
import type { VoiceProfile } from "../../src/types/index.js";
import type { Express } from "express";

export function silentTransports(): winston.transport[] {
  return [
    new winston.transports.Stream({
      stream: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    }),
  ];
}

export function testObservability(): Observability {
  return new Observability({ serviceName: "test", version: "0.0.0", level: "error", environment: "test", transports: silentTransports() });
}

/** Never actually sleeps; records the requested delays. */
export function instantSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

export interface ProviderCall {
  readonly ssml: string;
  readonly voice: VoiceProfile;
}

export type ProviderBehaviour = (call: ProviderCall, attempt: number) => Buffer;

/** A fake neural voice provider whose failures are scripted per call. */
export class FakeProvider implements SynthesisProvider {
  readonly calls: ProviderCall[] = [];
  private failures: { status: number; body: string }[] = [];
  private behaviour: ProviderBehaviour;

  constructor(
    readonly id: CloudProvider,
    behaviour?: ProviderBehaviour,
  ) {
    this.behaviour = behaviour ?? ((call) => Buffer.from(`MP3|${this.id}|${call.voice.id}|${call.ssml.length}`, "utf8"));
  }

  /** Queue `n` failures with `status` before the next success. */
  failNext(n: number, status: number, body = "scripted failure"): this {
    for (let i = 0; i < n; i += 1) this.failures.push({ status, body });
    return this;
  }

  /** Fail every call from now on. */
  alwaysFail(status: number, body = "provider down"): this {
    this.behaviour = () => {
      throw new ProviderHttpError(this.id, status, body);
    };
    return this;
  }

  synthesize(ssml: string, voice: VoiceProfile, _signal: AbortSignal): Promise<Buffer> {
    const call = { ssml, voice };
    this.calls.push(call);
    const scripted = this.failures.shift();
    if (scripted) return Promise.reject(new ProviderHttpError(this.id, scripted.status, scripted.body));
    try {
      return Promise.resolve(this.behaviour(call, this.calls.length));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export interface FakeModelPayload {
  text: string;
  context: string;
  mood: string;
  emphasis: { phrase: string; level: "moderate" | "strong"; reason: string }[];
  homographs: { surface: string; reading: string; meaning: string }[];
  phoneticAnnotations: { term: string; spokenForm: string }[];
}

export type ModelResponder = (prompt: string, systemInstruction: string) => FakeModelPayload | string;

/** A fake Gemini that answers from a responder function, or fails on demand. */
export class FakeModel implements LanguageModelClient {
  readonly prompts: string[] = [];
  private pendingErrors: Error[] = [];

  constructor(private responder: ModelResponder) {}

  respondWith(responder: ModelResponder): this {
    this.responder = responder;
    return this;
  }

  failNext(error: Error, times = 1): this {
    for (let i = 0; i < times; i += 1) this.pendingErrors.push(error);
    return this;
  }

  generateJson(input: { systemInstruction: string; prompt: string; schema: Schema; signal: AbortSignal }): Promise<{ text: string; promptTokens: number; outputTokens: number }> {
    this.prompts.push(input.prompt);
    const err = this.pendingErrors.shift();
    if (err) return Promise.reject(err);
    const payload = this.responder(input.prompt, input.systemInstruction);
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return Promise.resolve({ text, promptTokens: input.prompt.length, outputTokens: text.length });
  }
}

/** A responder that echoes the text back with the requested extras. */
export function echoModel(extras: Partial<FakeModelPayload> = {}): ModelResponder {
  return (prompt) => {
    const text = prompt.replace(/^(?:Domain: [^\n]*\n\n)?Text:\n/u, "");
    return {
      text,
      context: "echo",
      mood: "warm",
      emphasis: [],
      homographs: [],
      phoneticAnnotations: [],
      ...extras,
    };
  };
}

export interface TestAppOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly providers?: readonly FakeProvider[];
  readonly model?: FakeModel | null;
  readonly overrides?: AppOverrides;
}

export interface TestApp {
  readonly app: Express;
  readonly container: AppContainer;
  readonly config: AppConfig;
  readonly azure: FakeProvider;
  readonly google: FakeProvider;
  readonly model: FakeModel | null;
  readonly delays: number[];
}

export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    AZURE_SPEECH_KEY: "test-azure-key",
    AZURE_SPEECH_REGION: "westeurope",
    GOOGLE_TTS_API_KEY: "test-google-key",
    TTS_PROVIDER_ORDER: "azure,google",
    TTS_MAX_RETRIES: "2",
    TTS_TIMEOUT_MS: "2000",
    GEMINI_API_KEY: "",
    ...options.env,
  });
  const providers = options.providers ?? [new FakeProvider("azure"), new FakeProvider("google")];
  const azure = providers.find((p) => p.id === "azure") ?? new FakeProvider("azure");
  const google = providers.find((p) => p.id === "google") ?? new FakeProvider("google");
  const map = new Map<CloudProvider, SynthesisProvider>(providers.map((p) => [p.id, p]));
  const model = options.model === undefined ? null : options.model;
  const { sleep, delays } = instantSleep();
  const { app, container } = createApp(config, {
    providers: map,
    model,
    logTransports: silentTransports(),
    sleep,
    ...options.overrides,
  });
  return { app, container, config, azure, google, model, delays };
}
