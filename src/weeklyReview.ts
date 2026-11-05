// ── Weekly prediction review ────────────────────────────────────────
// The weekly job no longer rebalances a portfolio (the daily brief is a pure
// hot-stock watch list now). Instead it answers: "how good were the AI's
// calls this week, and why did the wrong ones go wrong?"
//
// Data source: state/reasoning-history.json — every daily run snapshots each
// provider's action/confidence/reason per ticker with the then-current price.
// Outcomes are scored against the price fetched at review time.
//
// Scoring rule (documented in the email so the reader knows what "准" means):
//   买入/强烈买入: week move ≥ +3% → hit; ≤ −3% → miss; else flat
//   观望/减持:     week move ≤ −3% → hit (避坑); ≥ +3% → miss (踏空); else flat
//   持有:          not scored (neutral by definition)

import { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "./providers/gemini.js";
import { loadReasoningHistory } from "./state.js";
import { fetchPrices } from "./fetchPrices.js";
import { defaultCurrency } from "./config.js";

export interface PredictionOutcome {
  date: string;
  ticker: string;
  providerId: string;
  action: string;
  confidence: number;
  predPrice: number;
  nowPrice: number;
  pctChange: number;
  result: "hit" | "miss" | "flat";
  reason: string;
}

export interface WeeklyReview {
  generatedAt: string;
  daysCovered: string[];
  totalPredictions: number;
  hits: PredictionOutcome[];
  misses: PredictionOutcome[];
  flats: number;
  /** hits / (hits + misses), 0-100; 0 when nothing scored. */
  accuracy: number;
  perProvider: Record<string, { hits: number; misses: number }>;
  /** AI-written failure-factor analysis (Simplified Chinese), may be empty. */
  diagnosis: string;
  hasData: boolean;
}

const HIT_THRESHOLD_PCT = 3;

function scoreAction(action: string, pct: number): "hit" | "miss" | "flat" | null {
  const a = action.toUpperCase();
  if (a === "STRONG BUY" || a === "BUY") {
    if (pct >= HIT_THRESHOLD_PCT) return "hit";
    if (pct <= -HIT_THRESHOLD_PCT) return "miss";
    return "flat";
  }
  if (a === "WAIT" || a === "TRIM") {
    if (pct <= -HIT_THRESHOLD_PCT) return "hit";
    if (pct >= HIT_THRESHOLD_PCT) return "miss";
    return "flat";
  }
  return null; // HOLD / unknown → not scored
}

export async function buildWeeklyReview(
  currentPrices: Record<string, number>,
): Promise<WeeklyReview> {
  const history = loadReasoningHistory();
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const daysCovered = Object.keys(history.snapshots)
    .filter((d) => d >= weekAgo && d < today)
    .sort();

  const hits: PredictionOutcome[] = [];
  const misses: PredictionOutcome[] = [];
  let flats = 0;
  const perProvider: Record<string, { hits: number; misses: number }> = {};
  const priceFetchTickers = new Set<string>();

  for (const date of daysCovered) {
    for (const snap of history.snapshots[date] ?? []) {
      const now = currentPrices[snap.ticker];
      // Historical price missing/zero → unscorable row.
      if (snap.price <= 0) continue;
      if (now == null) {
        priceFetchTickers.add(snap.ticker);
        continue;
      }
      const pct = ((now - snap.price) / snap.price) * 100;
      const result = scoreAction(snap.action, pct);
      const outcome: PredictionOutcome = {
        date,
        ticker: snap.ticker,
        providerId: snap.providerId,
        action: snap.action,
        confidence: snap.confidence,
        predPrice: snap.price,
        nowPrice: now,
        pctChange: pct,
        result: result ?? "flat",
        reason: snap.reason,
      };
      if (result === null || result === "flat") {
        flats++;
        continue;
      }
      (result === "hit" ? hits : misses).push(outcome);
      const bucket = (perProvider[snap.providerId] ??= { hits: 0, misses: 0 });
      if (result === "hit") bucket.hits++;
      else bucket.misses++;
    }
  }

  // Resolve prices for tickers that dropped out of today's hot list.
  if (priceFetchTickers.size > 0) {
    const tickers = [...priceFetchTickers];
    console.log(`Weekly review: fetching prices for ${tickers.length} historical tickers...`);
    try {
      const result = await fetchPrices(tickers, defaultCurrency);
      for (const q of result.quotes) {
        currentPrices[q.ticker] = q.price;
      }
      // Second pass for the ones we just fetched.
      for (const date of daysCovered) {
        for (const snap of history.snapshots[date] ?? []) {
          if (snap.price <= 0) continue;
          const now = currentPrices[snap.ticker];
          if (now == null) continue;
          if (misses.some((m) => m.date === date && m.ticker === snap.ticker && m.providerId === snap.providerId)) continue;
          if (hits.some((h) => h.date === date && h.ticker === snap.ticker && h.providerId === snap.providerId)) continue;
          const pct = ((now - snap.price) / snap.price) * 100;
          const result = scoreAction(snap.action, pct);
          const outcome: PredictionOutcome = {
            date,
            ticker: snap.ticker,
            providerId: snap.providerId,
            action: snap.action,
            confidence: snap.confidence,
            predPrice: snap.price,
            nowPrice: now,
            pctChange: pct,
            result: result ?? "flat",
            reason: snap.reason,
          };
          if (result === null || result === "flat") {
            flats++;
            continue;
          }
          (result === "hit" ? hits : misses).push(outcome);
          const bucket = (perProvider[snap.providerId] ??= { hits: 0, misses: 0 });
          if (result === "hit") bucket.hits++;
          else bucket.misses++;
        }
      }
    } catch (err) {
      console.warn(`⚠ Weekly review price fetch failed: ${(err as Error).message}`);
    }
  }

  const totalPredictions = hits.length + misses.length + flats;
  const scored = hits.length + misses.length;
  const accuracy = scored > 0 ? (hits.length / scored) * 100 : 0;

  const diagnosis = misses.length > 0 ? await diagnoseMisses(misses) : "";

  return {
    generatedAt: new Date().toISOString(),
    daysCovered,
    totalPredictions,
    hits,
    misses,
    flats,
    accuracy,
    perProvider,
    diagnosis,
    hasData: totalPredictions > 0,
  };
}

// ── AI failure-factor diagnosis ─────────────────────────────────────
async function diagnoseMisses(misses: PredictionOutcome[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "";

  const lines = misses
    .slice(0, 30) // cap prompt size; worst offenders first
    .sort((a, b) => a.pctChange - b.pctChange)
    .map(
      (m) =>
        `[${m.date}] ${m.ticker} (${m.providerId}) 预测:${m.action} 置信度:${m.confidence}% 预测价:${m.predPrice} → 一周后:${m.nowPrice} (${m.pctChange >= 0 ? "+" : ""}${m.pctChange.toFixed(1)}%)\n  当时的理由: ${m.reason.slice(0, 200)}`,
    )
    .join("\n");

  const prompt = `你是量化策略复盘助手。以下是过去一周 AI 选股预测中判错的案例（预测了买入但一周后下跌 ≥3%，或预测观望但一周后上涨 ≥3%）。

${lines}

请输出 3-6 条简体中文要点，每条一行，格式「失败因素：分析＋一句优化建议」。要求：
1. 归纳失败的共同模式（例如：追高超买、忽略大盘/板块系统性风险、消息面权重过高、置信度虚高、预测理由与价格行为矛盾等）；
2. 基于案例的具体内容，不要空泛套话；
3. 给出可执行的策略优化建议（例如：加 RSI 上限过滤、降低追涨型 BUY 的置信度权重、大盘急跌日暂停买入信号等）。`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });
    return (response.text ?? "").trim();
  } catch (err) {
    console.warn(`⚠ Weekly diagnosis failed: ${(err as Error).message}`);
    return "";
  }
}
