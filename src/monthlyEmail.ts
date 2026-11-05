// ── Monthly report email ────────────────────────────────────────────
// 双 AI 月度复盘：净值曲线图（QuickChart PNG）、个股盈亏表、两个 AI 的
// 操作特点 / 市场态势 / 自我评价 / 改进方向。

import { Resend } from "resend";
import { recipientEmail } from "./config.js";
import { escapeHtmlAttr } from "./util.js";
import type { MonthlyReport, BookMonthlyReport } from "./monthlyReport.js";
import { MONTHLY_CAPITAL } from "./paperTrading.js";

const resend = new Resend(process.env.RESEND_API_KEY);

const S = {
  bg: "#eff6ff",
  cardBg: "#ffffff",
  text: "#334155",
  muted: "#64748b",
  accent: "#0ea5e9",
  green: "#22c55e",
  red: "#ef4444",
  blue: "#3b82f6",
  amber: "#f59e0b",
  border: "#e2e8f0",
} as const;

const money = (n: number): string => `¥${Math.round(n).toLocaleString("en-US")}`;
const pctStr = (n: number | null): string => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const pnlColor = (n: number): string => (n >= 0 ? "#b91c1c" : "#15803d"); // A-share convention: red = up

const BOOK_COLORS: Record<string, string> = { deepseek: S.blue, gemini: S.amber };

function statCard(b: BookMonthlyReport): string {
  const s = b.stats;
  const winRate = s.winCount + s.lossCount > 0 ? `${Math.round((s.winCount / (s.winCount + s.lossCount)) * 100)}%` : "—";
  return `
  <tr><td style="padding:16px 24px;border-top:1px solid ${S.border};">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:14px;font-weight:bold;color:${BOOK_COLORS[b.id] ?? S.text};padding-bottom:8px;">
          ${b.label}仓 · ${s.pnl != null ? (s.pnl >= 0 ? "盈利" : "亏损") : "进行中"}
          <span style="font-size:11px;color:${S.muted};font-weight:normal;">已平仓 赢${s.winCount}/亏${s.lossCount}（胜率 ${winRate}）</span>
        </td>
      </tr>
      <tr>
        <td style="text-align:center;padding:6px;">
          <div style="font-size:10px;color:${S.muted};">期末资产</div>
          <div style="font-size:17px;font-weight:bold;color:#1a202c;">${s.endTotal != null ? money(s.endTotal) : "—"}</div>
        </td>
        <td style="text-align:center;padding:6px;">
          <div style="font-size:10px;color:${S.muted};">月盈亏</div>
          <div style="font-size:17px;font-weight:bold;color:${s.pnl != null ? pnlColor(s.pnl) : S.text};">${s.pnl != null ? `${s.pnl >= 0 ? "+" : ""}${money(s.pnl)}` : "—"}</div>
        </td>
        <td style="text-align:center;padding:6px;">
          <div style="font-size:10px;color:${S.muted};">收益率</div>
          <div style="font-size:17px;font-weight:bold;color:${s.pnlPct != null ? pnlColor(s.pnlPct) : S.text};">${pctStr(s.pnlPct)}</div>
        </td>
        <td style="text-align:center;padding:6px;">
          <div style="font-size:10px;color:${S.muted};">最大回撤</div>
          <div style="font-size:17px;font-weight:bold;color:${S.red};">${s.maxDrawdownPct != null ? s.maxDrawdownPct.toFixed(2) + "%" : "—"}</div>
        </td>
        <td style="text-align:center;padding:6px;">
          <div style="font-size:10px;color:${S.muted};">平均持仓</div>
          <div style="font-size:17px;font-weight:bold;color:#1a202c;">${s.avgHoldDays != null ? s.avgHoldDays.toFixed(1) + "日" : "—"}</div>
        </td>
        <td style="text-align:center;padding:6px;">
          <div style="font-size:10px;color:${S.muted};">买卖笔数</div>
          <div style="font-size:17px;font-weight:bold;color:#1a202c;">${s.buyCount}/${s.sellCount}</div>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

function roundTripTable(b: BookMonthlyReport): string {
  const rows = b.stats.roundTrips
    .map(
      (r) => `
    <tr>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};font-weight:bold;color:#1a202c;">${r.name}<span style="font-size:9px;color:${S.muted};font-weight:normal;">　${r.ticker}</span></td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;color:${S.text};">${money(r.buyAmount)}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;color:${S.text};">${r.soldShares > 0 ? money(r.sellAmount) : "—"}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;font-weight:bold;color:${r.realized != null ? (r.realized >= 0 ? "#b91c1c" : "#15803d") : S.muted};">${r.realized != null ? `${r.realized >= 0 ? "+" : ""}${money(r.realized)}` : "—"}</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;font-size:10px;color:${S.muted};">${r.status}${r.holdDays != null ? ` · ${r.holdDays}日` : ""}</td>
    </tr>`,
    )
    .join("");
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;">
    <tr style="color:${S.muted};font-size:10px;">
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};">个股</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">买入</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">卖出</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:right;">已实现盈亏</td>
      <td style="padding:4px 3px;border-bottom:1px solid ${S.border};text-align:center;">状态</td>
    </tr>
    ${rows || `<tr><td colspan="5" style="padding:8px;color:${S.muted};">本月无交易。</td></tr>`}
  </table>`;
}

