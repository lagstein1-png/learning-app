/**
 * HTTP surface.
 *
 *   POST   /process-text            run the pipeline, return the plan
 *   GET    /get-audio               stream the whole plan as MP3, or one chunk
 *   POST   /dictionary-override     create or update a pronunciation override
 *   GET    /dictionary-override     list overrides for a language (+ learner)
 *   DELETE /dictionary-override/:id remove an override
 *   GET    /preferences/:userId     learner accessibility preferences
 *   PUT    /preferences/:userId     update them
 *   GET    /voices                  the catalogue for a language
 *
 * Every handler validates its input with zod, so the pipeline only ever sees
 * the formal request interfaces.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ERROR_CODES, LIMITS, VOICE_CATALOGUE } from "../config/constants.js";
import type { TtsPipeline } from "../orchestration/pipeline.js";
import type { ChunkOutcome } from "../services/audioEngine.js";
import type { DictionaryService } from "../services/dictionary.js";
import type { UserStateService } from "../services/userState.js";
import { LANGUAGE_CODES, type DictionaryListResponse, type DictionaryOverrideResponse, type LanguageCode, type ProcessTextRequest } from "../types/index.js";
import { AppError } from "../utils/errors.js";
import { ssmlToPlainText } from "../utils/ssml.js";

const language = z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]);
const userId = z.string().regex(/^[A-Za-z0-9_\-:.@]{1,128}$/);

const processTextSchema = z.object({
  text: z.string().min(1).max(LIMITS.maxInputChars),
  language,
  userId: userId.optional(),
  gender: z.enum(["female", "male"]).optional(),
  cadence: z.enum(["slow", "relaxed", "natural", "brisk"]).optional(),
  mood: z.enum(["neutral", "warm", "encouraging", "calm", "serious", "cheerful"]).optional(),
  domain: z.string().min(1).max(64).optional(),
  maxChunkChars: z.number().int().min(LIMITS.minChunkChars).max(LIMITS.maxChunkChars).optional(),
  skipAi: z.boolean().optional(),
});

const getAudioSchema = z.object({
  planToken: z.string().min(1),
  chunk: z.coerce.number().int().min(0).optional(),
});

const overrideSchema = z.object({
  language,
  term: z.string().trim().min(1).max(120),
  spokenForm: z.string().trim().min(1).max(400),
  ipa: z.string().trim().min(1).max(200).optional(),
  userId: userId.optional(),
  domain: z.string().trim().min(1).max(64).optional(),
});

const listOverridesSchema = z.object({
  language,
  userId: userId.optional(),
});

const preferencesSchema = z.object({
  language: language.optional(),
  gender: z.enum(["female", "male"]).optional(),
  cadence: z.enum(["slow", "relaxed", "natural", "brisk"]).optional(),
  mood: z.enum(["neutral", "warm", "encouraging", "calm", "serious", "cheerful"]).optional(),
  maxChunkChars: z.number().int().min(LIMITS.minChunkChars).max(LIMITS.maxChunkChars).optional(),
  wordHighlighting: z.boolean().optional(),
});

export interface TtsRouterDeps {
  readonly pipeline: TtsPipeline;
  readonly dictionary: DictionaryService;
  readonly userState: UserStateService;
}

/** Zod emits `key?: T | undefined`; the formal interfaces use `key?: T`. Drop the undefined members. */
type StripUndefined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function stripUndefined<T extends object>(obj: T): StripUndefined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as StripUndefined<T>;
}

function resolveUser(req: Request, bodyUserId: string | undefined): string | null {
  return bodyUserId ?? req.trace.userId;
}

function sendDeviceFallback(res: Response, outcome: Extract<ChunkOutcome, { kind: "device" }>): void {
  res.setHeader("x-tts-fallback", "device");
  res.status(200).json({
    fallback: "device",
    chunkIndex: outcome.chunkIndex,
    directive: { ...outcome.directive, plainText: ssmlToPlainText(outcome.directive.ssml) },
  });
}

