/**
 * Structured observability.
 *
 * Every log line is one JSON object with OpenTelemetry-style attribute names
 * (`trace_id`, `span_id`, `service.name`, `duration_ms`, `error.code`), so a
 * collector such as Phoenix, Grafana Loki or an OTLP bridge can index them
 * without a parsing step. Request context is propagated through
 * `AsyncLocalStorage`, so a span created deep inside the audio engine still
 * carries the trace id of the HTTP request that started it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import morgan from "morgan";
import winston from "winston";
import type { RequestHandler } from "express";
import { errorMessage, isAppError } from "../utils/errors.js";

export interface TraceContext {
  readonly traceId: string;
  readonly requestId: string;
  readonly userId: string | null;
  /** Parent span id for the currently executing span, if any. */
  readonly spanId: string | null;
}

export type SpanStatus = "ok" | "error";

export interface SpanRecord {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type Attributes = Record<string, string | number | boolean | null>;

const storage = new AsyncLocalStorage<TraceContext>();

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** The active trace context, or a detached one when called outside a request. */
export function currentTrace(): TraceContext {
  return storage.getStore() ?? { traceId: newTraceId(), requestId: "detached", userId: null, spanId: null };
}

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export interface ObservabilityOptions {
  readonly serviceName: string;
  readonly version: string;
  readonly level: "error" | "warn" | "info" | "http" | "debug";
  readonly environment: string;
  /** Extra transports for tests; defaults to a JSON console transport. */
  readonly transports?: winston.transport[];
  /** Optional sink receiving every finished span (for exporters or tests). */
  readonly spanSink?: (span: SpanRecord) => void;
}

export class Observability {
  readonly logger: winston.Logger;
  private readonly spanSink: ((span: SpanRecord) => void) | undefined;
  private readonly counters = new Map<string, number>();
  private readonly latencies = new Map<string, number[]>();

  constructor(private readonly options: ObservabilityOptions) {
    this.spanSink = options.spanSink;
    const traceFormat = winston.format((info) => {
      const ctx = storage.getStore();
      if (ctx) {
        info["trace_id"] = ctx.traceId;
        info["request_id"] = ctx.requestId;
        if (ctx.spanId) info["span_id"] = ctx.spanId;
        if (ctx.userId) info["user_id"] = ctx.userId;
      }
      info["service.name"] = options.serviceName;
      info["service.version"] = options.version;
      info["deployment.environment"] = options.environment;
      return info;
    });
    this.logger = winston.createLogger({
      level: options.level,
      levels: winston.config.npm.levels,
      format: winston.format.combine(
        winston.format.timestamp({ format: () => new Date().toISOString() }),
        winston.format.errors({ stack: true }),
        traceFormat(),
        winston.format.json(),
      ),
      transports: options.transports ?? [new winston.transports.Console()],
      exitOnError: false,
    });
  }

  /** Morgan middleware writing access logs through winston as structured JSON. */
  httpLogger(): RequestHandler {
    morgan.token("trace_id", () => storage.getStore()?.traceId ?? "-");
    morgan.token("request_id", () => storage.getStore()?.requestId ?? "-");
    const format = JSON.stringify({
      method: ":method",
      url: ":url",
      status: ":status",
      content_length: ":res[content-length]",
      response_time_ms: ":response-time",
      remote_addr: ":remote-addr",
      user_agent: ":user-agent",
      trace_id: ":trace_id",
      request_id: ":request_id",
    });
    return morgan(format, {
      stream: {
        write: (line: string): void => {
          const parsed = JSON.parse(line) as Record<string, string>;
          const status = Number(parsed["status"]);
          const level = status >= 500 ? "error" : status >= 400 ? "warn" : "http";
          this.logger.log(level, "http.request", {
            ...parsed,
            status,
            response_time_ms: Number(parsed["response_time_ms"]),
            content_length: parsed["content_length"] === "-" ? null : Number(parsed["content_length"]),
          });
        },
      },
    });
  }

