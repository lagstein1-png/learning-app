/**
 * HTTP edge. Plain node:http — no framework — so the mobile client talks to a
 * small, auditable surface:
 *
 *   POST /v1/modules/generate   the unified stream (pipeline.ts)
 *   POST /v1/tts/prepare        guardrails only, for text the client already has
 *   GET  /v1/health             routes, breakers, cache, budget
 *   GET  /v1/cache/stats        DELETE /v1/cache
 *   GET  /v1/budget
 *   GET  /v1/schema             the model output contract as JSON Schema
 *
 * Every response is JSON. Errors are { error: { code, message, issues?, request_id } }.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { runGuardrails } from "./guardrails.ts";
import { buildDeps, generateModule, type BuildOptions, type PipelineDeps } from "./pipeline.ts";
import { GenerateRequestSchema, PrepareTtsRequestSchema, llmOutputJsonSchema } from "./schemas.ts";

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // keep draining so the 413 can be delivered
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json", "body is not valid JSON"));
      }
    });
    req.on("error", (e) => reject(new HttpError(400, "read_error", e.message)));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(json);
}

/** Sliding-window limiter keyed by client IP. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perMinute: number;
  private readonly now: () => number;
  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }
  allow(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= this.perMinute) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits.clear(); // memory guard, resets counters
    return true;
  }
}

function corsHeaders(config: Config, origin: string | undefined): Record<string, string> {
  if (!origin || !config.ALLOW_ORIGINS.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export interface App {
  server: http.Server;
  deps: PipelineDeps;
}

export function createApp(config: Config, options: BuildOptions = {}): App {
  const deps = buildDeps(config, options);
  const limiter = new RateLimiter(config.RATE_LIMIT_PER_MINUTE, options.now);
  const log = options.log ?? ((e) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n"));

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const cors = corsHeaders(config, req.headers.origin);
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (!limiter.allow(ip)) throw new HttpError(429, "rate_limited", "too many requests; try again in a minute");

      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case "GET /v1/health": {
          send(res, 200, {
            ok: true,
            routes: deps.router.status(),
            cache: await deps.cache.stats(),
            budget: deps.ledger.snapshot(),
          }, cors);
          break;
        }
        case "POST /v1/modules/generate": {
          const body = GenerateRequestSchema.parse(await readJson(req));
          const out = await generateModule(body, deps, requestId);
          send(res, 200, out, { ...cors, "x-request-id": requestId, "x-source": out.meta.source });
          break;
        }
        case "POST /v1/tts/prepare": {
          const body = PrepareTtsRequestSchema.parse(await readJson(req));
          const g = runGuardrails({
            raw_text: body.text,
            options: body.options,
            language_code: body.language,
            voice_preference: body.voice_preference ?? null,
            layout: body.options.length ? "quiz" : "explanation",
          });
          send(res, 200, {
            raw_text: g.display_text,
            tts_optimized_payload: g.tts_ssml,
            tts_plain_payload: g.tts_plain,
            language_code: g.language_code,
            voice_preference: g.voice_preference,
            options: g.options_display,
            options_tts: g.options_tts,
            guardrail_report: { language_verified: g.language_verified, detected_language: g.detected_language, hits: g.hits, warnings: g.warnings },
          }, { ...cors, "x-request-id": requestId });
          break;
        }
        case "GET /v1/cache/stats":
          send(res, 200, await deps.cache.stats(), cors);
          break;
        case "DELETE /v1/cache":
          await deps.cache.clear();
          send(res, 200, { ok: true }, cors);
          break;
        case "GET /v1/budget":
          send(res, 200, deps.ledger.snapshot(), cors);
          break;
        case "GET /v1/schema":
          send(res, 200, llmOutputJsonSchema(), cors);
          break;
        default:
          throw new HttpError(404, "not_found", `no route for ${route}`);
      }
    } catch (e) {
      if (e instanceof ZodError) {
        send(res, 400, {
          error: {
            code: "validation",
            message: "request failed validation",
            issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            request_id: requestId,
          },
        }, cors);
      } else if (e instanceof HttpError) {
        send(res, e.status, { error: { code: e.code, message: e.message, request_id: requestId } }, cors);
      } else {
        log({ event: "error", request_id: requestId, message: (e as Error).message, stack: (e as Error).stack });
        send(res, 500, { error: { code: "internal", message: "internal error", request_id: requestId } }, cors);
      }
    } finally {
      log({ event: "http", request_id: requestId, method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
    }
  });

  server.requestTimeout = config.PROVIDER_TIMEOUT_MS * 4 + 5_000;
  server.headersTimeout = 15_000;
  return { server, deps };
}

export function main(): void {
  const config = loadConfig();
  const { server, deps } = createApp(config);
  server.listen(config.PORT, config.HOST, () => {
    const routes = deps.router.status().map((r) => `${r.route}${r.configured ? "" : " (no key)"}`).join(", ");
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "listening",
        url: `http://${config.HOST}:${config.PORT}`,
        routes,
        cache: config.CACHE_ENABLED,
        daily_token_budget: config.DAILY_TOKEN_BUDGET,
      }) + "\n",
    );
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) main();
