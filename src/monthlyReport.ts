// ── Monthly report ──────────────────────────────────────────────────
// Run on the 1st at 23:00 北京时间 (after that evening's daily reset has
// archived the finished month into monthly_history). For each book:
//   1. equity curve chart (QuickChart PNG — renders in email as <img>)
//   2. round trips: what was bought, what it made/lost
//   3. AI self-review grounded in the month's brief archives:
//      操作特点 / 本月市场态势 / 自我评价 / 下一步改进方向
//
// The chart is a QuickChart.io URL because email clients strip inline SVG
// and a server-rendered PNG needs no extra dependency. If QuickChart is
// unreachable the email still renders — the <img> just shows broken, and
// the stat tables carry the same numbers.

import {
  BOOK_IDS,
  BOOK_LABELS,
  type BookId,
  monthlyStats,
  type MonthStats,
  MONTHLY_CAPITAL,
} from "./paperTrading.js";
import { loadBriefArchives, archiveContextBlock } from "./briefArchive.js";
import { askProviderText, REVIEW_PROVIDER_LABELS } from "./aiText.js";

export interface BookMonthlyReport {
  id: BookId;
  label: string;
  stats: MonthStats;
  /** AI-written self-review, may be empty on API failure. */
  review: string;
}

export interface MonthlyReport {
  month: string;
  generatedAt: string;
  books: BookMonthlyReport[];
  chartUrl: string;
  marketBlock: string;
}

/** Net-value chart via QuickChart: both books on one line chart. */
export function buildChartUrl(month: string, curves: Record<string, Array<{ date: string; total: number }>>): string {
  const dates = [...new Set(Object.values(curves).flatMap((c) => c.map((p) => p.date)))].sort();
  const colors: Record<string, string> = { deepseek: "#3b82f6", gemini: "#f59e0b" };
  const chart = {
    type: "line",
    data: {
      labels: dates.map((d) => d.slice(5)),
      datasets: Object.entries(curves).map(([id, curve]) => ({
        label: `${BOOK_LABELS[id as BookId] ?? id}仓`,
        data: dates.map((d) => curve.find((p) => p.date === d)?.total ?? null),
        borderColor: colors[id] ?? "#64748b",
        backgroundColor: "rgba(0,0,0,0)",
        borderWidth: 2,
        pointRadius: 2,
        spanGaps: true,
        fill: false,
        tension: 0.2,
      })),
    },
    options: {
      title: { display: true, text: `${month} 双 AI 模拟盘净值（初始 ¥${MONTHLY_CAPITAL.toLocaleString("en-US")}）`, fontSize: 14 },
      legend: { position: "bottom" },
      scales: {
        yAxes: [{ ticks: { callback: (v: string) => `¥${Number(v).toLocaleString("en-US")}` } }],
      },
    },
  };
  return `https://quickchart.io/chart?w=640&h=320&bkg=ffffff&c=${encodeURIComponent(JSON.stringify(chart))}`;
}

const fmtMoney = (n: number): string => `¥${Math.round(n).toLocaleString("en-US")}`;