function reviewCard(b: BookMonthlyReport): string {
  if (!b.review) return "";
  return `
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h2 style="margin:0;font-size:16px;color:${BOOK_COLORS[b.id] ?? S.blue};">${b.label} 的月度自我复盘</h2>
  <p style="margin:4px 0 0;font-size:10px;color:${S.muted};">基于该 AI 自己当月全部交易数据与每日简报存档。</p>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <div style="font-size:12px;color:${S.text};line-height:1.7;white-space:pre-line;">${escapeHtmlAttr(b.review)}</div>
</td></tr>`;
}

export function buildMonthlyReportHtml(report: MonthlyReport): string {
  const date = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${S.text};font-size:14px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;">

<tr><td style="padding:20px 24px;background:${S.accent};border-radius:8px 8px 0 0;">
  <h1 style="margin:0;font-size:22px;color:#ffffff;">月度复盘 · ${report.month}</h1>
  <p style="margin:6px 0 0;color:#e0f2fe;font-size:13px;">${date} · 双 AI 模拟盘（初始各 ${money(MONTHLY_CAPITAL)}，互不影响）</p>
</td></tr>

<tr><td style="padding:20px 24px;background:${S.cardBg};border-bottom:1px solid ${S.border};text-align:center;">
  <img src="${report.chartUrl}" width="600" alt="本月净值曲线" style="max-width:100%;border:1px solid ${S.border};border-radius:6px;">
  <p style="margin:6px 0 0;font-size:10px;color:${S.muted};">蓝线 DeepSeek 仓 · 橙线 Gemini 仓</p>
</td></tr>

${report.books.map((b) => `${statCard(b)}
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">${roundTripTable(b)}</td></tr>`).join("")}

${report.books.map(reviewCard).join("")}

<tr><td style="padding:16px 24px;background:${S.accent};border-radius:0 0 8px 8px;text-align:center;">
  <p style="margin:0;font-size:11px;color:#e0f2fe;">月度策略复盘 · Powered by Richfolio</p>
</td></tr>

</table>
</body>
</html>`;
}

export async function sendMonthlyReport(report: MonthlyReport): Promise<void> {
  const html = buildMonthlyReportHtml(report);
  const summary = report.books
    .map((b) => `${b.label}仓 ${b.stats.pnl != null ? (b.stats.pnl >= 0 ? "+" : "") + b.stats.pnlPct!.toFixed(1) + "%" : "进行中"}`)
    .join(" · ");

  const { error } = await resend.emails.send({
    from: "Richfolio <onboarding@resend.dev>",
    to: recipientEmail,
    subject: `Richfolio 月度复盘 ${report.month} — ${summary}`,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Monthly report email sent to ${recipientEmail}`);
}
