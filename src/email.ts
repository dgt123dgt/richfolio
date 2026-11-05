import { Resend } from "resend";
import { recipientEmail, defaultCurrency, displayName } from "./config.js";
import type { AllocationItem, AllocationReport } from "./analyze.js";
import type { AIBuyRecommendation } from "./aiAnalysis.js";
import type { NewsItem } from "./fetchNews.js";
import type { TechnicalData } from "./fetchTechnicals.js";
import type { QuoteData } from "./fetchPrices.js";
import type { BoardInfo } from "./fetchBoards.js";
import { classifyHotNewsImpact } from "./hotNewsImpact.js";
import type { LongTermLabel } from "./stockLabels.js";
import { escapeHtmlAttr, formatMoney } from "./util.js";
import { hasStrongBuyVote } from "./aiAggregation.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Styles (light, cheerful theme) ──────────────────────────────────
const S = {
  bg: "#eff6ff",
  cardBg: "#ffffff",
  text: "#334155",
  muted: "#64748b",
  accent: "#0ea5e9",
  green: "#22c55e",
  red: "#ef4444",
  yellow: "#f59e0b",
  blue: "#3b82f6",
  border: "#e2e8f0",
  // Row accents for the hot-stock screen: 妖股 purple, 白马 amber.
  purple: "#7c3aed",
  amber: "#b45309",
} as const;

// ── Helpers ─────────────────────────────────────────────────────────
const fmt$ = (n: number) => formatMoney(n, defaultCurrency);

// Chinese display labels for the action enum. Internal comparisons everywhere
// still use the English enum values; this map only affects rendering.
const ACTION_LABELS: Record<string, string> = {
  "STRONG BUY": "强烈买入",
  BUY: "买入",
  HOLD: "持有",
  WAIT: "观望",
  TRIM: "减持",
};

const MOMENTUM_LABELS: Record<string, string> = {
  bullish: "看多",
  bearish: "看空",
  neutral: "中性",
};

const AGREEMENT_LABELS: Record<string, string> = {
  unanimous: "全体一致",
  majority: "多数一致",
  split: "意见分歧",
};

// Money belonging to a specific recommendation. Most instruments are converted
// to the report currency, but a crypto cross-pair is quoted in its own coin and
// never goes through FX — so its price and limit order must render in that coin,
// not with a `$` in front of it.
const fmtRec = (rec: AIBuyRecommendation, n: number) =>
  formatMoney(n, rec.quoteCurrency ?? defaultCurrency);

// 早/中/晚 slot of the brief, from Beijing wall-clock at send time:
// 05:00–10:59 早, 11:00–16:59 中, otherwise 晚.
function briefPeriod(): string {
  const hour = Number(
    new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "numeric",
      hour12: false,
    }),
  );
  return hour >= 5 && hour < 11 ? "早" : hour >= 11 && hour < 17 ? "中" : "晚";
}

function fmtPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function gapColor(gap: number): string {
  if (gap > 1) return S.red;
  if (gap < -1) return S.yellow;
  return S.green;
}