/** Stats + round trips + ops characteristics block fed to the AI. */
function statsBlock(label: string, s: MonthStats): string {
  const lines: string[] = [
    `〔${label}仓 ${s.month} 月度数据〕`,
    `初始资金:${fmtMoney(s.startCapital)} 期末:${s.endTotal != null ? fmtMoney(s.endTotal) + `(盈亏${s.pnl! >= 0 ? "+" : ""}${fmtMoney(s.pnl!)} / ${s.pnlPct!.toFixed(2)}%)` : "进行中"}`,
    `峰值:${s.peak != null ? fmtMoney(s.peak) : "—"} 谷值:${s.trough != null ? fmtMoney(s.trough) : "—"} 最大回撤:${s.maxDrawdownPct != null ? s.maxDrawdownPct.toFixed(2) + "%" : "—"} 空仓天:${s.flatDays}`,
    `交易统计:买入${s.buyCount}笔 卖出${s.sellCount}笔 有买入的天数${s.daysTraded} 平均持仓${s.avgHoldDays != null ? s.avgHoldDays + "个交易日" : "—"}`,
    `已平仓胜负:赢${s.winCount} / 亏${s.lossCount}${s.winCount + s.lossCount > 0 ? `（胜率${Math.round((s.winCount / (s.winCount + s.lossCount)) * 100)}%）` : ""}`,
    `当月个股（按盈亏排序，亏在前）:`,
  ];
  if (s.roundTrips.length === 0) lines.push("  （本月无交易）");
  for (const r of s.roundTrips.slice(0, 25)) {
    lines.push(
      `  ${r.name}(${r.ticker}) 买${fmtMoney(r.buyAmount)}/${r.boughtShares}股 卖${fmtMoney(r.sellAmount)}/${r.soldShares}股 ` +
        `${r.status}${r.realized != null ? ` 已实现盈亏${r.realized >= 0 ? "+" : ""}${fmtMoney(r.realized)}` : ""}${r.holdDays != null ? ` 持仓${r.holdDays}交易日` : ""}`,
    );
  }
  return lines.join("\n");
}

function buildSelfReviewPrompt(label: string, s: MonthStats, marketBlock: string): string {
  return `你是${label}，一名短线选手（最长持仓 5 个交易日，周末不计），下面是你在 ${s.month} 月模拟盘（初始资金 ${fmtMoney(MONTHLY_CAPITAL)}）的完整表现数据，以及当月每日简报的市场背景存档（情绪周期/资金面/题材/两仓操作）。

${statsBlock(label, s)}

〔当月市场背景存档（按日）〕
${marketBlock || "（当月无存档）"}

请输出简体中文，必须分四段，用这四个小节标题：
【操作特点】归纳你这个月的操作风格：出手频率、持仓周期、加减仓习惯、买卖的是哪类票（结合上面的个股清单）；
【本月市场态势】结合存档里的情绪/资金/题材，按时间线概括这个月市场怎么走的，你的操作如何跟随或脱节；
【自我评价】坦诚评价：哪些判断对了、哪些错了、纪律执行得如何（5日强平、退潮清仓、盘中减仓等），给这个月的表现打个分（0-100）并说明理由；
【下一步改进方向】3-5 条具体可执行的改进规则（例如"晋级率<40% 时不给 BUY"、"首板不打、只做2板以上"这类可写进规则的表述）。
不要空话套话，引用具体数据。`;
}

export async function buildMonthlyReport(month: string): Promise<MonthlyReport> {
  const books: BookMonthlyReport[] = [];
  const curves: Record<string, Array<{ date: string; total: number }>> = {};

  // 当月简报存档 → 市场背景块（截断防 prompt 超长）。
  const dates = [...new Set(BOOK_IDS.flatMap((id) => monthlyStats(id, month).equityCurve.map((p) => p.date)))]
    .concat(loadArchivedDates(month));
  const uniqueDates = [...new Set(dates)].sort();
  const archives = loadBriefArchives(uniqueDates);
  const marketBlock = archiveContextBlock(archives)
    .split("\n■")
    .slice(-25)
    .join("\n■");

  for (const id of BOOK_IDS) {
    const stats = monthlyStats(id, month);
    curves[id] = stats.equityCurve;
    const review =
      stats.roundTrips.length > 0 || stats.trades.length > 0
        ? await askProviderText(id, buildSelfReviewPrompt(REVIEW_PROVIDER_LABELS[id], stats, marketBlock))
        : "";
    books.push({ id, label: BOOK_LABELS[id], stats, review });
    console.log(`Monthly report [${id}]: ${stats.roundTrips.length} round trips, review ${review ? "ok" : "empty"}`);
  }

  return {
    month,
    generatedAt: new Date().toISOString(),
    books,
    chartUrl: buildChartUrl(month, curves),
    marketBlock,
  };
}

function loadArchivedDates(month: string): string[] {
  // loadBriefArchives handles missing files gracefully; feed it the full month
  // so the market block covers trading days even if a book never traded.
  const days: string[] = [];
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    days.push(`${month}-${String(d).padStart(2, "0")}`);
  }
  return days;
}
