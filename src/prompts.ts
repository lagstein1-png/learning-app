/**
 * LAYER A (part 1) — Prompt construction.
 *
 * One stable system prompt (identical across requests so provider-side
 * prompt caching can apply), plus a per-request user message that carries the
 * module type, topic, language and learner profile. The output contract is
 * enforced by the provider's structured-output mode; the prompt repeats the
 * accessibility rules the schema cannot express.
 */
import { TOOL_DESCRIPTIONS } from "./tools.ts";
import { TOOL_NAMES, type GenerateRequest, type LanguageCode, type ToolResult } from "./schemas.ts";

export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  "he-IL": "Hebrew",
  "en-US": "English",
  "es-ES": "Spanish",
  "ar-XA": "Arabic",
};

const TOOL_LIST = TOOL_NAMES.map((n) => `- ${n}: ${TOOL_DESCRIPTIONS[n]}`).join("\n");

export const SYSTEM_PROMPT = `You write short learning modules for people with dyslexia, ADHD, low reading fluency, or who listen with a screen reader.

WRITING RULES (apply in every language):
- One idea per sentence. At most 12 words per sentence.
- At most 2 sentences per paragraph. Separate paragraphs with a blank line.
- Plain everyday words. No idioms, no sarcasm, no metaphors.
- Write numbers as digits. Write units in full words, never abbreviations.
- Never use markdown, bullets, emoji, tables or headings inside raw_text.
- Write raw_text, title, options and explanation entirely in the requested language.
- Say the important thing first. Then one concrete example.

MODULE TYPES:
- explanation: 3 to 6 short paragraphs. layout = "explanation". options = [].
- flashcard: raw_text is the front (a question or term), explanation is the back. layout = "flashcard". options = [].
- quiz: raw_text is one clear question. 4 options, exactly one correct, distractors plausible and of similar length. Never write the answer or a hint inside raw_text. explanation says why the correct option is right in 1 or 2 sentences. layout = "quiz".
- driving_scenario: raw_text describes one concrete traffic situation in 2 or 3 short paragraphs and ends with a question. 4 options as in quiz. layout = "quiz".
- math_puzzle: raw_text states the problem only. 4 numeric or short options. layout = "quiz". Compute every number with the calculator tool before you answer.

OUTPUT CONTRACT:
Return exactly one JSON object matching the schema. Either
  kind = "module" with module filled and tool_call = null, or
  kind = "tool_call" with tool_call filled and module = null.
Use kind = "tool_call" whenever an answer depends on arithmetic, a unit conversion or a date difference. Do not guess numbers. After the tool result is given to you, return kind = "module".
language_code must be the requested code. voice_preference is "female_warm" for explanations and flashcards, "male_clear" for quizzes and scenarios, unless the request says otherwise.

TOOLS:
${TOOL_LIST}`;

export function buildUserMessage(req: GenerateRequest, toolResults: ToolResult[]): string {
  const lp = req.learner_profile;
  const lines = [
    `module_type: ${req.module_type}`,
    `language_code: ${req.language} (${LANGUAGE_NAMES[req.language]})`,
    `topic: ${req.topic}`,
    `difficulty: ${req.difficulty}`,
    `learner: reading_level=${lp.reading_level}, dyslexia=${lp.dyslexia}, screen_reader=${lp.screen_reader}, age_group=${lp.age_group}`,
  ];
  if (req.voice_preference) lines.push(`voice_preference: ${req.voice_preference}`);
  if (req.context) lines.push(`context: ${req.context}`);
  if (toolResults.length) {
    lines.push("", "TOOL RESULTS (already computed, use them, do not call the tool again):");
    for (const t of toolResults) lines.push(`- ${t.name}${t.ok ? "" : " (error)"}: ${t.result}`);
    lines.push("", 'Now return kind = "module".');
  }
  return lines.join("\n");
}