function weekBar(pct: number | null): string {
  if (pct == null) return "—";
  const filled = Math.round(pct * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${bar} ${(pct * 100).toFixed(0)}%`;
}

function fmtPE(item: AllocationItem): string {
  if (item.trailingPE == null) return "—";
  const value = item.trailingPE.toFixed(1);
  // ⚠️ = GAAP and adjusted EPS diverge, so the trailing P/E misstates the multiple.
  return item.epsBasis ? `${value} ⚠️` : value;
}

function actionBadge(action: string): string {
  const colors: Record<string, { bg: string; text: string }> = {
    "STRONG BUY": { bg: "#2ecc71", text: "#000" },
    BUY: { bg: "#3498db", text: "#fff" },
    HOLD: { bg: "#95a5a6", text: "#fff" },
    WAIT: { bg: "#e74c3c", text: "#fff" },
  };
  const c = colors[action] || colors.HOLD;
  const label = ACTION_LABELS[action] ?? action;
  return `<span style="background:${c.bg};color:${c.text};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">${label}</span>`;
}

function confidenceBar(pct: number): string {
  const color = pct >= 70 ? S.green : pct >= 40 ? S.yellow : S.red;
  return (
    `<div style="display:inline-block;width:60px;height:8px;background:${S.border};border-radius:4px;vertical-align:middle;">` +
    `<div style="width:${pct}%;height:100%;background:${color};border-radius:4px;"></div>` +
    `</div> <span style="font-size:11px;color:${S.muted};">${pct}%</span>`
  );
}

// ── Value rating color ───────────────────────────────────────────────
const ratingColors: Record<string, string> = {
  A: "#2ecc71",
  B: "#3498db",
  C: "#f39c12",
  D: "#e74c3c",
};

function valueRatingBadge(rating: string | undefined): string {
  if (!rating || rating === "") return "";
  const color = ratingColors[rating] || S.muted;
  return `<span style="background:${color}22;color:${color};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin-left:6px;">价值 ${rating}</span>`;
}

function earningsBadge(daysToEarnings: number | null): string {
  if (daysToEarnings == null || daysToEarnings > 14) return "";
  const color = daysToEarnings <= 3 ? S.red : daysToEarnings <= 7 ? S.yellow : S.muted;
  return `<span style="background:${color}22;color:${color};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin-left:6px;">财报 ${daysToEarnings}天</span>`;
}

// ── Multi-AI helpers (rendered only when providers.length >= 2) ─────
function agreementBadge(agreement: AIBuyRecommendation["agreement"]): string {
  if (!agreement) return "";
  const colors: Record<string, string> = {
    unanimous: S.green,
    majority: S.yellow,
    split: S.red,
  };
  const c = colors[agreement] ?? S.muted;
  const label = AGREEMENT_LABELS[agreement] ?? agreement;
  return `<span style="background:${c}22;color:${c};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin-left:6px;">${label}</span>`;
}

// A degraded run lost the cross-provider agreement STRONG BUY requires, so it
// must NOT look like a verified consensus. Rendered on every rec of the run —
// unlike agreementBadge this shows even in single-provider rendering, because
// that is precisely the case being flagged.
function degradedBadge(degradation: AIBuyRecommendation["degradation"]): string {
  if (!degradation) return "";
  const label = `${degradation.answered}/${degradation.configured} AI`;
  const title = escapeHtmlAttr(
    `${degradation.missing.join(", ")} 未响应 — 本次运行无法验证跨 AI 一致性`,
  );
  return `<span title="${title}" style="background:${S.yellow}22;color:${S.yellow};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin-left:6px;">⚠ ${label}</span>`;
}

function isMultiAI(rec: AIBuyRecommendation): boolean {
  return !!rec.providers && rec.providers.length >= 2;
}

// Per-provider breakdown shown beneath the consensus reason. Each row:
// short tag (G/C/...) · provider label · action badge · confidence · short reason.
function buildProvidersBreakdown(
  rec: AIBuyRecommendation,
  zh: (text: string) => string = (text) => text,
): string {
  if (!isMultiAI(rec)) return "";
  const providers = rec.providers!;
  const rows = providers
    .map((p) => {
      const full = zh(p.reason);
      const reasonSnippet = full.length > 140 ? full.slice(0, 137).trimEnd() + "…" : full;
      return `
    <tr>
      <td style="padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap;">
        <span style="display:inline-block;background:${S.accent};color:${S.text};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;min-width:18px;text-align:center;">${escapeHtmlAttr(p.providerShortLabel)}</span>
        <span style="font-size:11px;color:${S.muted};margin-left:6px;">${escapeHtmlAttr(p.providerLabel)}</span>
      </td>
      <td style="padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap;">
        ${actionBadge(p.action)} <span style="font-size:11px;color:${S.muted};">${p.confidence}%</span>
      </td>
      <td style="padding:4px 0;vertical-align:top;font-size:11px;color:${S.text};">${reasonSnippet}</td>
    </tr>`;
    })
    .join("");

  return `
  <table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;width:100%;border-collapse:collapse;border-top:1px solid ${S.border};">
    ${rows}
  </table>`;
}

// ── Technical Insight (STRONG BUY + BUY with extras) ────────────────
function buildTechnicalInsight(rec: AIBuyRecommendation, tech: TechnicalData | undefined): string {
  const hasExtras =
    (rec.valueRating && rec.valueRating !== "") || (rec.bottomSignal && rec.bottomSignal !== "");
  // Gated on hasStrongBuyVote, not on the aggregated action: when the
  // dissent-distance rule caps a STRONG BUY at BUY, the technicals and the limit
  // price are exactly what you need to judge the cap for yourself. Hiding them
  // would make a demoted rec look thinner than the evidence behind it.
  if (!hasStrongBuyVote(rec) && !hasExtras) return "";
  if (!tech && !hasExtras) return "";

  let html = `<div style="font-size:11px;color:${S.muted};margin-top:6px;border-top:1px solid ${S.border};padding-top:6px;">`;

  // Technical momentum line (any STRONG BUY vote)
  if (hasStrongBuyVote(rec) && tech) {
    const momentumColor =
      tech.momentumSignal === "bullish"
        ? S.green
        : tech.momentumSignal === "bearish"
          ? S.red
          : S.muted;
    const rsiColor = tech.rsi14 < 30 ? S.green : tech.rsi14 > 70 ? S.red : S.muted;

    const lines = [
      `<span style="color:${momentumColor};">${MOMENTUM_LABELS[tech.momentumSignal] ?? tech.momentumSignal}</span>`,
      `RSI <span style="color:${rsiColor};">${tech.rsi14}</span>`,
      `50MA ${fmtRec(rec, tech.sma50)} (${tech.priceVsSma50 > 0 ? "+" : ""}${tech.priceVsSma50}%)`,
    ];
    if (tech.sma200 != null) {
      lines.push(`200MA ${fmtRec(rec, tech.sma200)}`);
    }
    if (tech.goldenCross) lines.push(`<span style="color:${S.green};">金叉</span>`);
    if (tech.deathCross) lines.push(`<span style="color:${S.red};">死叉</span>`);
    if (tech.macdCrossover) {
      const macdColor = tech.macdCrossover === "bullish" ? S.green : S.red;
      lines.push(
        `MACD <span style="color:${macdColor};">${MOMENTUM_LABELS[tech.macdCrossover] ?? tech.macdCrossover}</span>`,
      );
    } else if (tech.macdHistogram != null) {
      const histColor = tech.macdHistogram > 0 ? S.green : S.red;
      lines.push(
        `MACD 柱 <span style="color:${histColor};">${tech.macdHistogram > 0 ? "+" : ""}${tech.macdHistogram}</span>`,
      );
    }
    if (tech.bollPercentB != null) {
      const bColor = tech.bollPercentB < 0.2 ? S.green : tech.bollPercentB > 0.8 ? S.red : S.muted;
      lines.push(`%B <span style="color:${bColor};">${tech.bollPercentB}</span>`);
    }
    if (tech.bollSqueeze) lines.push(`<span style="color:${S.yellow};">布林收口</span>`);

    html += `<span style="color:${S.blue};">动量：</span> ${lines.join(" · ")}`;
  }

  // Limit order (any STRONG BUY vote)
  if (hasStrongBuyVote(rec) && rec.suggestedLimitPrice && rec.suggestedLimitPrice > 0) {
    html += `<br><span style="color:${S.green};">限价建议：</span> ${fmtRec(rec, rec.suggestedLimitPrice)}`;
    if (rec.limitPriceReason) {
      html += ` — ${rec.limitPriceReason}`;
    }
  }

  // Bottom signal (oversold detection)
  if (rec.bottomSignal && rec.bottomSignal !== "") {
    html += `<br><span style="color:${S.yellow};">见底信号：</span> ${rec.bottomSignal}`;
  }

  html += `</div>`;
  return html;
}

// ── AI Recommendations Section ──────────────────────────────────────
function buildAISection(
  aiRecs: AIBuyRecommendation[],
  technicals: Record<string, TechnicalData> = {},
  priceData: Record<string, QuoteData> = {},
  nationalTeam: ReadonlySet<string> = new Set(),
  longTermLabels: Record<string, string[]> = {},
): string {
  // Global status chips next to every stock name in this section.
  const chipsFor = (ticker: string) =>
    renderChips(stockChips(ticker, { technicals, priceData, nationalTeam, longTermLabels }));
  // Portfolio tickers (excludes watch list)
  const portfolioRecs = aiRecs.filter((r) => !r.isWatching);
  const actionable = portfolioRecs.filter((r) => r.action === "STRONG BUY" || r.action === "BUY");
  const others = portfolioRecs.filter((r) => r.action !== "STRONG BUY" && r.action !== "BUY");
  // Watch list tickers — rendered as a separate sub-section below the portfolio
  // recommendations. Allocation rules don't apply; suggestedBuyValue is always 0.
  const watching = aiRecs.filter((r) => r.isWatching);
  const watchActionable = watching.filter((r) => r.action === "STRONG BUY" || r.action === "BUY");
  const watchOthers = watching.filter((r) => r.action !== "STRONG BUY" && r.action !== "BUY");

  // Current price next to each call — the reader judges "能不能买" against it.
  const priceTag = (ticker: string): string => {
    const q = priceData[ticker];
    if (!q) return "";
    return `<span style="font-size:11px;color:${S.muted};margin-left:8px;">现价 <b style="font-size:12px;color:#1a202c;">${fmt$(q.price)}</b></span>`;
  };

  // Detect provider mode from the first rec's providers[] (uniformly populated
  // by the orchestrator). When ≥2 active, surface that in the subtitle.
  const firstWithProviders = aiRecs.find((r) => r.providers && r.providers.length > 0);
  const providerLabels = firstWithProviders?.providers?.map((p) => p.providerLabel) ?? ["Gemini"];
  const multiAIMode = providerLabels.length >= 2;
  const subtitle = multiAIMode
    ? `由 ${providerLabels.join(" + ")} 联合分析 — 分数取各 AI 均值，每只标的下方附各 AI 明细。`
    : `由 ${providerLabels[0]} 分析 — 综合基本面、估值、配置缺口、技术面与新闻情绪。`;

  // Watch-only mode: every rec belongs to the watch list, so burying STRONG
  // BUY calls under an "观察名单" divider while the top says "暂无买入" reads
  // as a contradiction. There, the watch actionable cards ARE the main list;
  // the boxed 观察名单 block only renders when a real portfolio exists above.
  const hasPortfolioRecs = portfolioRecs.length > 0;

  // AI prose often cites sibling stocks by raw code ("与 002463 同属…"). Swap
  // every known code for its Chinese display name so the brief reads in
  // Chinese; the exchange suffix is optional in the match.
  const nameMap = new Map<string, string>();
  for (const ticker of new Set([
    ...aiRecs.map((r) => r.ticker),
    ...Object.keys(technicals),
    ...Object.keys(priceData),
  ])) {
    const name = displayName(ticker);
    if (name !== ticker) nameMap.set(ticker, name);
  }
  const zh = (text: string): string => {
    for (const [ticker, name] of nameMap) {
      const base = ticker.replace(/\.(SS|SZ)$/i, "");
      text = text.replace(
        new RegExp(`\\b${base}(?:\\.(?:SS|SZ))?\\b`, "gi"),
        () => name,
      );
    }
    return text;
  };
  const topActionable = hasPortfolioRecs ? actionable : watchActionable;
  const topOthers = hasPortfolioRecs ? others : watchOthers;

  const actionableCard = (rec: AIBuyRecommendation): string => `
  <div style="padding:10px 0;border-bottom:1px solid ${S.border};">
    <div style="margin-bottom:4px;">
      <span style="font-weight:bold;font-size:14px;color:#1a202c;" title="${escapeHtmlAttr(rec.tickerFullName ?? rec.ticker)}">${displayName(rec.ticker, rec.tickerFullName)}</span>
      <span style="font-size:10px;color:${S.muted};">${rec.ticker}</span>
      &nbsp;${chipsFor(rec.ticker)}${actionBadge(rec.action)}${valueRatingBadge(rec.valueRating)}${earningsBadge(priceData[rec.ticker]?.daysToEarnings ?? null)}${isMultiAI(rec) ? agreementBadge(rec.agreement) : ""}${degradedBadge(rec.degradation)}
      &nbsp;${confidenceBar(rec.confidence)}${isMultiAI(rec) ? `<span style="font-size:10px;color:${S.muted};margin-left:6px;">avg</span>` : ""}${priceTag(rec.ticker)}
      ${rec.suggestedBuyValue > 0 ? `<span style="float:right;font-weight:bold;color:#1a202c;">${fmt$(rec.suggestedBuyValue)}</span>` : ""}
    </div>
    <div style="font-size:12px;color:${S.text};margin-top:4px;">${zh(rec.reason)}</div>
    ${buildProvidersBreakdown(rec, zh)}
    ${buildTechnicalInsight(rec, technicals[rec.ticker])}
    ${
      hasStrongBuyVote(rec) && rec.analysisUrl
        ? `
    <div style="margin-top:8px;">
      <a href="${rec.analysisUrl}" style="display:inline-block;background:${S.blue}22;color:${S.blue};padding:4px 12px;border-radius:4px;font-size:11px;font-weight:bold;text-decoration:none;border:1px solid ${S.blue}44;">查看详情 &rarr;</a>
    </div>`
        : ""
    }
  </div>`;

  const otherRow = (rec: AIBuyRecommendation): string => `
    <div style="padding:4px 0;font-size:12px;">
      <span style="font-weight:bold;" title="${escapeHtmlAttr(rec.tickerFullName ?? rec.ticker)}">${displayName(rec.ticker, rec.tickerFullName)}</span> <span style="font-size:10px;color:${S.muted};">${rec.ticker}</span>
      &nbsp;${chipsFor(rec.ticker)}${actionBadge(rec.action)}${valueRatingBadge(rec.valueRating)}${priceTag(rec.ticker)}
      <span style="color:${S.muted};margin-left:8px;">${zh(rec.reason)}</span>
    </div>`;

  const emptyBox = `
  <div style="background:#f8fafc;border:1px dashed ${S.border};border-radius:8px;padding:16px 12px;text-align:center;">
    <div style="font-size:13px;font-weight:bold;color:${S.muted};">今日暂无符合买入条件的标的</div>
    <div style="font-size:11px;color:${S.muted};margin-top:4px;">全部标的均未达到「买入 / 强烈买入」标准 — 详见下方持有/观望与快筛表。</div>
  </div>`;

  return `
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">AI 买入建议</h2>
  <p style="margin:4px 0 0;font-size:11px;color:${S.muted};">${subtitle}</p>
  <div style="margin-top:8px;background:#f8fafc;border-left:3px solid ${S.blue};border-radius:0 6px 6px 0;padding:8px 12px;font-size:11px;color:${S.muted};line-height:1.6;">
    <b style="color:${S.blue};">入选逻辑：</b>AI 综合估值（市盈率、52 周位置、分析师目标价）、技术面（RSI、MACD、50/200 日均线）、消息面（近 24 小时新闻情绪）${
      hasPortfolioRecs ? "与配置缺口" : ""
    }打分，结论为「买入 / 强烈买入」的标的才进入本栏；未达标的显示在「持有 / 观望」中。
  </div>
  ${
    !hasPortfolioRecs && watching.length > 0
      ? `<p style="margin:8px 0 0;font-size:11px;color:${S.amber};">当前为观察模式 — 以下标的均来自观察名单，只给信号、不分配买入金额。</p>`
      : ""
  }
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  ${
    topActionable.length > 0
      ? topActionable.map(actionableCard).join("")
      : emptyBox
  }
  ${
    topOthers.length > 0
      ? `
  <div style="margin-top:14px;">
    <div style="font-size:11px;color:${S.muted};text-transform:uppercase;margin-bottom:6px;">持有 / 观望</div>
    ${topOthers.map(otherRow).join("")}
  </div>`
      : ""
  }
  ${
    hasPortfolioRecs && watching.length > 0
      ? `
  <div style="margin-top:20px;border:1px solid #fde68a;border-radius:8px;overflow:hidden;">
    <div style="background:#fef3c7;padding:10px 14px;">
      <span style="font-size:13px;font-weight:bold;color:${S.amber};">👁 观察名单</span>
      <span style="font-size:11px;color:#92400e;margin-left:8px;">跟踪中但不在目标组合内 — 仅提示信号，不建议买入金额。</span>
    </div>
    <div style="padding:6px 14px 10px;">
    ${watchActionable
      .map(actionableCard)
      .join("")}
    ${
      watchOthers.length > 0
        ? `<div style="margin-top:8px;">${watchOthers.map(otherRow).join("")}</div>`
        : ""
    }
    </div>
  </div>`
      : ""
  }
</td></tr>`;
}

// ── Fallback Priority Buys Section ──────────────────────────────────
function buildFallbackBuysSection(report: AllocationReport): string {
  const buys = report.items.filter((i) => i.gapPct > 0.5).slice(0, 5);
  if (buys.length === 0) return "";

  return `
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">优先买入</h2>
  <p style="margin:4px 0 0;font-size:11px;color:${S.muted};">按配置缺口排序。配置 GEMINI_API_KEY 可启用 AI 推荐。</p>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
    <tr style="color:${S.muted};font-size:11px;text-transform:uppercase;">
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};">名称</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:right;">缺口</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:right;">建议股数</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:right;">建议金额</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:center;">市盈率</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:center;">52周</td>
    </tr>
    ${buys
      .map(
        (b) => `
    <tr>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};font-weight:bold;" title="${escapeHtmlAttr(b.tickerFullName ?? b.ticker)}">${displayName(b.ticker, b.tickerFullName)}<div style="font-size:10px;color:${S.muted};font-weight:normal;">${b.ticker}</div></td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:right;color:${S.red};">${fmtPct(b.gapPct)}</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:right;">${b.suggestedBuyShares.toFixed(1)}</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:right;">${fmt$(b.suggestedBuyValue)}${b.overlapDiscount > 0 ? `<div style="font-size:10px;color:${S.muted};">-${fmt$(b.overlapDiscount)} 重合扣减</div>` : ""}</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:center;">${fmtPE(b)}</td>
      <td style="padding:6px 4px;border-bottom:1px solid ${S.border};text-align:center;">${b.weekSignal ?? "—"}</td>
    </tr>`,
      )
      .join("")}
  </table>
</td></tr>`;
}

// ── Build HTML ──────────────────────────────────────────────────────
export function buildEmailHtml(
  report: AllocationReport,
  news: Record<string, NewsItem[]>,
  aiRecs: AIBuyRecommendation[] = [],
  technicals: Record<string, TechnicalData> = {},
  priceData: Record<string, QuoteData> = {},
  fxSkipped: Array<{ ticker: string; reason: string }> = [],
  hotNews: NewsItem[] = [],
  nationalTeam: ReadonlySet<string> = new Set(),
  boards: Record<string, BoardInfo> = {},
  longTermLabels: Record<string, string[]> = {},
): string {
  const date = new Date().toLocaleDateString("zh-CN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // News is shown in two blocks, in this order:
  //   A. per-ticker news for names the AI recommended buying (the reader only
  //      needs evidence for actionable calls);
  //   B. market-wide hot flashes from the last few hours.
  const buyTickers = new Set(
    aiRecs.filter((r) => r.action === "STRONG BUY" || r.action === "BUY").map((r) => r.ticker),
  );
  const recommendedNews = aiRecs
    .filter((r) => buyTickers.has(r.ticker) && (news[r.ticker]?.length ?? 0) > 0)
    .map((r) => [r.ticker, news[r.ticker]] as const);

  // Chinese names of every stock in the report — the hot-flash classifier uses
  // them to tag 个股 scope when a flash mentions one of our names.
  const knownNames = new Set<string>();
  for (const ticker of [
    ...Object.keys(technicals),
    ...Object.keys(priceData),
    ...aiRecs.map((r) => r.ticker),
  ]) {
    const name = displayName(ticker);
    if (name !== ticker) knownNames.add(name);
  }

  // The caveat below warns that limit prices are stated in the report currency
  // even though the instrument trades in another one — an FX-conversion artefact.
  // Crypto cross-pairs are excluded: they are never converted, and their prices
  // already render in their own quote coin, so the warning would be false for
  // them and would wrongly attach to the whole brief.
  const hasCrossCurrency = Object.values(priceData).some(
    (q) => q.assetKind !== "crypto-cross" && q.originalCurrency !== defaultCurrency,
  );

  // Use AI section if available, otherwise fallback to gap-based
  const buysSection =
    aiRecs.length > 0
      ? buildAISection(aiRecs, technicals, priceData, nationalTeam, longTermLabels)
      : buildFallbackBuysSection(report);
  // Same global chips for the news headers.
  const chipsFor = (ticker: string) =>
    renderChips(stockChips(ticker, { technicals, priceData, nationalTeam, longTermLabels }));

  // Watch-only mode (no portfolio configured): the 100-stock technical screen
  // carries the whole brief, so it is rendered at the very end — after the AI
  // picks and the news — instead of pushing them down.
  const hasPortfolio = report.items.length > 0;
  const techScreenBlock = hasPortfolio
    ? ""
    : techScreenSection(technicals, priceData, nationalTeam, boards, longTermLabels);
  const statsSection = hasPortfolio
    ? `
<!-- Portfolio Stats -->
<tr><td style="padding:16px 24px;background:${S.cardBg};border-bottom:1px solid ${S.border};">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">持仓市值（${defaultCurrency}）</div>
      <div style="font-size:20px;font-weight:bold;color:#1a202c;">${fmt$(report.totalCurrentValue)}</div>
    </td>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">组合 Beta</div>
      <div style="font-size:20px;font-weight:bold;color:#1a202c;">${report.portfolioBeta?.toFixed(2) ?? "—"}</div>
    </td>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">预估年股息</div>
      <div style="font-size:20px;font-weight:bold;color:#1a202c;">${fmt$(report.estimatedAnnualDividend)}</div>
    </td>
  </tr></table>
</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${S.text};font-size:14px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;">

<!-- Header -->
<tr><td style="padding:20px 24px;background:${S.accent};border-radius:8px 8px 0 0;">
  <h1 style="margin:0;font-size:22px;color:#ffffff;">Richfolio 每日简报（${briefPeriod()}）</h1>
  <p style="margin:6px 0 0;color:#e0f2fe;font-size:13px;">${date}</p>
</td></tr>

${statsSection}

<!-- Buy Recommendations (AI or fallback) -->
${buysSection}
${
  hasPortfolio
    ? `
<!-- Full Allocation Table -->
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">配置明细</h2>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;">
    <tr style="color:${S.muted};font-size:10px;text-transform:uppercase;">
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};">名称</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">现价</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">当前</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">目标</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">缺口</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">市盈率</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">股息率</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">Beta</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};">52周位置</td>
    </tr>
    ${report.items
      .map(
        (item) => `
    <tr>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};font-weight:bold;" title="${escapeHtmlAttr(item.tickerFullName ?? item.ticker)}">${displayName(item.ticker, item.tickerFullName)}<div style="font-size:9px;color:${S.muted};font-weight:normal;">${item.ticker}</div></td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${fmt$(item.price)}</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${item.currentPct.toFixed(1)}%</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${item.targetPct.toFixed(1)}%</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;color:${gapColor(item.gapPct)};">${fmtPct(item.gapPct)}${item.overlapDiscount > 0 ? `<div style="font-size:10px;color:${S.muted};">-${fmt$(item.overlapDiscount)} 重合扣减</div>` : ""}</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${fmtPE(item)}</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${item.dividendYield != null ? (item.dividendYield * 100).toFixed(1) + "%" : "—"}</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${item.beta?.toFixed(2) ?? "—"}</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};font-family:monospace;font-size:11px;">${weekBar(item.fiftyTwoWeekPercent)}</td>
    </tr>`,
      )
      .join("")}
  </table>
</td></tr>
`
    : ""
}

