// ── Plain-text calls to the two book-owning providers ───────────────
// Shared by the weekly self-review and the monthly report: each AI critiques
// its own performance through its own API (Gemini direct; DeepSeek through
// the same json_object transport as the analysis stages, unwrapped here).

import { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "./providers/gemini.js";
import { deepseekCall, deepseekModel } from "./providers/deepseek.js";

export type ReviewProviderId = "deepseek" | "gemini";
export const REVIEW_PROVIDER_LABELS: Record<ReviewProviderId, string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
};

/**
 * Send a free-form (non-JSON) Chinese review prompt to one provider and get
 * its text back. Returns "" when the key is missing or the call fails —
 * reviews are best-effort and must never break the report.
 */
export async function askProviderText(
  providerId: ReviewProviderId,
  prompt: string,
): Promise<string> {
  try {
    if (providerId === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return "";
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
      });
      return (response.text ?? "").trim();
    }
    // DeepSeek — same transport as the analysis stages (json_object mode), so
    // wrap the review in a one-key JSON object and unwrap here.
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return "";
    const raw = await deepseekCall(
      apiKey,
      deepseekModel(),
      `${prompt}\n\n输出必须是一个 JSON 对象：{"review": "你的完整复盘文本"}。review 内用【】小节标题换行书写。`,
      "selfReview",
      {
        type: "object",
        properties: { review: { type: "string" } },
        required: ["review"],
      },
      "review",
    );
    const parsed = JSON.parse(raw) as { review?: string };
    return (parsed.review ?? "").trim();
  } catch (err) {
    console.warn(`⚠ Self-review call (${providerId}) failed: ${(err as Error).message}`);
    return "";
  }
}
