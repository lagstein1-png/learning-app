/**
 * The TTS pipeline: a compiled state graph plus the plan store that connects
 * `/process-text` to `/get-audio`.
 *
 *   preprocess ─▶ dictionary ─▶ emphasis ─▶ voice ─▶ chunk ─▶ END
 *
 * `preprocess` may route straight to END when nothing is left to speak.
 * Each node is a pure function of the state apart from the I/O it declares
 * (Gemini, the dictionary store, user preferences); the audio engine is not
 * part of the graph because audio is produced lazily, chunk by chunk, when
 * the client asks for it.
 */
import { DEFAULT_CADENCE, DEFAULT_GENDER, DEFAULT_MOOD, ERROR_CODES, LANGUAGES, LIMITS } from "../config/constants.js";
import type { AccessibilityPreferences, AppliedOverride, ChunkPlan, EmphasisMarker, LanguageCode, PhoneticOverride, PreprocessResult, ProcessTextRequest, ProcessTextResponse, VoiceSelection } from "../types/index.js";
import { AppError } from "../utils/errors.js";
import { newId, stableHash } from "../utils/hash.js";
import type { AudioEngine, ChunkOutcome, ChunkSynthesisInput } from "../services/audioEngine.js";
import { chunkText, clampChunkChars } from "../services/chunker.js";
import type { DictionaryService } from "../services/dictionary.js";
import type { Observability } from "../services/observability.js";
import { locateEmphasis, type Preprocessor } from "../services/preprocessor.js";
import type { UserStateService } from "../services/userState.js";
import type { VoiceSelector } from "../services/voiceSelector.js";
import { END, StateGraph, type CompiledGraph } from "./graph.js";

/** Narrow a state field that an earlier node is guaranteed to have filled. */
function must<T>(value: T | null, field: string): T {
  if (value === null) throw new AppError(ERROR_CODES.INTERNAL, `pipeline state field "${field}" missing`);
  return value;
}

export interface TtsState {
  readonly request: ProcessTextRequest;
  readonly userId: string | null;
  readonly preferences: AccessibilityPreferences;
  readonly preprocess: PreprocessResult | null;
  readonly overrides: readonly PhoneticOverride[];
  readonly applied: readonly AppliedOverride[];
  readonly ipa: ReadonlyMap<string, string>;
  readonly text: string;
  readonly emphasis: readonly EmphasisMarker[];
  readonly selection: VoiceSelection | null;
  readonly plan: ChunkPlan | null;
  readonly timings: Readonly<Record<string, number>>;
}

export interface StoredPlan {
  readonly token: string;
  readonly response: ProcessTextResponse;
  readonly inputs: readonly ChunkSynthesisInput[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** In-memory plan store with TTL and a size cap; plans are cheap to rebuild. */
export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxItems: number,
    private readonly now: () => number = Date.now,
  ) {}

  put(plan: Omit<StoredPlan, "createdAt" | "expiresAt">): StoredPlan {
    const stored: StoredPlan = { ...plan, createdAt: this.now(), expiresAt: this.now() + this.ttlMs };
    this.plans.set(plan.token, stored);
    while (this.plans.size > this.maxItems) {
      const oldest = this.plans.keys().next();
      if (oldest.done) break;
      this.plans.delete(oldest.value);
    }
    return stored;
  }

  get(token: string): StoredPlan {
    const plan = this.plans.get(token);
    if (!plan) throw new AppError(ERROR_CODES.NOT_FOUND, "unknown plan token");
    if (plan.expiresAt <= this.now()) {
      this.plans.delete(token);
      throw new AppError(ERROR_CODES.PLAN_EXPIRED, "plan token expired; call /process-text again");
    }
    return plan;
  }

  get size(): number {
    return this.plans.size;
  }
}

export interface PipelineDeps {
  readonly preprocessor: Preprocessor;
  readonly dictionary: DictionaryService;
  readonly userState: UserStateService;
  readonly selector: VoiceSelector;
  readonly engine: AudioEngine;
  readonly plans: PlanStore;
  readonly obs: Observability;
}

export class TtsPipeline {
  private readonly graph: CompiledGraph<TtsState>;

  constructor(private readonly deps: PipelineDeps) {
    this.graph = this.buildGraph().compile(deps.obs);
  }

