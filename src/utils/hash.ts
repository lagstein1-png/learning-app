import { createHash, randomUUID } from "node:crypto";

/** Deterministic short SHA-256 hex of the concatenated parts. */
export function stableHash(...parts: readonly (string | number | boolean | null | undefined)[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(String(p ?? ""));
    h.update("|");
  }
  return h.digest("hex").slice(0, 32);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