<!-- News A: per-ticker news for AI BUY calls only -->
${
  recommendedNews.length > 0
    ? `
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">推荐买入标的的相关新闻</h2>
  <p style="margin:4px 0 0;font-size:11px;color:${S.muted};">仅展示上方面向「买入」的标的，便于核对模型判断依据。</p>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  ${recommendedNews
    .map(
      ([ticker, articles]) => `
  <div style="margin-bottom:12px;">
    <div style="font-weight:bold;font-size:13px;color:#1a202c;margin-bottom:4px;">${displayName(ticker)} <span style="font-size:10px;color:${S.muted};font-weight:normal;">${ticker}</span>&nbsp;${chipsFor(ticker)}</div>
    ${articles
      .map(
        (a) => `
    <div style="margin-left:12px;margin-bottom:4px;font-size:12px;">
      <a href="${a.url}" style="color:${S.blue};text-decoration:none;">→ ${a.title}</a>
      <span style="color:${S.muted};font-size:11px;"> — ${a.source}</span>
    </div>`,
      )
      .join("")}
  </div>`,
    )
    .join("")}
</td></tr>
`
    : ""
}

<!-- News B: market-wide hot flashes (last ~6h) -->
${
  hotNews.length > 0
    ? `
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">近 6 小时市场热点</h2>
  <p style="margin:4px 0 0;font-size:11px;color:${S.muted};">东方财富 7×24 快讯，已剔除涨跌停/连板等无信息量的标题。</p>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  ${hotNews
    .map((a) => {
      const im = classifyHotNewsImpact(a.title, "", knownNames);
      // Plain prose, one phrase per scope joined by ；: 利好大盘；利好银行板块.
      const scopeText = (s: string): string =>
        s === "大盘"
          ? "大盘"
          : s.startsWith("板块 ")
            ? `${s.slice(3)}板块`
            : s.startsWith("概念 ")
              ? `${s.slice(3)}概念`
              : s.startsWith("个股 ")
                ? s.slice(3)
                : s;
      const impactLine =
        im.impact && im.scopes.length > 0
          ? `<div style="margin-left:12px;margin-top:2px;font-size:10px;color:${S.muted};">${im.scopes.map((s) => `${im.impact}${scopeText(s)}`).join("；")}</div>`
          : "";
      return `
  <div style="margin-bottom:8px;font-size:12px;">
    <span style="color:${S.muted};font-size:11px;">${a.publishedAt.slice(11, 16)}</span>
    ${a.url ? `<a href="${a.url}" style="color:${S.blue};text-decoration:none;">${a.title}</a>` : `<span>${a.title}</span>`}
    <span style="color:${S.muted};font-size:11px;"> — ${a.source}</span>
    ${impactLine}
  </div>`;
    })
    .join("")}
</td></tr>
`
    : ""
}

