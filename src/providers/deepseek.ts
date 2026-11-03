import { formatReasoningContext } from "../state.js";
import type { AIBuyRecommendation, AIProvider, AIProviderInput } from "./types.js";
import { buildObservationPrompt, buildDecisionPrompt, type TickerObservation } from "./prompts.js";
import { observationSchema, decisionSchema } from "./schemas.js";

// ── DeepSeek provider ──────────────────────────────────────────────
// Uses DeepSeek's OpenAI-compatible chat-completions endpoint over native
// fetch — same approach as the Mistral provider. An independent model lineage
// from Gemini/Claude, based in China (reachable WITHOUT a proxy), and cheap
// enough (~¥0.01/run) to serve as the second voice in multi-AI mode.
//
// Structured output: DeepSeek does NOT support `response_format: json_schema`
// (returns 400 "This response_format type is unavailable now") — only
// `json_object`. So the JSON Schema is embedded in the prompt itself and
// decoding is constrained to "some JSON object" rather than one exact shape.
// Responses are still parsed defensively: code fences are stripped before
// JSON.parse in case the model wraps its answer.

const API_URL = "https://api.deepseek.com/chat/completions";

const DEFAULT_MODEL = "deepseek-chat";

// Matches Mistral's ceiling and for the same reason: Stage 1 emits one verbose
// observation per ticker across the whole universe. A cap, not a cost.
const MAX_OUTPUT_TOKENS = 16384;

interface DeepSeekResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
}

/** The model this run uses — env override, else the default. */
export function deepseekModel(): string {
  return process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
}

/**
 * json_object mode constrains decoding to "an object" but not to a schema, so
 * the schema travels in the prompt. Appended as a fenced block with explicit
 * instructions — DeepSeek requires the word "json" in the messages for this
 * mode, which these instructions naturally provide.
 */
function withSchemaInstructions(prompt: string, schema: unknown, rootKey: string): string {
  return (
    `${prompt}\n\n` +
    `# Output format (STRICT)\n\n` +
    `Respond with ONLY a single JSON object — no prose, no markdown fences — ` +
    `conforming exactly to this JSON Schema (the top-level object must have ` +
    `the "${rootKey}" key):\n\n` +
    "```json\n" +
    JSON.stringify(schema, null, 2) +
    "\n```\n"
  );
}

/** Defensive unwrap: models occasionally wrap JSON in ``` fences. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * One JSON-object call, with retry on the transient failures (429, 5xx).
 *
 * Exported so detailedAnalysis.ts can generate the STRONG BUY page through the
 * same transport — retries, truncation detection and error shape included —
 * rather than hand-rolling a second fetch that drifts from this one.
 */
export async function deepseekCall(
  apiKey: string,
  model: string,
  prompt: string,
  schemaName: string,
  schema: unknown,
  rootKey: string,
  maxRetries = 2,
  maxTokens = MAX_OUTPUT_TOKENS,
): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: withSchemaInstructions(prompt, schema, rootKey) }],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const delay = (attempt + 1) * 5000;
        console.log(
          `  ⚠ DeepSeek ${res.status} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(`DeepSeek ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as DeepSeekResponse;
    const choice = json.choices?.[0];

    // A truncated response yields incomplete JSON that would throw in
    // JSON.parse — fail loudly so the orchestrator drops DeepSeek and marks
    // the run degraded, rather than silently under-reporting.
    if (choice?.finish_reason === "length") {
      throw new Error(
        `DeepSeek "${schemaName}" truncated (finish_reason=length at ${maxTokens} tokens) — ` +
          `output exceeded the cap. Raise MAX_OUTPUT_TOKENS.`,
      );
    }

    const content = choice?.message?.content;
    if (!content) {
      throw new Error(
        `DeepSeek returned no content for "${schemaName}" (finish_reason=${choice?.finish_reason ?? "none"})`,
      );
    }
    return stripFences(content);
  }
  throw new Error(`DeepSeek "${schemaName}" failed after ${maxRetries} retries`);
}

function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `DeepSeek ${what} was not valid JSON: ${(err as Error).message}. ` +
        `First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
}

// ── Provider ───────────────────────────────────────────────────────
export class DeepSeekProvider implements AIProvider {
  readonly id = "deepseek";
  readonly label = "DeepSeek";
  readonly shortLabel = "D";

  get model(): string {
    return deepseekModel();
  }

  get available(): boolean {
    return !!process.env.DEEPSEEK_API_KEY;
  }

  async analyze(input: AIProviderInput): Promise<AIBuyRecommendation[]> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return [];

    const model = deepseekModel();
    const { report, priceData, news, technicals, macroContext, reasoningHistory } = input;

    console.log(`Running DeepSeek analysis (Stage 1: Observe, ${model})...`);
    const obsPrompt = buildObservationPrompt(report, priceData, news, technicals, macroContext);
    const obsRaw = await deepseekCall(
      apiKey,
      model,
      obsPrompt,
      "submit_observations",
      observationSchema,
      "observations",
    );
    const observations =
      parseJson<{ observations: TickerObservation[] }>(obsRaw, "Stage 1").observations ?? [];

    console.log(`  Stage 1 complete — ${observations.length} observations`);
    for (const obs of observations) {
      const signals = [...obs.priceLevelSignals, ...obs.momentumSignals];
      if (signals.length > 0 || obs.riskFlags.length > 0) {
        console.log(`    ${obs.ticker}: ${signals.length} signals, ${obs.riskFlags.length} flags`);
      }
    }

    console.log(`Running DeepSeek analysis (Stage 2: Decide, ${model})...`);
    const reasoningContext = formatReasoningContext(reasoningHistory, this.id);
    const decPrompt = buildDecisionPrompt(
      observations,
      report,
      macroContext,
      reasoningContext,
      technicals,
      priceData,
    );
    const decRaw = await deepseekCall(
      apiKey,
      model,
      decPrompt,
      "submit_recommendations",
      decisionSchema,
      "recommendations",
    );
    return (
      parseJson<{ recommendations: AIBuyRecommendation[] }>(decRaw, "Stage 2").recommendations ?? []
    );
  }
}

export const deepseekProvider = new DeepSeekProvider();
