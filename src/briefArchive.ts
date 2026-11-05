// ── 每晚简报存档（brief archive）────────────────────────────────────
// Every evening run snapshots the FULL brief context — sentiment, funds,
// themes, hot news flashes, consensus + per-provider AI votes, both paper
// books' state — into state/brief-archive/<YYYY-MM-DD>.json.
//
// Why: the weekly review asks each AI (DeepSeek / Gemini) to explain its own
// wins and losses and to critique the brief itself. For that critique to be
// grounded, the AI needs to see what the brief actually showed that day, not
// just its own tickers. The archive is that memory.
//
// Retention: kept ~30 days (weekly review only ever needs 7); prune on save.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { AIBuyRecommendation } from "./providers/types.js";
import type { MarketSentiment } from "./marketSentiment.js";
import type { NewsItem } from "./fetchNews.js";
import type { PaperSummary, ExecutedTrade } from "./paperTrading.js";

const ARCHIVE_DIR = resolve("state/brief-archive");
const MAX_ARCHIVE_DAYS = 30;

export interface BriefArchive {
  date: string;
  sentiment: MarketSentiment | null;
  hotNews: Array<{ title: string; source: string; publishedAt: string }>;
  aiRecs: AIBuyRecommendation[];
  books: Record<string, { paper: PaperSummary; trades: ExecutedTrade[] }>;
}

export function saveBriefArchive(archive: BriefArchive): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(
    resolve(ARCHIVE_DIR, `${archive.date}.json`),
    JSON.stringify(archive, null, 2),
  );
  pruneArchive();
}

export function loadBriefArchive(date: string): BriefArchive | null {
  const file = resolve(ARCHIVE_DIR, `${date}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as BriefArchive;
  } catch {
    return null;
  }
}

export function loadBriefArchives(dates: string[]): BriefArchive[] {
  return dates.map(loadBriefArchive).filter((a): a is BriefArchive => a != null);
}

function pruneArchive(): void {
  let files: string[] = [];
  try {
    files = readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  for (const f of files.slice(0, Math.max(0, files.length - MAX_ARCHIVE_DAYS))) {
    try {
      unlinkSync(resolve(ARCHIVE_DIR, f));
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Compact per-day market context for the weekly diagnosis prompts — a few
 * lines per day so two provider calls stay inside token budgets.
 */
export function archiveContextBlock(archives: BriefArchive[]): string {
  return archives
    .map((a) => {
      const m = a.sentiment?.metrics;
      const lines: string[] = [`■ ${a.date}`];
      if (a.sentiment && m) {
        lines.push(
          `  情绪:${a.sentiment.phase}(命中${a.sentiment.matches}/6) 涨停${m.ztCount}家 最高${m.maxLbc}板 晋级${(m.promoteRate * 100).toFixed(0)}%`,
        );
        lines.push(`  仓位建议:${a.sentiment.positionHint}`);
        if (a.sentiment.funds) {
          lines.push(
            `  资金:成交${a.sentiment.funds.totalAmount}亿(${a.sentiment.funds.volumeState}) 主力${a.sentiment.funds.mainNet >= 0 ? "+" : ""}${a.sentiment.funds.mainNet}亿`,
          );
        }
        const themes = a.sentiment.concepts
          .slice(0, 3)
          .map((c) => `${c.name}[${c.phase}]`)
          .join("、");
        if (themes) lines.push(`  题材:${themes}`);
        if (a.sentiment.leaderAlert) lines.push(`  龙头:${a.sentiment.leaderAlert}`);
      } else {
        lines.push("  情绪:数据缺失");
      }
      const news = a.hotNews.slice(0, 3).map((n) => n.title.slice(0, 40));
      if (news.length > 0) lines.push(`  热点:${news.join(" / ")}`);
      const recs = a.aiRecs
        .filter((r) => r.action === "BUY" || r.action === "STRONG BUY")
        .slice(0, 4)
        .map((r) => `${r.ticker}:${r.action}(${r.confidence}%)`);
      if (recs.length > 0) lines.push(`  共识推荐:${recs.join("、")}`);
      for (const [book, b] of Object.entries(a.books)) {
        lines.push(
          `  ${book}仓:仓位${b.paper.positionPct.toFixed(0)}% 今${b.paper.pnlDayPct == null ? "—" : (b.paper.pnlDayPct >= 0 ? "+" : "") + b.paper.pnlDayPct.toFixed(2) + "%"} 本月${b.paper.pnlMonthPct >= 0 ? "+" : ""}${b.paper.pnlMonthPct.toFixed(2)}% 操作:${b.trades.length > 0 ? b.trades.map((t) => `${t.action === "BUY" ? "买" : "卖"}${t.ticker}`).join(",") : "无"}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}
