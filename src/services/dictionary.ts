/**
 * Multilingual pronunciation override dictionary.
 *
 * Two storage backends implement the same `DictionaryStore` contract: an
 * in-memory store (tests, local development, and the moment Supabase is
 * unreachable) and a Supabase/Postgres store. `DictionaryService` sits on top
 * of either, caches lookups briefly, and performs the actual text rewrite.
 *
 * Precedence when the same term exists at several scopes:
 *   learner override  >  global override  >  annotation proposed by the AI layer
 * and among terms, longer surface forms win so "קמ"ש" beats "ק"מ".
 */
import { LIMITS } from "../config/constants.js";
import type { AppliedOverride, LanguageCode, PhoneticOverride, PhoneticOverrideInput } from "../types/index.js";
import { AppError } from "../utils/errors.js";
import { ERROR_CODES } from "../config/constants.js";
import { newId } from "../utils/hash.js";
import { termPattern } from "../utils/text.js";
import type { Observability } from "./observability.js";
import { overrideFromRow, overrideRowSchema, TABLES, type Db } from "./supabase.js";

export interface DictionaryStore {
  /** Global overrides plus those scoped to `userId` (when given), for one language. */
  list(language: LanguageCode, userId: string | null): Promise<PhoneticOverride[]>;
  /** Insert or update by (language, term, userId). Returns whether a new row was created. */
  upsert(input: PhoneticOverrideInput): Promise<{ override: PhoneticOverride; created: boolean }>;
  remove(id: string): Promise<boolean>;
}

function scopeKey(language: LanguageCode, term: string, userId: string | null): string {
  return `${language}\u0001${term.toLowerCase()}\u0001${userId ?? ""}`;
}

export class MemoryDictionaryStore implements DictionaryStore {
  private readonly rows = new Map<string, PhoneticOverride>();

  constructor(seed: readonly PhoneticOverrideInput[] = []) {
    for (const s of seed) this.insertRow(s, new Date().toISOString());
  }

