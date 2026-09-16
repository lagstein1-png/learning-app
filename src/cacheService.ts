/**
 * LAYER C — Semantic cache and cost ledger.
 *
 * The cache answers one question: "have we already produced an equivalent
 * module?" Equivalence is approximate: the request text (topic + context) is
 * turned into a hashed bag of word unigrams and character trigrams, and two
 * requests match when the cosine similarity of those vectors passes a
 * threshold. Language, module type and difficulty are hard partitions — a
 * Hebrew quiz never answers an Arabic explanation, however similar the topic.
 *
 * Storage is behind a tiny async interface so an in-memory Map (default) and
 * a Redis hash can be swapped without touching the pipeline. The in-memory
 * store is what runs here; it is bounded (LRU) and expires entries by TTL.
 *
 * The ledger counts tokens per provider and model per UTC day. It converts to
 * money only when a price table is configured; otherwise `estimated_usd` is
 * null rather than a guess.
 */
import { createHash } from "node:crypto";
import type { GenerateRequest, LearningPayload, Usage } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Text -> sparse vector
// ---------------------------------------------------------------------------

const DIMENSIONS = 4096;

export function normaliseForSimilarity(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "") // Hebrew nikud
    .replace(/[ً-ٰٟـ]/g, "") // Arabic tashkeel + tatweel
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export type SparseVector = Map<number, number>;

export function vectorise(text: string): SparseVector {
  const v: SparseVector = new Map();
  const norm = normaliseForSimilarity(text);
  if (!norm) return v;
  const bump = (key: string, w: number) => {
    const idx = fnv1a(key) % DIMENSIONS;
    v.set(idx, (v.get(idx) ?? 0) + w);
  };
  for (const word of norm.split(" ")) {
    bump("w:" + word, 2);
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) bump("t:" + padded.slice(i, i + 3), 1);
  }
  // L2-normalise so cosine is a dot product.
  let sum = 0;
  for (const x of v.values()) sum += x * x;
  const len = Math.sqrt(sum) || 1;
  for (const [k, x] of v) v.set(k, x / len);
  return v;
}