  /**
   * Run `fn` as a span: timing, status, error code and attributes are logged
   * as one record when it finishes. Nested spans see this span as parent.
   */
  async span<T>(name: string, attributes: Attributes, fn: (setAttr: (key: string, value: string | number | boolean | null) => void) => Promise<T>): Promise<T> {
    const parent = storage.getStore();
    const spanId = newSpanId();
    const ctx: TraceContext = parent
      ? { ...parent, spanId }
      : { traceId: newTraceId(), requestId: "detached", userId: null, spanId };
    const attrs: Attributes = { ...attributes };
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const setAttr = (key: string, value: string | number | boolean | null): void => {
      attrs[key] = value;
    };
    try {
      const result = await storage.run(ctx, () => fn(setAttr));
      this.finishSpan(name, ctx, parent?.spanId ?? null, startedAt, performance.now() - t0, "ok", attrs, null, null);
      return result;
    } catch (error) {
      const code = isAppError(error) ? error.code : error instanceof Error ? error.name : "E_UNKNOWN";
      this.finishSpan(name, ctx, parent?.spanId ?? null, startedAt, performance.now() - t0, "error", attrs, code, errorMessage(error));
      throw error;
    }
  }

  private finishSpan(
    name: string,
    ctx: TraceContext,
    parentSpanId: string | null,
    startedAt: string,
    durationMs: number,
    status: SpanStatus,
    attributes: Attributes,
    errorCode: string | null,
    errorMsg: string | null,
  ): void {
    const record: SpanRecord = {
      name,
      traceId: ctx.traceId,
      spanId: ctx.spanId ?? "",
      parentSpanId,
      startedAt,
      durationMs: Math.round(durationMs * 100) / 100,
      status,
      attributes,
      errorCode,
      errorMessage: errorMsg,
    };
    this.recordLatency(name, record.durationMs);
    this.increment(`span.${name}.${status}`);
    this.logger.log(status === "ok" ? "debug" : "warn", "span", {
      span_name: name,
      span_id: record.spanId,
      parent_span_id: parentSpanId,
      trace_id: ctx.traceId,
      started_at: startedAt,
      duration_ms: record.durationMs,
      status,
      ...prefixed("attr", attributes),
      "error.code": errorCode,
      "error.message": errorMsg,
    });
    this.spanSink?.(record);
  }

  increment(counter: string, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
  }

  private recordLatency(name: string, ms: number): void {
    const arr = this.latencies.get(name) ?? [];
    arr.push(ms);
    if (arr.length > 1000) arr.shift();
    this.latencies.set(name, arr);
  }

  /** Counters and p50/p95 latencies per span name, for `/metrics`-style profiling. */
  metrics(): { counters: Record<string, number>; latencies: Record<string, { count: number; p50: number; p95: number; max: number }> } {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const latencies: Record<string, { count: number; p50: number; p95: number; max: number }> = {};
    for (const [k, arr] of this.latencies) {
      const sorted = [...arr].sort((a, b) => a - b);
      const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      latencies[k] = { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
    }
    return { counters, latencies };
  }

  info(message: string, meta: Attributes = {}): void {
    this.logger.info(message, meta);
  }

  warn(message: string, meta: Attributes = {}): void {
    this.logger.warn(message, meta);
  }

  error(message: string, error: unknown, meta: Attributes = {}): void {
    this.logger.error(message, {
      ...meta,
      "error.code": isAppError(error) ? error.code : error instanceof Error ? error.name : "E_UNKNOWN",
      "error.message": errorMessage(error),
      "error.stack": error instanceof Error ? (error.stack ?? null) : null,
    });
  }

  debug(message: string, meta: Attributes = {}): void {
    this.logger.debug(message, meta);
  }

  get serviceName(): string {
    return this.options.serviceName;
  }
}

function prefixed(prefix: string, attrs: Attributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) out[`${prefix}.${k}`] = v;
  return out;
}