export function createTtsRouter(deps: TtsRouterDeps): Router {
  const router = Router();

  router.post("/process-text", async (req, res, next) => {
    try {
      const body = processTextSchema.parse(req.body);
      const request: ProcessTextRequest = stripUndefined(body);
      const response = await deps.pipeline.process(request, resolveUser(req, body.userId), req.trace.requestId);
      res.setHeader("cache-control", "no-store");
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/get-audio", async (req, res, next) => {
    try {
      const query = getAudioSchema.parse(req.query);
      if (query.chunk !== undefined) {
        const outcome = await deps.pipeline.chunk(query.planToken, query.chunk);
        if (outcome.kind === "device") {
          sendDeviceFallback(res, outcome);
          return;
        }
        res.setHeader("content-type", "audio/mpeg");
        res.setHeader("content-length", String(outcome.result.audio.byteLength));
        res.setHeader("cache-control", "private, max-age=86400");
        res.setHeader("x-tts-provider", outcome.result.provider);
        res.setHeader("x-tts-voice", outcome.result.voiceId);
        res.setHeader("x-tts-cached", outcome.result.cached ? "1" : "0");
        res.status(200).end(outcome.result.audio);
        return;
      }

      const stored = deps.pipeline.plan(query.planToken);
      const stream = deps.pipeline.stream(query.planToken);
      const first = await stream.next();
      if (first.done) throw new AppError(ERROR_CODES.INTERNAL, "plan produced no audio");
      if (first.value.kind === "device") {
        sendDeviceFallback(res, first.value);
        return;
      }
      res.status(200);
      res.setHeader("content-type", "audio/mpeg");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-accel-buffering", "no");
      res.setHeader("x-tts-chunks", String(stored.inputs.length));
      res.setHeader("x-tts-provider", first.value.result.provider);
      res.setHeader("x-tts-voice", first.value.result.voiceId);
      res.setHeader("trailer", "x-tts-completed-chunks");
      res.flushHeaders();
      let completed = 0;
      const write = (buf: Buffer): Promise<void> =>
        new Promise((resolve, reject) => {
          res.write(buf, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      await write(first.value.result.audio);
      completed = 1;
      for await (const outcome of stream) {
        if (req.socket.destroyed) break;
        if (outcome.kind === "device") break;
        await write(outcome.result.audio);
        completed += 1;
      }
      res.addTrailers({ "x-tts-completed-chunks": String(completed) });
      res.end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/dictionary-override", async (req, res, next) => {
    try {
      const body = stripUndefined(overrideSchema.parse(req.body));
      const result = await deps.dictionary.upsert(body);
      const payload: DictionaryOverrideResponse = result;
      res.status(result.created ? 201 : 200).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/dictionary-override", async (req, res, next) => {
    try {
      const query = listOverridesSchema.parse(req.query);
      const scope = query.userId ?? req.trace.userId;
      const overrides = await deps.dictionary.resolve(query.language, scope);
      const payload: DictionaryListResponse = { language: query.language, userId: scope, overrides };
      res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/dictionary-override/:id", async (req, res, next) => {
    try {
      const query = listOverridesSchema.parse(req.query);
      const id = z.string().min(1).parse(req.params.id);
      const removed = await deps.dictionary.remove(id, query.language, query.userId ?? req.trace.userId);
      if (!removed) throw new AppError(ERROR_CODES.NOT_FOUND, `override ${id} not found`);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/preferences/:userId", async (req, res, next) => {
    try {
      const id = userId.parse(req.params.userId);
      const lang = language.optional().parse(req.query.language) ?? "he";
      res.status(200).json(await deps.userState.preferencesFor(id, lang));
    } catch (error) {
      next(error);
    }
  });

  router.put("/preferences/:userId", async (req, res, next) => {
    try {
      const id = userId.parse(req.params.userId);
      const body = stripUndefined(preferencesSchema.parse(req.body));
      res.status(200).json(await deps.userState.update(id, body));
    } catch (error) {
      next(error);
    }
  });

  router.get("/voices", (req, res, next) => {
    try {
      const lang = language.optional().parse(req.query.language);
      const voices = VOICE_CATALOGUE.filter((v) => lang === undefined || v.language === lang);
      res.status(200).json({ voices });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
