import { loadConfig, type Config } from "../src/config.ts";
import type { LlmCallInput, LlmCallResult, LlmClient, Provider } from "../src/llmClient.ts";
import { LlmError } from "../src/llmClient.ts";
import type { LlmOutput, ModuleDraft } from "../src/schemas.ts";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    PORT: "0",
    CACHE_ENABLED: "true",
    RATE_LIMIT_PER_MINUTE: "1000",
    PROVIDER_TIMEOUT_MS: "2000",
    CIRCUIT_FAILURE_THRESHOLD: "2",
    CIRCUIT_COOLDOWN_MS: "60000",
    ...overrides,
  });
}

export function moduleDraft(over: Partial<ModuleDraft> = {}): ModuleDraft {
  return {
    title: "Right of way",
    raw_text: "You reach a junction with no signs. A car comes from the right. Who goes first?",
    language_code: "en-US",
    voice_preference: "male_clear",
    ui_metadata: {
      layout: "quiz",
      options: ["The car from the right", "You", "The faster car", "The bigger car"],
      correct_index: 0,
      explanation: "With no signs, the vehicle from the right has priority.",
    },
    ...over,
  };
}

export type Script = Array<LlmOutput | LlmError | ((input: LlmCallInput) => LlmOutput | LlmError)>;

/** A scripted provider: each call consumes the next step of the script. */
export class FakeClient implements LlmClient {
  readonly provider: Provider;
  readonly model: string;
  readonly configured: boolean;
  readonly calls: LlmCallInput[] = [];
  private readonly script: Script;
  constructor(provider: Provider, model: string, script: Script, configured = true) {
    this.provider = provider;
    this.model = model;
    this.script = script;
    this.configured = configured;
  }
  async call(input: LlmCallInput, signal: AbortSignal): Promise<LlmCallResult> {
    this.calls.push(input);
    const step = this.script.shift();
    if (step === undefined) throw new LlmError("server", this.provider, this.model, "script exhausted");
    const out = typeof step === "function" ? step(input) : step;
    if (out instanceof LlmError) {
      if (out.kind === "timeout") {
        await new Promise((r) => setTimeout(r, 30));
        if (signal.aborted) throw out;
      }
      throw out;
    }
    return { output: out, usage: { input_tokens: 100, output_tokens: 50 }, provider: this.provider, model: this.model };
  }
}

export const okModule = (over: Partial<ModuleDraft> = {}): LlmOutput => ({ kind: "module", module: moduleDraft(over), tool_call: null });
export const toolCall = (name: "calculator" | "unit_convert" | "date_diff", args: unknown): LlmOutput => ({
  kind: "tool_call",
  module: null,
  tool_call: { name, arguments_json: JSON.stringify(args), reason: "needs exact number" },
});
