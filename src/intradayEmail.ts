import { Resend } from "resend";
import { recipientEmail, defaultCurrency, displayName } from "./config.js";
import type { IntradayAlert } from "./intradayCompare.js";
import type { AIBuyRecommendation } from "./aiAnalysis.js";
import type { QuoteData } from "./fetchPrices.js";
import { escapeHtmlAttr, formatMoney } from "./util.js";
import { isMultiAI, formatCompactScores, formatDegradationLabel } from "./providerBreakdown.js";
import { hasStrongBuyVote } from "./aiAggregation.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// Same predicate the daily brief uses, adapted to an alert's `currentAction`:
// any provider's STRONG BUY vote keeps the limit price and the analysis link,
// even when the dissent-distance rule capped the consensus at BUY.
const alertHasStrongBuyVote = (a: IntradayAlert): boolean =>
  hasStrongBuyVote({ action: a.currentAction, providers: a.providers });

// ── Styles (light, cheerful theme — matches email.ts) ───────────────
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
} as const;

// ── Helpers ─────────────────────────────────────────────────────────
const fmt$ = (n: number) => formatMoney(n, defaultCurrency);

// Money belonging to a specific alert. A crypto cross-pair is quoted in its own
// coin and never FX-converted, so its prices must not render with a `$`.
const fmtAlert = (a: IntradayAlert, n: number) =>
  formatMoney(n, a.quoteCurrency ?? defaultCurrency);

