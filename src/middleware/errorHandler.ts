/**
 * Final error boundary. Every failure becomes an `ApiErrorBody` with a
 * stable code and the request id, so a mobile client can branch on `code`
 * and support can find the trace. Unknown errors never leak their message
 * in production.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { ERROR_CODES } from "../config/constants.js";
import type { Observability } from "../services/observability.js";
import type { ApiErrorBody } from "../types/index.js";
import { AppError, isAppError } from "../utils/errors.js";
import { RateLimitExceededError } from "../utils/rateLimiter.js";

export function notFound(): RequestHandler {
  return (req, _res, next) => {
    next(new AppError(ERROR_CODES.NOT_FOUND, `no route for ${req.method} ${req.path}`));
  };
}

export function errorHandler(obs: Observability, exposeInternal: boolean): ErrorRequestHandler {
  // Express recognises error handlers by their four parameters; `_next` must stay.
  return (error: unknown, req, res, _next) => {
    const requestId = req.trace.requestId;
    const app = toAppError(error, exposeInternal);
    if (app.status >= 500) obs.error("request failed", error, { request_id: requestId, path: req.path, status: app.status });
    else obs.warn("request rejected", { request_id: requestId, path: req.path, status: app.status, code: app.code, message: app.message });
    if (res.headersSent) {
      res.end();
      return;
    }
    const body: ApiErrorBody = {
      error: {
        code: app.code,
        message: app.message,
        requestId,
        ...(app.details !== undefined ? { details: app.details } : {}),
      },
    };
    res.status(app.status).json(body);
  };
}

function toAppError(error: unknown, exposeInternal: boolean): AppError {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) {
    return new AppError(ERROR_CODES.VALIDATION, "invalid request", {
      details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (error instanceof RateLimitExceededError) {
    return new AppError(ERROR_CODES.RATE_LIMITED, "too many synthesis requests; retry shortly", { retryable: true });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return new AppError(ERROR_CODES.VALIDATION, "malformed JSON body");
  }
  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    return new AppError(ERROR_CODES.VALIDATION, "request body too large", { status: 413 });
  }
  const message = exposeInternal && error instanceof Error ? error.message : "internal error";
  return new AppError(ERROR_CODES.INTERNAL, message, { cause: error });
}
