/**
 * Shared-secret client authentication. Mobile builds embed the key; the
 * comparison is constant-time so timing cannot leak it. When no key is
 * configured the middleware is a pass-through (local development).
 */
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ERROR_CODES } from "../config/constants.js";
import { AppError } from "../utils/errors.js";

export function apiKeyAuth(expectedKey: string): RequestHandler {
  if (expectedKey.length === 0) {
    return (_req, _res, next) => {
      next();
    };
  }
  const expected = Buffer.from(expectedKey, "utf8");
  return (req, _res, next) => {
    const presented = req.header("x-api-key") ?? bearer(req.header("authorization"));
    if (presented === null) {
      next(new AppError(ERROR_CODES.UNAUTHORIZED, "missing x-api-key"));
      return;
    }
    const given = Buffer.from(presented, "utf8");
    const ok = given.byteLength === expected.byteLength && timingSafeEqual(given, expected);
    if (!ok) {
      next(new AppError(ERROR_CODES.UNAUTHORIZED, "invalid api key"));
      return;
    }
    next();
  };
}

function bearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1] ?? null;
}
