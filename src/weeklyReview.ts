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

import { loadReasoningHistory } from "./state.js";
import { fetchPrices } from "./fetchPrices.js";
import { defaultCurrency } from "./config.js";
import { loadBriefArchives, archiveContextBlock } from "./briefArchive.js";
import { askProviderText, REVIEW_PROVIDER_LABELS, type ReviewProviderId } from "./aiText.js";

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

/** One AI's weekly self-review: 得失 + 简报修改建议 + 后续优化方向. */
export interface AIWeeklySummary {
  providerId: string;
  label: string;
  hits: number;
  misses: number;
  accuracy: number;
  /** AI-written Simplified-Chinese self-review, may be empty on API failure. */
  text: string;
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
  /** Per-AI self-reviews (DeepSeek / Gemini), each covering its own book. */
  perAI: AIWeeklySummary[];
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

  // 简报存档 → 双 AI 各自复盘。存档缺失时上下文块为空，AI 只能基于案例复盘。
  const archives = loadBriefArchives(daysCovered);
  const contextBlock = archiveContextBlock(archives);

  const perAI: AIWeeklySummary[] = [];
  for (const providerId of ["deepseek", "gemini"] as const) {
    const own = [...hits, ...misses].filter((o) => o.providerId === providerId);
    const ownHits = own.filter((o) => o.result === "hit").length;
    const ownMisses = own.filter((o) => o.result === "miss").length;
    const ownScored = ownHits + ownMisses;
    const text =
      own.length > 0
        ? await diagnoseProvider(providerId, own, contextBlock)
        : "";
    perAI.push({
      providerId,
      label: providerId === "deepseek" ? "DeepSeek" : "Gemini",
      hits: ownHits,
      misses: ownMisses,
      accuracy: ownScored > 0 ? (ownHits / ownScored) * 100 : 0,
      text,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    daysCovered,
    totalPredictions,
    hits,
    misses,
    flats,
    accuracy,
    perProvider,
    perAI,
    hasData: totalPredictions > 0,
  };
}

// ── Per-AI self-review ──────────────────────────────────────────────
// Each provider reviews ITS OWN calls only, against the archived daily-brief
// context, and must produce three sections: 得失 / 简报修改建议 / 优化方向.
function buildSelfReviewPrompt(
  label: string,
  outcomes: PredictionOutcome[],
  contextBlock: string,
): string {
  const lines = [...outcomes]
    .sort((a, b) => a.pctChange - b.pctChange)
    .slice(0, 40)
    .map(
      (m) =>
        `[${m.date}] ${m.ticker} ${m.action} 置信度:${m.confidence}% 预测价:${m.predPrice} → 复盘时:${m.nowPrice} (${m.pctChange >= 0 ? "+" : ""}${m.pctChange.toFixed(1)}%) 结果:${m.result === "hit" ? "准" : "错"}\n  当时理由: ${m.reason.slice(0, 200)}`,
    )
    .join("\n");

  return `你是${label}，一名短线选手（最长持仓 5 个交易日，周末不计）。下面是过去一周你自己（${label}）的每日预测复盘结果，以及当天的简报市场背景存档（情绪/资金/题材/热点/两仓操作）。

〔你的预测结果〕
${lines}

〔每日简报背景存档〕
${contextBlock || "（本周无存档，仅依据上面的案例复盘）"}

请输出简体中文，必须分三段，用这三个小节标题：
【本周得失】3-6 条：结合当天市场背景（情绪周期/资金/题材轮动）归纳你判准与判错的共同模式，说明为什么对、为什么错；
【简报修改建议】2-4 条：每日简报里哪些数据对你判断没用或太吵、缺了哪些你会用到的数据，具体到栏目名，可操作；
【后续优化方向】2-4 条：你自己下一步的判断改进点，要具体可执行（例如"涨停晋级率低于 40% 时不再给 BUY"这类规则化表述）。
不要空泛套话，不要复述规则。`;
}

async function diagnoseProvider(
  providerId: ReviewProviderId,
  outcomes: PredictionOutcome[],
  contextBlock: string,
): Promise<string> {
  const prompt = buildSelfReviewPrompt(REVIEW_PROVIDER_LABELS[providerId], outcomes, contextBlock);
  return askProviderText(providerId, prompt);
}