  private buildGraph(): StateGraph<TtsState> {
    const { preprocessor, dictionary, selector } = this.deps;
    const timed = async <T>(state: TtsState, key: string, fn: () => Promise<T>): Promise<{ value: T; timings: Record<string, number> }> => {
      const t0 = performance.now();
      const value = await fn();
      return { value, timings: { ...state.timings, [key]: Math.round(performance.now() - t0) } };
    };

    return new StateGraph<TtsState>("tts")
      .setEntry("preprocess")
      .addNode("preprocess", async (state) => {
        const { value, timings } = await timed(state, "preprocess_ms", () =>
          preprocessor.process(state.request.text, {
            language: state.request.language,
            ...(state.request.skipAi !== undefined ? { skipAi: state.request.skipAi } : {}),
            ...(state.request.domain !== undefined ? { domain: state.request.domain } : {}),
          }),
        );
        return { preprocess: value, text: value.text, timings };
      })
      .addConditionalEdge("preprocess", (state) => (state.text.trim().length === 0 ? END : "dictionary"))
      .addNode("dictionary", async (state) => {
        const pre = must(state.preprocess, "preprocess");
        const { value, timings } = await timed(state, "dictionary_ms", async () => {
          const overrides = await dictionary.resolve(state.request.language, state.userId);
          const extra = [
            ...pre.phoneticAnnotations,
            ...pre.homographs.map((h) => ({ term: h.surface, spokenForm: h.reading })),
          ];
          const applied = dictionary.apply(pre.text, state.request.language, overrides, extra);
          return { overrides, applied };
        });
        return { overrides: value.overrides, applied: value.applied.applied, ipa: value.applied.ipa, text: value.applied.text, timings };
      })
      .addEdge("dictionary", "emphasis")
      .addNode("emphasis", (state) => {
        const pre = must(state.preprocess, "preprocess");
        return Promise.resolve({ emphasis: locateEmphasis(state.text, pre.emphasis) });
      })
      .addEdge("emphasis", "voice")
      .addNode("voice", (state) => {
        const pre = must(state.preprocess, "preprocess");
        const selection = selector.select({
          language: state.request.language,
          gender: state.request.gender ?? state.preferences.gender,
          cadence: state.request.cadence ?? state.preferences.cadence,
          mood: state.request.mood ?? (pre.source === "gemini" ? pre.mood : state.preferences.mood),
        });
        return Promise.resolve({ selection });
      })
      .addEdge("voice", "chunk")
      .addNode("chunk", (state) => {
        const selection = must(state.selection, "selection");
        const maxChars = clampChunkChars(state.request.maxChunkChars ?? state.preferences.maxChunkChars);
        const prosodyKey = JSON.stringify(selection.prosody);
        const plan = chunkText(state.text, {
          language: state.request.language,
          maxChars,
          rate: selection.prosody.rate,
          cacheKeyFor: (chunk, boundary) => stableHash(state.request.language, selection.primary.id, prosodyKey, boundary, chunk),
        });
        return Promise.resolve({ plan });
      })
      .addEdge("chunk", END);
  }

  /** Run the graph and store the plan. */
  async process(request: ProcessTextRequest, userId: string | null, requestId: string): Promise<ProcessTextResponse> {
    const language: LanguageCode = request.language;
    const preferences = await this.deps.userState.preferencesFor(userId, language);
    const initial: TtsState = {
      request,
      userId,
      preferences: preferences.userId === "anonymous" ? { ...preferences, gender: DEFAULT_GENDER, cadence: DEFAULT_CADENCE, mood: DEFAULT_MOOD } : preferences,
      preprocess: null,
      overrides: [],
      applied: [],
      ipa: new Map(),
      text: "",
      emphasis: [],
      selection: null,
      plan: null,
      timings: {},
    };
    const t0 = performance.now();
    const run = await this.graph.invoke(initial);
    const state = run.state;
    if (state.preprocess === null || state.text.trim().length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION, "nothing left to speak after normalisation");
    }
    const selection = state.selection;
    const plan = state.plan;
    if (selection === null || plan === null) {
      throw new AppError(ERROR_CODES.INTERNAL, "pipeline ended without a plan");
    }

    const token = newId("plan");
    const response: ProcessTextResponse = {
      requestId,
      language,
      direction: LANGUAGES[language].direction,
      preprocess: { ...state.preprocess, text: state.text, emphasis: state.emphasis },
      overrides: state.applied,
      voice: {
        id: selection.primary.id,
        provider: selection.primary.provider,
        displayName: selection.primary.displayName,
        gender: selection.primary.gender,
        fallbacks: selection.fallbacks.map((v) => v.id),
        prosody: selection.prosody,
        deviceHint: selection.deviceHint,
      },
      plan,
      planToken: token,
      timings: { ...state.timings, graph_ms: Math.round(performance.now() - t0), ...Object.fromEntries(run.trace.map((t) => [`node_${t.node}_ms`, t.durationMs])) },
    };
    const inputs: ChunkSynthesisInput[] = plan.chunks.map((chunk) => ({ chunk, language, selection, emphasis: state.emphasis, ipa: state.ipa }));
    this.deps.plans.put({ token, response, inputs });
    this.deps.obs.info("plan created", { request_id: requestId, language, chunks: plan.chunks.length, chars: state.text.length, voice: selection.primary.id, source: state.preprocess.source });
    return response;
  }

  /** The stored plan for a token; throws 404/410 as appropriate. */
  plan(token: string): StoredPlan {
    return this.deps.plans.get(token);
  }

  /** Audio for the whole plan, chunk by chunk, in order. */
  stream(token: string): AsyncGenerator<ChunkOutcome, void, undefined> {
    const stored = this.deps.plans.get(token);
    return this.deps.engine.stream(stored.inputs);
  }

  /** Audio for exactly one chunk of a plan. */
  chunk(token: string, index: number): Promise<ChunkOutcome> {
    const stored = this.deps.plans.get(token);
    const input = stored.inputs[index];
    if (input === undefined) throw new AppError(ERROR_CODES.NOT_FOUND, `chunk ${index} not in plan (0..${stored.inputs.length - 1})`);
    return this.deps.engine.synthesizeChunk(input);
  }

  static readonly limits = LIMITS;
}
