import { ERROR_CODES, type ErrorCode } from "../config/constants.js";

/** Error carrying a stable client-facing code and an HTTP status. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  /** Whether a retry of the same call could succeed. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.VALIDATION:
      return 400;
    case ERROR_CODES.UNAUTHORIZED:
      return 401;
    case ERROR_CODES.NOT_FOUND:
      return 404;
    case ERROR_CODES.PLAN_EXPIRED:
      return 410;
    case ERROR_CODES.RATE_LIMITED:
      return 429;
    case ERROR_CODES.PROVIDER_UNAVAILABLE:
      return 503;
    case ERROR_CODES.PREPROCESS_FAILED:
      return 502;
    case ERROR_CODES.STORAGE:
      return 503;
    case ERROR_CODES.INTERNAL:
      return 500;
  }
}

/** Error raised by an HTTP provider call, keeping the status for retry decisions. */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: string;

  constructor(provider: string, status: number, body: string) {
    super(`${provider} responded ${status}: ${body.slice(0, 200)}`);
    this.name = "ProviderHttpError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return JSON.stringify(e);
}
