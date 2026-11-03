import { Resend } from "resend";
import { recipientEmail, defaultCurrency } from "./config.js";
import type { AllocationItem, AllocationReport } from "./analyze.js";
import { escapeHtmlAttr, formatMoney } from "./util.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Styles (same dark theme as daily email) ─────────────────────────
const S = {
  bg: "#1a1a2e",
  cardBg: "#16213e",
  text: "#e0e0e0",
  muted: "#8a8a9a",
  accent: "#0f3460",
  green: "#2ecc71",
  red: "#e74c3c",
  yellow: "#f39c12",
  blue: "#3498db",
  border: "#2a2a4a",
} as const;

// ── Helpers ─────────────────────────────────────────────────────────
const fmt$ = (n: number) => formatMoney(n, defaultCurrency);

function fmtPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function actionLabel(gap: number): { text: string; color: string } {
  if (gap > 1) return { text: "买入", color: S.red };
  if (gap < -1) return { text: "减持", color: S.yellow };
  return { text: "达标", color: S.green };
}

// ── Build HTML ──────────────────────────────────────────────────────
export function buildWeeklyEmailHtml(report: AllocationReport): string {
  const date = new Date().toLocaleDateString("zh-CN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Cross-currency footnote must consider held-only holdings too — they're real
  // positions, just untracked, so a GBp/ZAc one still needs the FX note.
  const hasCrossCurrency = [...report.items, ...report.untrackedItems].some(
    (i) => i.originalCurrency !== defaultCurrency,
  );
  const onTarget = report.items.filter((i) => Math.abs(i.gapPct) <= 1 && i.targetPct > 0);
  const underweight = report.items.filter((i) => i.gapPct > 1);
  const overweight = report.items.filter((i) => i.gapPct < -1 && i.targetPct > 0);
  // Held-only tickers, shown as a neutral list. They come from untrackedItems
  // now, which keeps them out of the action table entirely — with an implied 0%
  // target their gap is always negative, so they used to draw a standing TRIM
  // that Richfolio (buy-only, no sell logic) can't actually justify.
  const noTarget = report.untrackedItems.filter((i) => i.currentValue > 0);

  // Rebalancing action table: tracked allocation items only.
  const sorted = [...report.items].sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${S.text};font-size:14px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;">

<!-- Header -->
<tr><td style="padding:20px 24px;background:${S.accent};border-radius:8px 8px 0 0;">
  <h1 style="margin:0;font-size:22px;color:#fff;">每周再平衡报告</h1>
  <p style="margin:6px 0 0;color:${S.muted};font-size:13px;">${date}</p>
</td></tr>

<!-- Portfolio Stats -->
<tr><td style="padding:16px 24px;background:${S.cardBg};border-bottom:1px solid ${S.border};">
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">持仓市值（${defaultCurrency}）</div>
      <div style="font-size:20px;font-weight:bold;color:#fff;">${fmt$(report.totalCurrentValue)}</div>
    </td>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">组合 Beta</div>
      <div style="font-size:20px;font-weight:bold;color:#fff;">${report.portfolioBeta?.toFixed(2) ?? "—"}</div>
    </td>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">达标数量</div>
      <div style="font-size:20px;font-weight:bold;color:${S.green};">${onTarget.length}/${report.items.filter((i) => i.targetPct > 0).length}</div>
    </td>
    <td style="text-align:center;padding:8px;">
      <div style="font-size:11px;color:${S.muted};text-transform:uppercase;">预估年股息</div>
      <div style="font-size:20px;font-weight:bold;color:#fff;">${fmt$(report.estimatedAnnualDividend)}</div>
    </td>
  </tr></table>
</td></tr>

<!-- Rebalancing Actions -->
<tr><td style="padding:20px 24px 8px;background:${S.cardBg};">
  <h2 style="margin:0;font-size:16px;color:${S.blue};">再平衡操作</h2>
  <p style="margin:4px 0 0;font-size:11px;color:${S.muted};">按偏离目标的幅度排序。偏离 ±1% 以内视为达标。</p>
</td></tr>
<tr><td style="padding:0 24px 16px;background:${S.cardBg};">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;">
    <tr style="color:${S.muted};font-size:10px;text-transform:uppercase;">
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};">代码</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:center;">操作</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">当前</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">目标</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">缺口</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">金额</td>
    </tr>
    ${sorted
      .filter((i) => i.targetPct > 0 || i.currentValue > 0)
      .map((item) => {
        const action = actionLabel(item.gapPct);
        return `
    <tr>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};font-weight:bold;" title="${escapeHtmlAttr(item.tickerFullName ?? item.ticker)}">${item.ticker}</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:center;">
        <span style="background:${action.color};color:#000;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;">${action.text}</span>
      </td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${item.currentPct.toFixed(1)}%</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${item.targetPct.toFixed(1)}%</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;color:${action.color};">${fmtPct(item.gapPct)}</td>
      <td style="padding:5px 3px;border-bottom:1px solid ${S.border};text-align:right;">${item.suggestedBuyValue > 0 ? `买入 ${fmt$(item.suggestedBuyValue)}${item.overlapDiscount > 0 ? `<div style="font-size:10px;color:${S.muted};">-${fmt$(item.overlapDiscount)} 重合扣减</div>` : ""}` : "—"}</td>
    </tr>`;
      })
      .join("")}
  </table>
</td></tr>

${
  overweight.length > 0
    ? `
<!-- Overweight Warning -->
<tr><td style="padding:16px 24px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h3 style="margin:0;font-size:14px;color:${S.yellow};">⚠ 超配持仓</h3>
  <p style="margin:4px 0 0;font-size:12px;color:${S.text};">
    ${overweight.map((i) => `<b>${i.ticker}</b>（当前 ${i.currentPct.toFixed(1)}% vs 目标 ${i.targetPct.toFixed(1)}%）`).join("，")}
  </p>
</td></tr>`
    : ""
}

${
  noTarget.length > 0
    ? `
<!-- No-target holdings -->
<tr><td style="padding:16px 24px;background:${S.cardBg};border-top:1px solid ${S.border};">
  <h3 style="margin:0;font-size:14px;color:${S.muted};">未纳入目标组合的持仓</h3>
  <p style="margin:4px 0 0;font-size:12px;color:${S.text};">
    ${noTarget.map((i) => `<b>${i.ticker}</b> (${fmt$(i.currentValue)}, ${i.currentPct.toFixed(1)}%)`).join(", ")}
  </p>
</td></tr>`
    : ""
}

${
  hasCrossCurrency
    ? `<tr><td style="padding:10px 24px;background:${S.cardBg};border-top:1px solid ${S.border};font-size:11px;color:${S.muted};">
  金额以 ${defaultCurrency} 显示 — 检测到多币种组合。
</td></tr>`
    : ""
}

<!-- Footer -->
<tr><td style="padding:16px 24px;background:${S.accent};border-radius:0 0 8px 8px;text-align:center;">
  <p style="margin:0;font-size:11px;color:${S.muted};">
    修改 CONFIG_JSON 变量可更新你的投资组合 · Powered by Richfolio
  </p>
</td></tr>

</table>
</body>
</html>`;
}

// ── Send weekly email ───────────────────────────────────────────────
export async function sendWeeklyBrief(report: AllocationReport): Promise<void> {
  const html = buildWeeklyEmailHtml(report);

  const { error } = await resend.emails.send({
    from: "Richfolio <onboarding@resend.dev>",
    to: recipientEmail,
    subject: `Richfolio 每周再平衡 — ${new Date().toLocaleDateString("zh-CN")}`,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Weekly email sent to ${recipientEmail}`);
}