// The single currency every alert in this email shares, or null when they differ
// (in which case the header must not claim one and each figure speaks for itself).
function sharedCurrency(alerts: IntradayAlert[]): string | null {
  const set = new Set(alerts.map((a) => a.quoteCurrency ?? defaultCurrency));
  return set.size === 1 ? [...set][0] : null;
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

// Chinese display labels for the action enum (rendering only).
const ACTION_LABELS: Record<string, string> = {
  "STRONG BUY": "强烈买入",
  BUY: "买入",
  HOLD: "持有",
  WAIT: "观望",
  TRIM: "减持",
};

const AGREEMENT_LABELS: Record<string, string> = {
  unanimous: "全体一致",
  majority: "多数一致",
  split: "意见分歧",
};

function triggerLabel(type: IntradayAlert["triggerType"]): string {
  switch (type) {
    case "action_upgrade":
      return "升级为强烈买入";
    case "action_downgrade":
      return "从强烈买入下调";
    case "confidence_change":
      return "置信度变化";
  }
}

function priceDeltaHtml(delta: number): string {
  if (Math.abs(delta) < 0.01) return "";
  const color = delta < 0 ? S.green : S.red; // price drop = green (buying opp)
  const sign = delta > 0 ? "+" : "";
  return `<span style="color:${color};font-size:12px;">早盘以来价格 ${sign}${delta.toFixed(1)}%</span>`;
}

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

// ── Multi-AI compact breakdown (mirrors email.ts's daily badges) ─────
// Intraday/refresh are terse "this changed" pings, not the full read the
// daily brief is — so this shows the compact score line only, never the
// per-provider reason rows.
function agreementBadgeHtml(agreement: AIBuyRecommendation["agreement"]): string {
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
// must NOT look like a verified consensus — this is the load-bearing safety
// signal on this surface: without it a capped BUY (applyDegradedProviderPolicy)
// is indistinguishable from a genuine one. Shown even outside multi-AI
// rendering, matching degradedBadge() in email.ts.
function degradedBadgeHtml(degradation: AIBuyRecommendation["degradation"]): string {
  if (!degradation) return "";
  const label = formatDegradationLabel(degradation);
  const title = escapeHtmlAttr(
    `${degradation.missing.join(", ")} 未响应 — 本次运行无法验证跨 AI 一致性`,
  );
  return `<span title="${title}" style="background:${S.yellow}22;color:${S.yellow};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;margin-left:6px;">⚠ ${label}</span>`;
}

// Compact per-provider score line, e.g. "C BUY 43% · M STRONG BUY 82%". Empty string
// (not shown) outside multi-AI mode.
function compactScoresHtml(rec: Pick<AIBuyRecommendation, "providers">): string {
  if (!isMultiAI(rec)) return "";
  const scores = escapeHtmlAttr(formatCompactScores(rec)!);
  return `<div style="font-size:11px;color:${S.muted};margin-bottom:4px;">${scores}</div>`;
}

function summarizeAlertDirection(alerts: IntradayAlert[]): string {
  const hasStrengthened = alerts.some(
    (a) =>
      a.triggerType === "action_upgrade" ||
      (a.triggerType === "confidence_change" && a.confidenceDelta > 0),
  );
  const hasWeakened = alerts.some(
    (a) =>
      a.triggerType === "action_downgrade" ||
      (a.triggerType === "confidence_change" && a.confidenceDelta < 0),
  );
  if (hasStrengthened && hasWeakened) return "有升有降";
  if (hasWeakened) return "走弱";
  return "走强";
}

// ── Build HTML ──────────────────────────────────────────────────────
export function buildIntradayEmailHtml(alerts: IntradayAlert[]): string {
  // Scoped to alerts only (not full portfolio) — caveat applies only to limit prices shown in this email.
  // Cross-pairs are excluded: their figures already render in their own quote
  // coin, so a "shown in <report currency>" note would be plainly wrong.
  const hasCrossCurrency = alerts.some(
    (a) => a.assetKind !== "crypto-cross" && a.originalCurrency !== defaultCurrency,
  );
  const headerCurrency = sharedCurrency(alerts);
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const date = new Date().toLocaleDateString("zh-CN", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const alertRows = alerts
    .map(
      (a) => `
  <div style="padding:14px 0;border-bottom:1px solid ${S.border};">
    <div style="margin-bottom:6px;">
      <span style="font-weight:bold;font-size:16px;color:#1a202c;" title="${escapeHtmlAttr(a.tickerFullName ?? a.ticker)}">${displayName(a.ticker, a.tickerFullName)}</span>
      <span style="font-size:11px;color:${S.muted};">${a.ticker}</span>
      &nbsp;${actionBadge(a.currentAction)}${valueRatingBadge(a.valueRating)}${isMultiAI(a) ? agreementBadgeHtml(a.agreement) : ""}${degradedBadgeHtml(a.degradation)}
      <span style="float:right;font-size:11px;color:${S.yellow};text-transform:uppercase;">${triggerLabel(a.triggerType)}</span>
    </div>
    <div style="margin-bottom:6px;">
      <span style="color:${S.muted};font-size:12px;">早盘：</span>
      <span style="font-size:12px;color:${S.text};">${ACTION_LABELS[a.morningAction] ?? a.morningAction} ${a.morningConfidence}%</span>
      <span style="color:${S.muted};font-size:12px;"> → </span>
      <span style="font-size:13px;font-weight:bold;color:#1a202c;">${ACTION_LABELS[a.currentAction] ?? a.currentAction} ${a.currentConfidence}%</span>
      ${
        // Only show the numeric delta when the action stayed the same — comparing
        // confidence across action tiers (STRONG BUY 82% → BUY 67%) is misleading
        // because the calibration scales aren't directly comparable; the action
        // change itself IS the signal, the number adds noise.
        a.morningAction === a.currentAction
          ? `<span style="color:${a.confidenceDelta >= 0 ? S.green : S.red};font-size:12px;"> (${a.confidenceDelta >= 0 ? "+" : ""}${a.confidenceDelta})</span>`
          : ""
      }
    </div>
    ${compactScoresHtml(a)}
    ${priceDeltaHtml(a.priceDelta) ? `<div style="margin-bottom:6px;">${priceDeltaHtml(a.priceDelta)}</div>` : ""}
    <div style="font-size:12px;color:${S.text};margin-bottom:4px;">${a.reason}</div>
    ${a.suggestedBuyValue > 0 ? `<div style="font-size:13px;font-weight:bold;color:#1a202c;">建议买入：${fmtAlert(a, a.suggestedBuyValue)}</div>` : ""}
    ${alertHasStrongBuyVote(a) && a.suggestedLimitPrice && a.suggestedLimitPrice > 0 ? `<div style="font-size:12px;color:${S.green};margin-top:4px;">限价建议：${fmtAlert(a, a.suggestedLimitPrice)}${a.limitPriceReason ? ` — ${a.limitPriceReason}` : ""}</div>` : ""}
    ${a.bottomSignal && a.bottomSignal !== "" ? `<div style="font-size:11px;color:${S.yellow};margin-top:4px;">见底信号：${a.bottomSignal}</div>` : ""}
    ${alertHasStrongBuyVote(a) && a.analysisUrl ? `<div style="margin-top:8px;"><a href="${a.analysisUrl}" style="display:inline-block;background:#3498db22;color:#3498db;padding:4px 12px;border-radius:4px;font-size:11px;font-weight:bold;text-decoration:none;border:1px solid #3498db44;">查看详情 &rarr;</a></div>` : ""}
  </div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${S.text};font-size:14px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;">

<!-- Header -->
<tr><td style="padding:20px 24px;background:${S.accent};border-radius:8px 8px 0 0;">
  <h1 style="margin:0;font-size:20px;color:${S.yellow};">盘中信号告警</h1>
  <p style="margin:6px 0 0;color:#e0f2fe;font-size:13px;">${date} ${time}</p>
  <p style="margin:4px 0 0;color:${S.text};font-size:12px;">较早盘简报 ${alerts.length} 个信号${summarizeAlertDirection(alerts)}${headerCurrency ? ` · ${headerCurrency}` : ""}</p>
</td></tr>

<!-- Alerts -->
<tr><td style="padding:8px 24px 16px;background:${S.cardBg};">
  ${alertRows}
</td></tr>

<!-- Footer -->
<tr><td style="padding:12px 24px;background:${S.accent};border-radius:0 0 8px 8px;text-align:center;">
  <p style="margin:0;font-size:11px;color:#e0f2fe;">
    盘中检查 · Powered by Richfolio
  </p>
</td></tr>

${
  hasCrossCurrency
    ? `<tr><td style="padding:10px 24px;background:${S.cardBg};border-top:1px solid ${S.border};font-size:11px;color:${S.muted};">
  限价以 ${defaultCurrency} 计价 — 下单前请核对券商报价币种。
</td></tr>`
    : ""
}

</table>
</body>
</html>`;
}

// ── Send email ──────────────────────────────────────────────────────
export async function sendIntradayAlert(alerts: IntradayAlert[]): Promise<void> {
  const html = buildIntradayEmailHtml(alerts);
  const tickers = alerts.map((a) => a.ticker).join(", ");

  const { error } = await resend.emails.send({
    from: "Richfolio <onboarding@resend.dev>",
    to: recipientEmail,
    subject: `Richfolio 告警：${tickers} 信号${summarizeAlertDirection(alerts)}`,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Intraday alert email sent to ${recipientEmail}`);
}

// ── Refresh Analysis Email ──────────────────────────────────────────
export async function sendRefreshEmail(
  ticker: string,
  rec: AIBuyRecommendation,
  quote: QuoteData,
  priceSource: string,
): Promise<void> {
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const date = new Date().toLocaleDateString("zh-CN", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${S.text};font-size:14px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;">

<!-- Header -->
<tr><td style="padding:20px 24px;background:${S.accent};border-radius:8px 8px 0 0;">
  <h1 style="margin:0;font-size:20px;color:${S.blue};">单独复检 — ${ticker}</h1>
  <p style="margin:6px 0 0;color:#e0f2fe;font-size:13px;">${date} ${time} · ${defaultCurrency}</p>
  <p style="margin:4px 0 0;color:${S.text};font-size:12px;">已使用 ${priceSource} 价格更新</p>
</td></tr>

<!-- Content -->
<tr><td style="padding:16px 24px;background:${S.cardBg};">
  <div style="margin-bottom:10px;">
    <span style="font-weight:bold;font-size:18px;color:#1a202c;" title="${escapeHtmlAttr(quote.longName ?? ticker)}">${displayName(ticker, quote.longName ?? undefined)}</span>
    <span style="font-size:12px;color:${S.muted};">${ticker}</span>
    &nbsp;${actionBadge(rec.action)}${rec.valueRating ? valueRatingBadge(rec.valueRating) : ""}${isMultiAI(rec) ? agreementBadgeHtml(rec.agreement) : ""}${degradedBadgeHtml(rec.degradation)}
  </div>
  <div style="font-size:13px;color:#1a202c;margin-bottom:6px;">置信度：<strong>${rec.confidence}%</strong></div>
  ${compactScoresHtml(rec)}
  <div style="font-size:13px;color:#1a202c;margin-bottom:8px;">现价：<strong>${fmt$(quote.price)}</strong> <span style="color:${S.muted};">（${priceSource}）</span></div>
  <div style="font-size:12px;color:${S.text};margin-bottom:10px;">${rec.reason}</div>
  ${rec.suggestedBuyValue > 0 ? `<div style="font-size:13px;font-weight:bold;color:#1a202c;margin-bottom:4px;">建议买入：${fmt$(rec.suggestedBuyValue)}</div>` : ""}
  ${rec.suggestedLimitPrice && rec.suggestedLimitPrice > 0 ? `<div style="font-size:12px;color:${S.green};margin-bottom:4px;">限价建议：${fmt$(rec.suggestedLimitPrice)}${rec.limitPriceReason ? ` — ${rec.limitPriceReason}` : ""}</div>` : ""}
  ${rec.bottomSignal ? `<div style="font-size:11px;color:${S.yellow};margin-bottom:4px;">见底信号：${rec.bottomSignal}</div>` : ""}
  ${rec.analysisUrl ? `<div style="margin-top:12px;"><a href="${rec.analysisUrl}" style="display:inline-block;background:#3498db22;color:#3498db;padding:6px 16px;border-radius:4px;font-size:12px;font-weight:bold;text-decoration:none;border:1px solid #3498db44;">查看完整分析 &rarr;</a></div>` : ""}
</td></tr>

<!-- Footer -->
<tr><td style="padding:12px 24px;background:${S.accent};border-radius:0 0 8px 8px;text-align:center;">
  <p style="margin:0;font-size:11px;color:#e0f2fe;">
    单独复检 · Powered by Richfolio
  </p>
</td></tr>

</table>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from: "Richfolio <onboarding@resend.dev>",
    to: recipientEmail,
    subject: `Richfolio 复检：${ACTION_LABELS[rec.action] ?? rec.action} ${ticker}（${rec.confidence}%）`,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Refresh email sent to ${recipientEmail}`);
}
