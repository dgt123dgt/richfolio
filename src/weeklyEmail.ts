import { Resend } from "resend";
import { recipientEmail, displayName } from "./config.js";
import { escapeHtmlAttr } from "./util.js";
import type { WeeklyReview, PredictionOutcome } from "./weeklyReview.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Styles (light, cheerful theme — matches daily email) ────────────
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

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  deepseek: "DeepSeek",
};

function pct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function outcomeRow(o: PredictionOutcome, highlight: string): string {
  const color = o.pctChange >= 0 ? S.green : S.red;
  return `
    <tr>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};font-size:10px;color:${S.muted};">${o.date.slice(5)}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};font-weight:bold;" title="${escapeHtmlAttr(o.ticker)}">${displayName(o.ticker)}<div style="font-size:9px;color:${S.muted};font-weight:normal;">${o.ticker}</div></td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;">${highlight}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;color:${color};">${pct(o.pctChange)}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;font-size:10px;">${o.providerId === "gemini" ? "Gemini" : o.providerId === "deepseek" ? "DeepSeek" : o.providerId}</td>
    </tr>`;
}

// ── Build HTML ──────────────────────────────────────────────────────
export function buildWeeklyReviewHtml(review: WeeklyReview): string {
  const date = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const perProviderRows = Object.entries(review.perProvider)
    .map(([id, b]) => {
      const scored = b.hits + b.misses;
      const acc = scored > 0 ? ((b.hits / scored) * 100).toFixed(0) : "—";
      return `<td style="text-align:center;padding:8px;">
        <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">${PROVIDER_LABELS[id] ?? id}</div>
        <div style="font-size:18px;font-weight:bold;color:#1a202c;">${acc}%<div style="font-size:10px;color:${S.muted};font-weight:normal;">准${b.hits} / 错${b.misses}</div></div>
      </td>`;
    })
    .join("");

  // Worst misses first for the failure table.
  const worstMisses = [...review.misses].sort((a, b) => a.pctChange - b.pctChange).slice(0, 20);
  const missRows = worstMisses
    .map((m) => outcomeRow(m, `<span style="color:${S.red};font-size:11px;font-weight:bold;">${m.action}</span>`))
    .join("");
  const hitRows = [...review.hits]
    .sort((a, b) => b.pctChange - a.pctChange)
    .slice(0, 20)
    .map((h) => outcomeRow(h, `<span style="color:${S.green};font-size:11px;font-weight:bold;">${h.action}</span>`))
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${S.text};font-size:14px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;">

<!-- Header -->
<tr><td style="padding:20px 24px;background:${S.accent};border-radius:8px 8px 0 0;">
  <h1 style="margin:0;font-size:22px;color:#ffffff;">每周预测复盘</h1>
  <p style="margin:6px 0 0;color:#e0f2fe;font-size:13px;">${date} · 覆盖 ${review.daysCovered.length} 个预测日（${review.daysCovered[0] ?? "—"} ~ ${review.daysCovered[review.daysCovered.length - 1] ?? "—"}）</p>
  <p style="margin:4px 0 0;color:#e0f2fe;font-size:12px;">判定规则：买入后一周涨跌 ≥±3% 记准/错；观望反之；持有不计分。</p>
</td></tr>

<!-- Score stats -->
<tr><td style="padding:16px 24px;background:${S.cardBg};border-bottom:1px solid ${S.border};">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">总预测次数</div>
      <div style="font-size:20px;font-weight:bold;color:#1a202c;">${review.totalPredictions}</div>
    </td>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">准确率</div>
      <div style="font-size:20px;font-weight:bold;color:${review.accuracy >= 50 ? S.green : S.red};">${review.totalPredictions > 0 ? review.accuracy.toFixed(0) + "%" : "—"}</div>
    </td>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">准 / 错</div>
      <div style="font-size:20px;font-weight:bold;color:#1a202c;"><span style="color:${S.green};">${review.hits.length}</span> / <span style="color:${S.red};">${review.misses.length}</span></div>
    </td>
    ${perProviderRows}
  </tr></table>
</td></tr>

${
  !review.hasData
    ? `<tr><td style="padding:24px;background:${S.cardBg};border-top:1px solid ${S.border};font-size:13px;color:${S.muted};">
  本周没有可复盘的预测记录（复盘功能刚上线，需要积累几天的每日简报数据后才有意义）。
</td></tr>`
    : `
<!-- Failure diagnosis -->
${
  review.diagnosis
    ? `<tr><td style="padding:20px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">失败因素诊断（AI 分析）</h2>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <div style="font-size:12px;color:${S.text};line-height:1.7;white-space:pre-line;">${review.diagnosis}</div>
</td></tr>`
    : ""
}

<!-- Worst misses -->
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${S.red};">错误预测 TOP（亏最多在前）</h2>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;">
    <tr style="color:${S.muted};font-size:10px;text-transform:uppercase;">
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">日期</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">名称</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;">预测</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">一周实际</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;">来源</td>
    </tr>
    ${missRows || `<tr><td colspan="5" style="padding:8px;color:${S.muted};">本周没有错误预测 🎉</td></tr>`}
  </table>
</td></tr>

<!-- Correct calls -->
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${S.green};">正确预测 TOP</h2>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;">
    <tr style="color:${S.muted};font-size:10px;text-transform:uppercase;">
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">日期</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">名称</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;">预测</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">一周实际</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;">来源</td>
    </tr>
    ${hitRows || `<tr><td colspan="5" style="padding:8px;color:${S.muted};">本周没有达到 ±3% 的正确预测。</td></tr>`}
  </table>
</td></tr>`
}

<!-- Footer -->
<tr><td style="padding:16px 24px;background:${S.accent};border-radius:0 0 8px 8px;text-align:center;">
  <p style="margin:0;font-size:11px;color:#e0f2fe;">
    每周策略复盘 · Powered by Richfolio
  </p>
</td></tr>

</table>
</body>
</html>`;
}

// ── Send email ──────────────────────────────────────────────────────
export async function sendWeeklyReview(review: WeeklyReview): Promise<void> {
  const html = buildWeeklyReviewHtml(review);

  const { error } = await resend.emails.send({
    from: "Richfolio <onboarding@resend.dev>",
    to: recipientEmail,
    subject: `Richfolio 周度复盘 — 准确率 ${review.totalPredictions > 0 ? review.accuracy.toFixed(0) + "%" : "无数据"}（${new Date().toLocaleDateString("zh-CN")}）`,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Weekly review email sent to ${recipientEmail}`);
}
