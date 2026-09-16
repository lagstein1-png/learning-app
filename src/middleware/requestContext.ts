/**
 * Attach a trace context to every request. Honours an incoming
 * `traceparent` (W3C Trace Context) so mobile clients can correlate their
 * own logs with ours, otherwise mints a new trace id.
 */
import type { RequestHandler } from "express";
import { newTraceId, runWithTrace, type TraceContext } from "../services/observability.js";
import { newId } from "../utils/hash.js";

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const USER_ID = /^[A-Za-z0-9_\-:.@]{1,128}$/;

declare module "express-serve-static-core" {
  interface Request {
    trace: TraceContext;
  }
}

export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const header = req.header("traceparent");
    const match = header !== undefined ? TRACEPARENT.exec(header) : null;
    const traceId = match?.[1]?.toLowerCase() ?? newTraceId();
    const rawUser = req.header("x-user-id");
    const userId = rawUser !== undefined && USER_ID.test(rawUser) ? rawUser : null;
    const ctx: TraceContext = { traceId, requestId: newId("req"), userId, spanId: null };
    req.trace = ctx;
    res.setHeader("x-request-id", ctx.requestId);
    res.setHeader("x-trace-id", ctx.traceId);
    runWithTrace(ctx, () => {
      next();
    });
  };
}