export function cosine(a: SparseVector, b: SparseVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) {
    const y = large.get(k);
    if (y !== undefined) dot += x * y;
  }
  return Math.min(1, Math.max(0, dot));
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface CacheEntry {
  key: string;
  partition: string;
  text: string;
  vector: [number, number][];
  payload: LearningPayload;
  created_at: number;
  expires_at: number;
  hits: number;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** All live entries of one partition, for the similarity scan. */
  scan(partition: string): Promise<CacheEntry[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

/** Bounded in-memory store: Map insertion order doubles as the LRU list. */
export class InMemoryStore implements CacheStore {
  private readonly map = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(maxEntries: number, now: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires_at <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Touch: move to the end.
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }
  async set(entry: CacheEntry): Promise<void> {
    this.map.delete(entry.key);
    this.map.set(entry.key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async scan(partition: string): Promise<CacheEntry[]> {
    const t = this.now();
    const out: CacheEntry[] = [];
    for (const [k, e] of this.map) {
      if (e.expires_at <= t) {
        this.map.delete(k);
        continue;
      }
      if (e.partition === partition) out.push(e);
    }
    return out;
  }
  async size(): Promise<number> {
    return this.map.size;
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Semantic cache
// ---------------------------------------------------------------------------

export interface SemanticCacheOptions {
  enabled: boolean;
  threshold: number;
  ttlSeconds: number;
  store: CacheStore;
  now?: () => number;
}

export interface CacheLookup {
  hit: boolean;
  similarity: number | null;
  key: string | null;
  payload: LearningPayload | null;
  /** True when the match was byte-exact rather than semantic. */
  exact: boolean;
}

export class SemanticCache {
  private lookups = 0;
  private hits = 0;
  private readonly now: () => number;
  private readonly opts: SemanticCacheOptions;

  constructor(opts: SemanticCacheOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  static partitionOf(req: GenerateRequest): string {
    return `${req.language}|${req.module_type}|${req.difficulty}|${req.learner_profile.reading_level}`;
  }

  static textOf(req: GenerateRequest): string {
    return req.context ? `${req.topic}\n${req.context}` : req.topic;
  }

  static keyOf(req: GenerateRequest): string {
    const raw = `${SemanticCache.partitionOf(req)}|${normaliseForSimilarity(SemanticCache.textOf(req))}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 24);
  }

  async lookup(req: GenerateRequest): Promise<CacheLookup> {
    const miss: CacheLookup = { hit: false, similarity: null, key: null, payload: null, exact: false };
    if (!this.opts.enabled || req.bypass_cache) return miss;
    this.lookups++;

    const key = SemanticCache.keyOf(req);
    const exact = await this.opts.store.get(key);
    if (exact) {
      exact.hits++;
      this.hits++;
      return { hit: true, similarity: 1, key, payload: exact.payload, exact: true };
    }

    const query = vectorise(SemanticCache.textOf(req));
    let best: CacheEntry | null = null;
    let bestScore = 0;
    for (const e of await this.opts.store.scan(SemanticCache.partitionOf(req))) {
      const score = cosine(query, new Map(e.vector));
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best && bestScore >= this.opts.threshold) {
      best.hits++;
      this.hits++;
      return { hit: true, similarity: round4(bestScore), key: best.key, payload: best.payload, exact: false };
    }
    return { ...miss, similarity: best ? round4(bestScore) : null };
  }

  async store(req: GenerateRequest, payload: LearningPayload): Promise<string | null> {
    if (!this.opts.enabled) return null;
    const key = SemanticCache.keyOf(req);
    const text = SemanticCache.textOf(req);
    const t = this.now();
    await this.opts.store.set({
      key,
      partition: SemanticCache.partitionOf(req),
      text,
      vector: [...vectorise(text)],
      payload,
      created_at: t,
      expires_at: t + this.opts.ttlSeconds * 1000,
      hits: 0,
    });
    return key;
  }

  async stats(): Promise<{ enabled: boolean; entries: number; lookups: number; hits: number; hit_rate: number; threshold: number }> {
    return {
      enabled: this.opts.enabled,
      entries: await this.opts.store.size(),
      lookups: this.lookups,
      hits: this.hits,
      hit_rate: this.lookups ? round4(this.hits / this.lookups) : 0,
      threshold: this.opts.threshold,
    };
  }

  async clear(): Promise<void> {
    await this.opts.store.clear();
  }
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

export interface PriceEntry {
  input_per_1m: number;
  output_per_1m: number;
}

export interface LedgerSnapshot {
  day: string;
  tokens_used_today: number;
  daily_token_budget: number;
  remaining_tokens: number;
  estimated_usd_today: number | null;
  by_model: Record<string, Usage & { calls: number; estimated_usd: number | null }>;
  cache_saved_calls: number;
}

export class CostLedger {
  private day = "";
  private byModel = new Map<string, Usage & { calls: number }>();
  private cacheSavedCalls = 0;
  private readonly dailyTokenBudget: number;
  private readonly prices: Record<string, PriceEntry>;
  private readonly now: () => number;

  constructor(dailyTokenBudget: number, prices: Record<string, PriceEntry>, now: () => number = Date.now) {
    this.dailyTokenBudget = dailyTokenBudget;
    this.prices = prices;
    this.now = now;
  }

  private rollover(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.byModel = new Map();
      this.cacheSavedCalls = 0;
    }
  }

  record(model: string, usage: Usage): void {
    this.rollover();
    const cur = this.byModel.get(model) ?? { input_tokens: 0, output_tokens: 0, calls: 0 };
    cur.input_tokens += usage.input_tokens;
    cur.output_tokens += usage.output_tokens;
    cur.calls += 1;
    this.byModel.set(model, cur);
  }

  recordCacheHit(): void {
    this.rollover();
    this.cacheSavedCalls++;
  }

  tokensUsedToday(): number {
    this.rollover();
    let t = 0;
    for (const u of this.byModel.values()) t += u.input_tokens + u.output_tokens;
    return t;
  }

  /** True when a paid call is still allowed. A budget of 0 disables paid routes. */
  canSpend(estimatedTokens: number): boolean {
    if (this.dailyTokenBudget === 0) return false;
    return this.tokensUsedToday() + estimatedTokens <= this.dailyTokenBudget;
  }

  private usd(model: string, u: Usage): number | null {
    const p = this.prices[model];
    if (!p) return null;
    return (u.input_tokens * p.input_per_1m + u.output_tokens * p.output_per_1m) / 1_000_000;
  }

  snapshot(): LedgerSnapshot {
    this.rollover();
    const by_model: LedgerSnapshot["by_model"] = {};
    let usd: number | null = 0;
    for (const [m, u] of this.byModel) {
      const e = this.usd(m, u);
      by_model[m] = { ...u, estimated_usd: e === null ? null : round6(e) };
      if (e === null) usd = null;
      else if (usd !== null) usd += e;
    }
    if (this.byModel.size === 0) usd = 0;
    const used = this.tokensUsedToday();
    return {
      day: this.day,
      tokens_used_today: used,
      daily_token_budget: this.dailyTokenBudget,
      remaining_tokens: Math.max(0, this.dailyTokenBudget - used),
      estimated_usd_today: usd === null ? null : round6(usd),
      by_model,
      cache_saved_calls: this.cacheSavedCalls,
    };
  }
}

function round6(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}