<!-- Hot-stock technical screen (watch-only mode only) — kept last on purpose -->
${techScreenBlock}

${
  hasCrossCurrency
    ? `
<!-- FX caveat -->
<tr><td style="padding:10px 24px;background:${S.cardBg};border-top:1px solid ${S.border};font-size:11px;color:${S.muted};">
  限价以 ${defaultCurrency} 计价 — 下单前请核对券商报价币种。
</td></tr>`
    : ""
}
${
  fxSkipped.length > 0
    ? `
<!-- FX skipped tickers -->
<tr><td style="padding:10px 24px;background:${S.cardBg};border-top:1px solid ${S.border};font-size:11px;color:${S.yellow};">
  汇率查询失败，已跳过：${fxSkipped.map((s) => `${s.ticker} (${s.reason})`).join(", ")}
</td></tr>`
    : ""
}

<!-- Footer -->
<tr><td style="padding:16px 24px;background:${S.accent};border-radius:0 0 8px 8px;text-align:center;">
  <p style="margin:0;font-size:11px;color:#e0f2fe;">
    修改 CONFIG_JSON 变量可更新你的投资组合 · Powered by Richfolio
  </p>
</td></tr>

</table>
</body>
</html>`;
}

// ── Technical screen (watch-only mode) ──────────────────────────────
// Rule-based "can I buy this today?" verdict per hot stock, rendered for the
// whole top-N list. Pure technical rules — the AI section adds news sentiment
// and deeper reasoning on top of this.
// A-share session limits: main board caps at ±10%. Two-decimal rounding means a
// real limit print lands anywhere from ~9.9% to ~10.1%, so the bar sits at 9.5%.
const LIMIT_CHANGE_THRESHOLD = 9.5;

/** Coloured chip for a special trading state, with a row accent. */
interface StatusChip {
  text: string;
  bg: string;
  fg: string;
  rowBg: string;
  /** Higher wins when several chips land on one row. */
  priority: number;
}

const CHIP_LIMIT_UP: Omit<StatusChip, "text"> = {
  bg: "#fee2e2",
  fg: "#b91c1c",
  rowBg: "#fef2f2",
  priority: 5,
};
const CHIP_LIMIT_DOWN: Omit<StatusChip, "text"> = {
  bg: "#dcfce7",
  fg: "#15803d",
  rowBg: "#f0fdf4",
  priority: 4,
};
const CHIP_DEMON: Omit<StatusChip, "text"> = {
  bg: "#ede9fe",
  fg: "#6d28d9",
  rowBg: "#f5f3ff",
  priority: 6,
};
const CHIP_WHITE_HORSE: Omit<StatusChip, "text"> = {
  bg: "#fef3c7",
  fg: "#b45309",
  rowBg: "#fffbeb",
  priority: 1,
};
// 老龙头 — past-year gain >100% with >15 limit-up days in two years. It
// describes what the stock is; a TODAY limit-up is what it is doing, so the
// daily states out-rank it for the row tint.
const CHIP_OLD_LEADER: Omit<StatusChip, "text"> = {
  bg: "#fce7f3",
  fg: "#be185d",
  rowBg: "#fdf2f8",
  priority: 3,
};
// 国家队 — 汇金/证金/社保/养老 among the latest top-10 holders.
const CHIP_NATIONAL_TEAM: Omit<StatusChip, "text"> = {
  bg: "#ccfbf1",
  fg: "#0f766e",
  rowBg: "#f0fdfa",
  priority: 2,
};

// ── Long-term 底色 labels (from the half-year stock-label DB) ────────
// They describe what a stock IS, never what it did today, so they never win
// the row tint (priority 1) — daily states and 老龙头/国家队 outrank them.
const LONG_TERM_CHIPS: Record<string, Omit<StatusChip, "text">> = {
  白马: { bg: "#fef3c7", fg: "#b45309", rowBg: "#fffbeb", priority: 1 },
  成长: { bg: "#dbeafe", fg: "#1d4ed8", rowBg: "#eff6ff", priority: 1 },
  价值: { bg: "#e0e7ff", fg: "#4338ca", rowBg: "#eef2ff", priority: 1 },
  周期: { bg: "#ffedd5", fg: "#c2410c", rowBg: "#fff7ed", priority: 1 },
  防御: { bg: "#d1fae5", fg: "#065f46", rowBg: "#ecfdf5", priority: 1 },
  绩差: { bg: "#fee2e2", fg: "#991b1b", rowBg: "#fef2f2", priority: 2 },
  僵尸冷门: { bg: "#f1f5f9", fg: "#475569", rowBg: "#f8fafc", priority: 1 },
};

/**
 * 白马股 heuristic — big, consistently profitable, sanely valued. Deliberately
 * loose: it only labels a row, it never gates a recommendation.
 */
function isWhiteHorse(q: QuoteData | undefined): boolean {
  if (!q) return false;
  const cap = q.marketCap ?? 0;
  const roe = q.returnOnEquity ?? 0;
  const pe = q.trailingPE;
  return cap >= 5e10 && roe >= 0.1 && pe != null && pe > 0 && pe <= 60;
}

function statusChips(
  ticker: string,
  t: TechnicalData,
  q: QuoteData | undefined,
  nationalTeam: ReadonlySet<string>,
  longTerm: ReadonlyArray<string> = [],
): StatusChip[] {
  const chips: StatusChip[] = [];
  const chg = t.priceChange1d;

  if (t.consecutiveLimitUps >= 2) {
    chips.push({ ...CHIP_DEMON, text: `${t.consecutiveLimitUps}连板` });
  }
  if (chg != null && chg >= LIMIT_CHANGE_THRESHOLD) {
    chips.push({ ...CHIP_LIMIT_UP, text: "涨停" });
  }
  if (chg != null && chg <= -LIMIT_CHANGE_THRESHOLD) {
    chips.push({ ...CHIP_LIMIT_DOWN, text: "跌停" });
  }
  // 老龙头 screen: "过去一年里涨幅大于100%；过去两年涨停天数大于15；去除st" —
  // the hot list has no ST stocks and no 板块 restrictions, so only the two
  // numeric bars apply.
  if ((t.yearGainPct ?? -Infinity) > 100 && t.limitUpDays2y > 15) {
    chips.push({ ...CHIP_OLD_LEADER, text: "老龙头" });
  }
  if (nationalTeam.has(ticker)) {
    chips.push({ ...CHIP_NATIONAL_TEAM, text: "国家队" });
  }
  if (longTerm.length > 0) {
    // DB-sourced long-term labels win; the ad-hoc 白马 heuristic stays only as
    // a fallback for call sites that have no label DB (tests, edge paths).
    for (const label of longTerm) {
      const chip = LONG_TERM_CHIPS[label];
      if (chip) chips.push({ ...chip, text: label });
    }
  } else if (isWhiteHorse(q)) {
    chips.push({ ...CHIP_WHITE_HORSE, text: "白马" });
  }
  return chips;
}

// Everything a chip render needs. These tags are GLOBAL: any block that shows a
// stock name — AI cards, hold rows, news headers, the technical screen — should
// carry them so the reader never has to cross-reference the screen table.
interface ChipContext {
  technicals: Record<string, TechnicalData>;
  priceData: Record<string, QuoteData>;
  nationalTeam: ReadonlySet<string>;
  longTermLabels?: Record<string, string[]>;
}

function stockChips(ticker: string, ctx: ChipContext): StatusChip[] {
  const t = ctx.technicals[ticker];
  if (!t) return [];
  return statusChips(ticker, t, ctx.priceData[ticker], ctx.nationalTeam, ctx.longTermLabels?.[ticker] ?? []);
}

function renderChips(chips: StatusChip[], fontSize = "9px"): string {
  return chips
    .map(
      (c) =>
        `<span style="display:inline-block;background:${c.bg};color:${c.fg};font-size:${fontSize};font-weight:bold;padding:1px 5px;border-radius:3px;margin-right:3px;">${c.text}</span>`,
    )
    .join("");
}

function techScreenSection(
  technicals: Record<string, TechnicalData>,
  priceData: Record<string, QuoteData>,
  nationalTeam: ReadonlySet<string> = new Set(),
  boards: Record<string, BoardInfo> = {},
  longTermLabels: Record<string, string[]> = {},
): string {
  const entries = Object.entries(technicals);
  if (entries.length === 0) return "";

  // Same-industry peers (from board info) — used to tell 连板龙头 from 妖股:
  // a sector leader drags its peers up with it; a 妖股 detaches from them.
  const recentGainByTicker = new Map(
    entries.map(([tk, td]) => [tk, td.recentGain5d ?? 0] as const),
  );
  const industryByTicker = new Map(
    entries.map(([tk]) => [tk, boards[tk]?.industry ?? ""] as const),
  );
  const isSectorLeader = (ticker: string): boolean => {
    const ind = industryByTicker.get(ticker) ?? "";
    if (!ind) return false;
    const my = recentGainByTicker.get(ticker) ?? 0;
    return entries.every(
      ([tk]) =>
        industryByTicker.get(tk) !== ind ||
        tk === ticker ||
        (recentGainByTicker.get(tk) ?? 0) <= my,
    );
  };

  const rows = entries
    .map(([ticker, t]) => {
      const quote = priceData[ticker];
      const price = quote?.price;
      const chg = t.priceChange1d;
      const chips = statusChips(ticker, t, quote, nationalTeam, longTermLabels[ticker] ?? []);
      // Row tint follows the most significant chip: 连板 > 涨停 > 跌停 > 白马.
      const accent = chips.reduce<StatusChip | null>(
        (best, c) => (best == null || c.priority > best.priority ? c : best),
        null,
      );

      const tags: { text: string; color: string }[] = [];
      if (t.rsi14 != null) {
        if (t.rsi14 >= 70) tags.push({ text: "超买·勿追", color: S.red });
        else if (t.rsi14 <= 30) tags.push({ text: "超卖·关注", color: S.green });
      }
      if (t.goldenCross) tags.push({ text: "金叉", color: S.green });
      if (t.deathCross) tags.push({ text: "死叉", color: S.red });
      if (t.macdCrossover === "bullish") tags.push({ text: "MACD看多", color: S.green });
      if (t.macdCrossover === "bearish") tags.push({ text: "MACD看空", color: S.red });
      if (t.priceVsSma50 != null) {
        tags.push(
          t.priceVsSma50 > 0
            ? { text: "站上50日线", color: S.green }
            : { text: "跌破50日线", color: S.red },
        );
      }
      if (tags.length === 0) {
        tags.push({ text: `动量${MOMENTUM_LABELS[t.momentumSignal] ?? t.momentumSignal}`, color: S.muted });
      }

      // Tiered verdict by signal characteristics, rendered as a pill badge:
      //   密切关注 — two or more bullish signals line up and none contradict;
      //   可关注   — exactly one bullish signal (or mixed, one each side);
      //   无需关注 — nothing bullish, or several bearish signals stacked.
      // A short-term 盘面形态 prefix (妖股/超跌反弹/趋势中军/…) is prepended,
      // mirroring the classic retail taxonomy — these are session-level states.
      const bullish =
        (t.goldenCross ? 1 : 0) +
        (t.macdCrossover === "bullish" ? 1 : 0) +
        (t.rsi14 != null && t.rsi14 <= 35 ? 1 : 0) +
        (t.volumeLatest1d != null && t.volumeLatest1d >= 1.5 && (chg ?? 0) > 0 ? 1 : 0);
      const bearish =
        (t.deathCross ? 1 : 0) +
        (t.macdCrossover === "bearish" ? 1 : 0) +
        (t.rsi14 != null && t.rsi14 >= 70 ? 1 : 0);

      const atLimitUp = chg != null && chg >= LIMIT_CHANGE_THRESHOLD;
      const atLimitDown = chg != null && chg <= -LIMIT_CHANGE_THRESHOLD;
      const vsSma50 = t.priceVsSma50;
      const vsSma200 = t.priceVsSma200;
      const vol = t.volumeLatest1d;

      // Short-term form from daily bars/量能 only (no intraday/tape data —
      // 庄股/情绪股/跟风 need evidence daily bars cannot prove, so they are
      // left unlabelled rather than guessed).
      const shortType = (() => {
        if (t.consecutiveLimitUps >= 2) return isSectorLeader(ticker) ? "连板龙头" : "妖股";
        if (atLimitUp) return "涨停";
        if (atLimitDown) return "跌停";
        // 主跌之后拉起：放量修复=超跌反弹；缩量自救=反抽（重点避坑）。
        if ((vsSma200 ?? 0) < 0 && (t.recentGain5d ?? 0) >= 5 && (vol ?? 0) >= 1.5) return "超跌反弹";
        if ((vsSma200 ?? 0) < 0 && (vsSma50 ?? 0) < 0 && (chg ?? 0) > 0 && (vol ?? 1) < 1) return "反抽";
        // 消息日爆量急涨、脱离基本面节奏 → 题材脉冲。
        if ((chg ?? 0) >= 4.5 && (vol ?? 0) >= 2 && (boards[ticker]?.concepts?.length ?? 0) > 0) return "题材脉冲";
        // 沿均线稳步上行、进二退一 → 趋势中军（5日涨幅过大说明已加速）。
        if ((vsSma50 ?? 0) > 0 && (vsSma200 ?? 0) > 0 && (t.recentGain5d ?? 0) < 15) return "趋势中军";
        // 长期在均线附近窄幅来回 → 箱体波段。
        if (vsSma200 != null && Math.abs(vsSma200) <= 5 && t.rsi14 != null && t.rsi14 >= 40 && t.rsi14 <= 65) return "箱体波段";
        return null;
      })();

      const tier = (() => {
        if (t.consecutiveLimitUps >= 2 || atLimitUp) return { text: "勿追", bg: t.consecutiveLimitUps >= 2 ? "#ede9fe" : "#fee2e2", fg: t.consecutiveLimitUps >= 2 ? "#6d28d9" : "#b91c1c" };
        if (atLimitDown) return { text: "勿接", bg: "#dcfce7", fg: "#15803d" };
        if (bearish >= 2 || bullish === 0) return { text: "无需关注", bg: "#f1f5f9", fg: "#64748b" };
        if (bullish >= 2) return { text: "密切关注", bg: "#dcfce7", fg: "#15803d" };
        return { text: "可关注", bg: "#fef9c3", fg: "#a16207" };
      })();
      // 反抽 overrides the tier — by definition it is a trap to avoid.
      const verdict: { text: string; bg: string; fg: string } =
        shortType === "反抽"
          ? { text: "反抽·回避", bg: "#fee2e2", fg: "#b91c1c" }
          : { text: shortType ? `${shortType}·${tier.text}` : tier.text, bg: tier.bg, fg: tier.fg };

      const board = boards[ticker];
      const boardLine1 = board
        ? [board.industry, board.region].filter(Boolean).join(" · ") || "—"
        : "—";
      const boardLine2 = board?.concepts.slice(0, 3).join(" / ") ?? "";

      const rowBg = accent ? `background:${accent.rowBg};` : "";
      const rowBorder = accent
        ? `border-left:3px solid ${accent.fg};`
        : "border-left:3px solid transparent;";

      return `
    <tr style="${rowBg}">
      <td style="padding:4px 3px;${rowBorder}border-bottom:1px solid ${S.border};font-weight:bold;color:#1a202c;">${displayName(ticker)}<div style="font-size:9px;color:${S.muted};font-weight:normal;">${ticker}</div>${chips.length > 0 ? `<div style="margin-top:2px;">${renderChips(chips)}</div>` : ""}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};color:#1a202c;">${boardLine1}${boardLine2 ? `<div style="font-size:9px;color:${S.muted};">${boardLine2}</div>` : ""}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;color:#1a202c;">${price != null ? fmt$(price) : "—"}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;color:#1a202c;">${chg == null ? "—" : fmtPct(chg)}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">RSI ${t.rsi14 ?? "—"}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">${tags.map((x) => `<span style="color:${x.color};font-size:10px;">${x.text}</span>`).join(" ")}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;"><span style="display:inline-block;background:${verdict.bg};color:${verdict.fg};font-size:10px;font-weight:bold;padding:2px 8px;border-radius:10px;white-space:nowrap;">${verdict.text}</span></td>
    </tr>`;
    })
    .join("");

  return `