  private insertRow(input: PhoneticOverrideInput, now: string, existing?: PhoneticOverride): PhoneticOverride {
    const row: PhoneticOverride = {
      id: existing?.id ?? newId("ovr"),
      language: input.language,
      term: input.term,
      spokenForm: input.spokenForm,
      ipa: input.ipa ?? null,
      userId: input.userId ?? null,
      domain: input.domain ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(scopeKey(row.language, row.term, row.userId), row);
    return row;
  }

  list(language: LanguageCode, userId: string | null): Promise<PhoneticOverride[]> {
    const out: PhoneticOverride[] = [];
    for (const row of this.rows.values()) {
      if (row.language !== language) continue;
      if (row.userId === null || row.userId === userId) out.push(row);
    }
    return Promise.resolve(out);
  }

  upsert(input: PhoneticOverrideInput): Promise<{ override: PhoneticOverride; created: boolean }> {
    const key = scopeKey(input.language, input.term, input.userId ?? null);
    const existing = this.rows.get(key);
    const override = this.insertRow(input, new Date().toISOString(), existing);
    return Promise.resolve({ override, created: existing === undefined });
  }

  remove(id: string): Promise<boolean> {
    for (const [key, row] of this.rows) {
      if (row.id === id) {
        this.rows.delete(key);
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  get size(): number {
    return this.rows.size;
  }
}

export class SupabaseDictionaryStore implements DictionaryStore {
  constructor(private readonly db: Db) {}

  async list(language: LanguageCode, userId: string | null): Promise<PhoneticOverride[]> {
    const scope = userId === null ? "user_id.is.null" : `user_id.is.null,user_id.eq.${userId}`;
    const { data, error } = await this.db.from(TABLES.overrides).select("*").eq("language", language).or(scope);
    if (error) throw new AppError(ERROR_CODES.STORAGE, `dictionary list failed: ${error.message}`, { retryable: true });
    const rows = overrideRowSchema.array().parse(data ?? []);
    return rows.map(overrideFromRow);
  }

  async upsert(input: PhoneticOverrideInput): Promise<{ override: PhoneticOverride; created: boolean }> {
    const userId = input.userId ?? null;
    let existingQuery = this.db.from(TABLES.overrides).select("*").eq("language", input.language).eq("term_key", input.term.toLowerCase());
    existingQuery = userId === null ? existingQuery.is("user_id", null) : existingQuery.eq("user_id", userId);
    const existing = await existingQuery.maybeSingle();
    if (existing.error) throw new AppError(ERROR_CODES.STORAGE, `dictionary lookup failed: ${existing.error.message}`, { retryable: true });

    const payload = {
      language: input.language,
      term: input.term,
      spoken_form: input.spokenForm,
      ipa: input.ipa ?? null,
      user_id: userId,
      domain: input.domain ?? null,
      updated_at: new Date().toISOString(),
    };

    if (existing.data !== null) {
      const row = overrideRowSchema.parse(existing.data);
      const { data, error } = await this.db.from(TABLES.overrides).update(payload).eq("id", row.id).select("*").single();
      if (error) throw new AppError(ERROR_CODES.STORAGE, `dictionary update failed: ${error.message}`, { retryable: true });
      return { override: overrideFromRow(overrideRowSchema.parse(data)), created: false };
    }
    const { data, error } = await this.db.from(TABLES.overrides).insert(payload).select("*").single();
    if (error) throw new AppError(ERROR_CODES.STORAGE, `dictionary insert failed: ${error.message}`, { retryable: true });
    return { override: overrideFromRow(overrideRowSchema.parse(data)), created: true };
  }

  async remove(id: string): Promise<boolean> {
    const { data, error } = await this.db.from(TABLES.overrides).delete().eq("id", id).select("id");
    if (error) throw new AppError(ERROR_CODES.STORAGE, `dictionary delete failed: ${error.message}`, { retryable: true });
    return Array.isArray(data) && data.length > 0;
  }
}

export interface ApplyResult {
  readonly text: string;
  readonly applied: readonly AppliedOverride[];
  /** spokenForm → IPA for terms that carry one, so SSML can emit `<phoneme>`. */
  readonly ipa: ReadonlyMap<string, string>;
}

export interface ExtraAnnotation {
  readonly term: string;
  readonly spokenForm: string;
}

interface Candidate {
  readonly term: string;
  readonly spokenForm: string;
  readonly ipa: string | null;
  readonly scope: "global" | "user";
  readonly priority: number;
}

export class DictionaryService {
  private readonly cache = new Map<string, { at: number; rows: PhoneticOverride[] }>();

  constructor(
    private readonly store: DictionaryStore,
    private readonly obs: Observability,
    private readonly cacheTtlMs = 30_000,
  ) {}

  /** Overrides applicable to this language and learner, cached for `cacheTtlMs`. */
  async resolve(language: LanguageCode, userId: string | null): Promise<PhoneticOverride[]> {
    const key = `${language}:${userId ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.rows;
    const rows = await this.obs.span("dictionary.resolve", { language, scoped: userId !== null }, async (setAttr) => {
      const list = await this.store.list(language, userId);
      setAttr("rows", list.length);
      return list;
    });
    this.cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  invalidate(language: LanguageCode, userId: string | null): void {
    this.cache.delete(`${language}:${userId ?? ""}`);
    if (userId === null) {
      for (const key of [...this.cache.keys()]) if (key.startsWith(`${language}:`)) this.cache.delete(key);
    }
  }

  async upsert(input: PhoneticOverrideInput): Promise<{ override: PhoneticOverride; created: boolean }> {
    const result = await this.store.upsert(input);
    this.invalidate(input.language, input.userId ?? null);
    return result;
  }

  async remove(id: string, language: LanguageCode, userId: string | null): Promise<boolean> {
    const ok = await this.store.remove(id);
    this.invalidate(language, userId);
    return ok;
  }

  /**
   * Rewrite `text`. Learner overrides beat global ones, both beat `extra`
   * (annotations proposed by the AI layer for this text only), and longer
   * terms are applied before shorter ones so they are never partially eaten.
   */
  apply(text: string, language: LanguageCode, overrides: readonly PhoneticOverride[], extra: readonly ExtraAnnotation[] = []): ApplyResult {
    const byTerm = new Map<string, Candidate>();
    const consider = (c: Candidate): void => {
      const k = c.term.toLowerCase();
      const cur = byTerm.get(k);
      if (!cur || c.priority > cur.priority) byTerm.set(k, c);
    };
    for (const o of overrides) {
      consider({ term: o.term, spokenForm: o.spokenForm, ipa: o.ipa, scope: o.userId === null ? "global" : "user", priority: o.userId === null ? 1 : 2 });
    }
    for (const a of extra) {
      if (a.term.trim().length === 0 || a.term === a.spokenForm) continue;
      consider({ term: a.term, spokenForm: a.spokenForm, ipa: null, scope: "global", priority: 0 });
    }
    const candidates = [...byTerm.values()].sort((a, b) => b.term.length - a.term.length);

    let out = text;
    const applied: AppliedOverride[] = [];
    const ipa = new Map<string, string>();
    for (const c of candidates) {
      const re = termPattern(c.term, language);
      let occurrences = 0;
      out = out.replace(re, (...args: unknown[]) => {
        occurrences += 1;
        const groups = args[args.length - 1] as { prefix?: string } | undefined;
        const prefix = groups?.prefix ?? "";
        return `${prefix}${c.spokenForm}`;
      });
      if (occurrences > 0) {
        applied.push({ term: c.term, spokenForm: c.spokenForm, occurrences, scope: c.scope });
        if (c.ipa) ipa.set(c.spokenForm, c.ipa);
      }
      if (out.length > LIMITS.maxInputChars * 2) {
        throw new AppError(ERROR_CODES.VALIDATION, "dictionary expansion exceeded the size limit", { details: { term: c.term } });
      }
    }
    return { text: out, applied, ipa };
  }
}
