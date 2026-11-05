// ── Long-term stock label database (半年刷新) ────────────────────────
// 长期底色标签 — 白马 / 成长 / 价值 / 周期 / 防御 / 绩差ST / 僵尸冷门 —
// describe what a stock IS, not what it is doing today, so they are computed
// once and persisted to state/stock-labels.json with a half-year TTL. A ticker
// that appears in the report is looked up once, written to the DB, and every
// later run (daily ×100 tickers) just reads the cache until it expires.
//
// 庄股 (控盘型) is deliberately NOT auto-labelled: it needs intraday
// rigidity/tape evidence that daily bars cannot prove, and a wrong accusation
// is worse than silence. It stays an AI-reason observation.
//
// Rules use only data already flowing through the pipeline:
//   quote (Yahoo fundamentals) + board info (Eastmoney industry/amount).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { QuoteData } from "./fetchPrices.js";
import type { BoardInfo } from "./fetchBoards.js";

export interface StockLabelEntry {
  labels: string[];
  updatedAt: string;
}

const STATE_DIR = resolve(process.cwd(), "state");
const LABEL_DB_FILE = resolve(STATE_DIR, "stock-labels.json");
/** Half a year — user requirement: 长期标签每半年更新一次. */
const REFRESH_MS = 183 * 24 * 60 * 60 * 1000;

export const LONG_TERM_LABELS = [
  "白马",
  "成长",
  "价值",
  "周期",
  "防御",
  "绩差",
  "僵尸冷门",
] as const;
export type LongTermLabel = (typeof LONG_TERM_LABELS)[number];

/** Big-cycle industries whose fate follows commodities / sector景气. */
const CYCLE_INDUSTRY_RE =
  /(煤炭|钢铁|钢材|有色|金属|黄金|白银|稀土|铜|铝|锂|化工|化学|石油|油气|石化|航运|港口|船舶|工程机械|建材|水泥|玻璃|造纸|化纤|纺织|农业|养殖|猪|糖|橡胶)/;
/** Rigid-demand / high-dividend industries that shrug off downturns. */
const DEFENSIVE_INDUSTRY_RE =
  /(电力|水电|公用事业|燃气|水务|高速|公路|铁路|机场|银行|保险|食品|乳业|调味|医药|中药|游戏|出版)/;

function loadLabelDb(): Record<string, StockLabelEntry> {
  try {
    if (!existsSync(LABEL_DB_FILE)) return {};
    return JSON.parse(readFileSync(LABEL_DB_FILE, "utf8")) as Record<
      string,
      StockLabelEntry
    >;
  } catch {
    // Corrupt DB is treated as empty — labels get recomputed, not crashed on.
    return {};
  }
}

function saveLabelDb(db: Record<string, StockLabelEntry>): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LABEL_DB_FILE, JSON.stringify(db, null, 2));
}

/**
 * Compute the long-term labels for one ticker from fundamentals + industry.
 * Multiple labels can coexist (周期 + 价值, 白马 + 成长…).
 */
export function computeLongTermLabels(
  quote: QuoteData | undefined,
  board: BoardInfo | undefined,
): LongTermLabel[] {
  if (!quote) return [];
  const labels: LongTermLabel[] = [];
  const cap = quote.marketCap ?? 0;
  const roe = quote.returnOnEquity ?? 0;
  const pe = quote.trailingPE ?? null;
  const dy = quote.dividendYield ?? 0;
  const name = `${quote.name ?? ""}${quote.longName ?? ""}`.toUpperCase();

  // ST / loss-making: name carries the risk badge, or negative P/E (亏损).
  if (name.includes("ST") || (pe != null && pe <= 0)) labels.push("绩差");
  // 白马 — same bar as the email heuristic: big, profitable, sanely valued.
  if (cap >= 5e10 && roe >= 0.1 && pe != null && pe > 0 && pe <= 60) labels.push("白马");
  // 成长 — sustained expansion on BOTH top and bottom line. Yahoo's numbers
  // are quarterly YoY, which spikes across a whole sector during a boom
  // (PCB/AI in particular), so a revenue-only bar stamped 成长 on half the
  // watch list. Requiring earnings to confirm keeps one hot quarter from
  // earning a "long-term" label; missing either side → no label.
  const revG = quote.revenueGrowth;
  const earG = quote.earningsGrowth;
  if (revG != null && earG != null && revG >= 0.15 && earG >= 0.2) {
    labels.push("成长");
  }
  // 价值 — cheap for what it pays you back in dividends.
  if (pe != null && pe > 0 && pe <= 15 && dy >= 0.03) labels.push("价值");
  // 周期 — industry rides commodities / sector cycles.
  const industry = board?.industry ?? "";
  if (CYCLE_INDUSTRY_RE.test(industry)) labels.push("周期");
  // 防御 — rigid demand or a fat dividend with sub-market beta.
  if (
    DEFENSIVE_INDUSTRY_RE.test(industry) ||
    (dy >= 0.04 && quote.beta != null && quote.beta < 1)
  ) {
    labels.push("防御");
  }
  // 僵尸冷门 — barely trades: daily turnover under ¥30M.
  if (board?.amount != null && board.amount < 3e7) labels.push("僵尸冷门");

  return labels;
}

/**
 * Label lookup with the half-year cache. Fresh entries are returned as-is;
 * missing/expired ones are recomputed from the current run's data and written
 * back. Tickers without quote data keep whatever the DB already says.
 */
export function getLongTermLabels(
  tickers: string[],
  quotes: Record<string, QuoteData>,
  boards: Record<string, BoardInfo>,
  now: number = Date.now(),
): Record<string, string[]> {
  const db = loadLabelDb();
  let dirty = false;
  const out: Record<string, string[]> = {};

  for (const ticker of tickers) {
    const entry = db[ticker];
    const fresh =
      entry != null && now - Date.parse(entry.updatedAt) < REFRESH_MS;
    if (fresh && entry) {
      out[ticker] = entry.labels;
      continue;
    }
    const quote = quotes[ticker];
    if (!quote) {
      // Nothing to compute from — keep the stale labels rather than dropping.
      out[ticker] = entry?.labels ?? [];
      continue;
    }
    const labels = computeLongTermLabels(quote, boards[ticker]);
    db[ticker] = { labels, updatedAt: new Date(now).toISOString() };
    dirty = true;
    out[ticker] = labels;
  }

  if (dirty) saveLabelDb(db);
  if (Object.keys(out).length > 0) {
    const total = Object.values(out).reduce((n, l) => n + l.length, 0);
    console.log(`  Long-term labels: ${total} tag(s) across ${Object.keys(out).length} ticker(s)`);
  }
  return out;
}