<tr><td style="padding:16px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">热度股技术面快筛</h2>
  <p style="margin:4px 0 0;font-size:11px;color:${S.muted};">按当日热度排序 · 规则判定仅供参考，深度分析见上方 AI 建议。</p>
  <p style="margin:6px 0 0;font-size:10px;color:${S.muted};">
    <span style="display:inline-block;background:${CHIP_LIMIT_UP.bg};color:${CHIP_LIMIT_UP.fg};font-weight:bold;padding:1px 5px;border-radius:3px;">涨停</span>
    <span style="display:inline-block;background:${CHIP_LIMIT_DOWN.bg};color:${CHIP_LIMIT_DOWN.fg};font-weight:bold;padding:1px 5px;border-radius:3px;">跌停</span>
    <span style="display:inline-block;background:${CHIP_DEMON.bg};color:${CHIP_DEMON.fg};font-weight:bold;padding:1px 5px;border-radius:3px;">连板妖股</span>
    <span style="display:inline-block;background:${CHIP_OLD_LEADER.bg};color:${CHIP_OLD_LEADER.fg};font-weight:bold;padding:1px 5px;border-radius:3px;">老龙头</span>
    <span style="display:inline-block;background:${CHIP_NATIONAL_TEAM.bg};color:${CHIP_NATIONAL_TEAM.fg};font-weight:bold;padding:1px 5px;border-radius:3px;">国家队</span>
    <span style="display:inline-block;background:${CHIP_WHITE_HORSE.bg};color:${CHIP_WHITE_HORSE.fg};font-weight:bold;padding:1px 5px;border-radius:3px;">白马</span>
    　标签标注股票类型，文字保持黑色。
  </p>
  <p style="margin:4px 0 0;font-size:10px;color:${S.muted};">
    老龙头：近一年涨幅&gt;100% 且两年涨停&gt;15 次 · 国家队：汇金/证金/社保/养老/国新现身前十大股东 · 白马：市值≥500亿、ROE≥10%、PE≤60
  </p>
  <p style="margin:4px 0 0;font-size:10px;color:${S.muted};">
    结论分级：<span style="display:inline-block;background:#dcfce7;color:#15803d;font-weight:bold;padding:1px 6px;border-radius:10px;">密切关注</span> 两项以上利好共振（金叉/MACD多头/深度超卖/放量上涨） ·
    <span style="display:inline-block;background:#fef9c3;color:#a16207;font-weight:bold;padding:1px 6px;border-radius:10px;">可关注</span> 单项利好 ·
    <span style="display:inline-block;background:#f1f5f9;color:#64748b;font-weight:bold;padding:1px 6px;border-radius:10px;">无需关注</span> 无信号或多项利空叠加
  </p>
  <p style="margin:4px 0 0;font-size:10px;color:${S.muted};">
    形态前缀（短期盘面状态，随行情切换）：妖股 / 连板龙头 · 涨停 · 跌停 · 超跌反弹（放量修复） · 反抽（缩量自救，回避） · 题材脉冲 · 趋势中军 · 箱体波段；前缀后接分级，如「趋势中军·可关注」。
  </p>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:11px;">
    <tr style="color:${S.muted};font-size:10px;text-transform:uppercase;">
      <td style="padding:4px 3px 4px 6px;border-bottom:1px solid ${S.border};">名称</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">板块</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">现价</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">涨跌</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">RSI</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">信号</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;">结论</td>
    </tr>
    ${rows}
  </table>
</td></tr>`;
}

// ── Send email ──────────────────────────────────────────────────────
export async function sendBrief(
  report: AllocationReport,
  news: Record<string, NewsItem[]>,
  aiRecs: AIBuyRecommendation[] = [],
  technicals: Record<string, TechnicalData> = {},
  priceData: Record<string, QuoteData> = {},
  fxSkipped: Array<{ ticker: string; reason: string }> = [],
  hotNews: NewsItem[] = [],
  nationalTeam: ReadonlySet<string> = new Set(),
  boards: Record<string, BoardInfo> = {},
  longTermLabels: Record<string, string[]> = {},
): Promise<void> {
  const html = buildEmailHtml(
    report,
    news,
    aiRecs,
    technicals,
    priceData,
    fxSkipped,
    hotNews,
    nationalTeam,
    boards,
    longTermLabels,
  );

  const { error } = await resend.emails.send({
    from: "Richfolio <onboarding@resend.dev>",
    to: recipientEmail,
    subject: `Richfolio 每日简报（${briefPeriod()}） — ${new Date().toLocaleDateString("zh-CN")}`,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Email sent to ${recipientEmail}`);
}
