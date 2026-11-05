// ── 模拟盘（paper trading）──────────────────────────────────────────
// A-share-only simulated portfolio backed by a single-file SQLite database
// (node:sqlite, zero native deps). The AI's daily calls are executed at that
// day's close price; P&L is tracked per day and per month against a fixed
// monthly capital base (default ¥20,000, reset on the first run of each month).
//
// Rules (deliberately simple and explainable):
//   • Universe: .SS/.SZ tickers only — the fund is CNY and FX is out of scope.
//   • Trades execute once per trade date (daily_pnl row acts as the guard), so
//     a manual local run and the scheduled cloud run can never double-fill.
//   • Target position % comes from the sentiment 仓位建议 (midpoint of the
//     range); 退潮 phase forces flat.
//   • SELL: TRIM halves a position; forced-flat liquidates everything.
//   • BUY: top candidates by confidence, max 3/day, rounded to 100-share lots
//     (A-share board lot), never exceeding cash.
//   • No fees/slippage — this is a signal-quality scoreboard, not a broker sim.
//
// Persistence: the DB file lives in data/ and IS committed back to git by the
// daily workflow step, which is how the balance survives across ephemeral
// GitHub Actions runners. Local runs share the same file and stay consistent
// as long as both sides pull before running.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { displayName } from "./config.js";
import type { AIBuyRecommendation } from "./aiAnalysis.js";
import type { MarketSentiment } from "./marketSentiment.js";

// ── Books ───────────────────────────────────────────────────────────
// Two independent books, one per AI provider: each gets its own SQLite file,
// its own ¥20,000 monthly capital and its own fills from that provider's
// votes only — DeepSeek and Gemini never see or influence each other's book.
export const BOOK_IDS = ["deepseek", "gemini"] as const;
export type BookId = (typeof BOOK_IDS)[number];
export const BOOK_LABELS: Record<BookId, string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
};

function dbPathFor(book: BookId): string {
  const dir = process.env.PAPER_TRADING_DB_DIR ?? "data";
  return resolve(dir, `paper-trading-${book}.db`);
}

export const MONTHLY_CAPITAL = Number(process.env.PAPER_MONTHLY_CAPITAL ?? 20_000);
const MAX_BUYS_PER_DAY = 3;
const MIN_BUDGET = 500; // below this even one 100-share lot of a ¥5 stock won't fit
const LOT = 100; // A-share board lot

export interface ExecutedTrade {
  action: "BUY" | "SELL";
  ticker: string;
  name: string;
  shares: number;
  price: number;
  amount: number;
  reason: string;
}

export interface PaperSummary {
  month: string;
  cash: number;
  marketValue: number;
  total: number;
  positionPct: number;
  holdings: Array<{ ticker: string; name: string; shares: number; price: number; pnlPct: number }>;
  pnlDay: number | null;
  pnlDayPct: number | null;
  pnlMonth: number;
  pnlMonthPct: number;
}

// ── DB bootstrap ────────────────────────────────────────────────────

const _dbs = new Map<BookId, DatabaseSync>();

function getDb(book: BookId): DatabaseSync {
  const cached = _dbs.get(book);
  if (cached) return cached;
  const file = dbPathFor(book);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cash REAL NOT NULL,
      month TEXT NOT NULL,
      month_start REAL NOT NULL,
      init_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      ticker TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      shares INTEGER NOT NULL,
      avg_cost REAL NOT NULL,
      entry_date TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      ts TEXT NOT NULL,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      shares INTEGER NOT NULL,
      price REAL NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      confidence INTEGER
    );
    CREATE TABLE IF NOT EXISTS daily_pnl (
      trade_date TEXT PRIMARY KEY,
      cash REAL NOT NULL,
      market_value REAL NOT NULL,
      total REAL NOT NULL,
      pnl_day REAL,
      pnl_total REAL NOT NULL,
      pnl_pct REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_days (
      trade_date TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS monthly_history (
      month TEXT PRIMARY KEY,
      start_capital REAL NOT NULL,
      end_total REAL,
      pnl REAL,
      pnl_pct REAL
    );
  `);
  // Migration for DBs created before the 5-trading-day rule: add entry_date
  // and backfill it from each position's first BUY trade.
  try {
    db.exec("ALTER TABLE positions ADD COLUMN entry_date TEXT");
    db.exec(`
      UPDATE positions SET entry_date = (
        SELECT t.trade_date FROM trades t
        WHERE t.ticker = positions.ticker AND t.action = 'BUY'
        ORDER BY t.id LIMIT 1
      ) WHERE entry_date IS NULL
    `);
  } catch {
    /* column already exists */
  }
  _dbs.set(book, db);
  return db;
}

/**
 * Weekdays (Mon–Fri) from `entryDate` to `date`, both inclusive. Weekends
 * don't count toward the 5-trading-day holding cap, per the operating premise.
 */
export function tradingDaysBetween(entryDate: string | null, date: string): number {
  if (!entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || entryDate > date) return 0;
  const start = new Date(`${entryDate}T00:00:00Z`);
  const end = new Date(`${date}T00:00:00Z`);
  let days = 0;
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}

const MAX_HOLD_TRADING_DAYS = 5;

/** Beijing-local YYYY-MM-DD — A-share trades are dated in market time. */
export function beijingDate(d: Date = new Date()): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

const monthOf = (date: string): string => date.slice(0, 7);

// ── Account / monthly reset ─────────────────────────────────────────

function ensureAccount(db: DatabaseSync, date: string): void {
  const row = db.prepare("SELECT * FROM account WHERE id = 1").get() as
    | { cash: number; month: string; month_start: number }
    | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO account (id, cash, month, month_start, init_date) VALUES (1, ?, ?, ?, ?)",
    ).run(MONTHLY_CAPITAL, monthOf(date), MONTHLY_CAPITAL, date);
  }
}

/** True when the stored month ≠ today's month → liquidate & re-fund. */
function needsMonthlyReset(db: DatabaseSync, date: string): boolean {
  const row = db.prepare("SELECT month FROM account WHERE id = 1").get() as
    | { month: string }
    | undefined;
  return row != null && row.month !== monthOf(date);
}

function closeAllPositions(
  db: DatabaseSync,
  date: string,
  prices: Record<string, number>,
  reason: string,
): ExecutedTrade[] {
  const rows = db.prepare("SELECT * FROM positions").all() as Array<{
    ticker: string; name: string; shares: number; avg_cost: number;
  }>;
  const out: ExecutedTrade[] = [];
  for (const p of rows) {
    const price = prices[p.ticker];
    if (price == null) continue; // no quote today — cannot fill, keep position
    db.prepare("DELETE FROM positions WHERE ticker = ?").run(p.ticker);
    const amount = p.shares * price;
    db.prepare(
      "INSERT INTO trades (trade_date, ts, ticker, name, action, shares, price, amount, reason) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(date, new Date().toISOString(), p.ticker, p.name, "SELL", p.shares, price, amount, reason);
    db.prepare("UPDATE account SET cash = cash + ? WHERE id = 1").run(amount);
    out.push({ action: "SELL", ticker: p.ticker, name: p.name, shares: p.shares, price, amount, reason });
  }
  return out;
}

function resetMonth(
  db: DatabaseSync,
  date: string,
  prices: Record<string, number>,
): ExecutedTrade[] {
  const acc = db.prepare("SELECT * FROM account WHERE id = 1").get() as {
    cash: number; month: string; month_start: number;
  };
  const positions = db.prepare("SELECT * FROM positions").all() as Array<{ ticker: string }>;
  let marketValue = 0;
  for (const p of positions) {
    const price = prices[p.ticker];
    if (price != null) {
      const row = db.prepare("SELECT shares FROM positions WHERE ticker = ?").get(p.ticker) as { shares: number };
      marketValue += row.shares * price;
    }
  }
  const endTotal = acc.cash + marketValue;
  db.prepare(
    "INSERT INTO monthly_history (month, start_capital, end_total, pnl, pnl_pct) VALUES (?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET end_total=excluded.end_total, pnl=excluded.pnl, pnl_pct=excluded.pnl_pct",
  ).run(acc.month, acc.month_start, endTotal, endTotal - acc.month_start, ((endTotal - acc.month_start) / acc.month_start) * 100);
  const closed = closeAllPositions(db, date, prices, "月末清仓（每月重置）");
  db.prepare("UPDATE account SET cash = ?, month = ?, month_start = ? WHERE id = 1").run(
    MONTHLY_CAPITAL, monthOf(date), MONTHLY_CAPITAL,
  );
  return closed;
}

// ── Position sizing ─────────────────────────────────────────────────

/**
 * Target total position % from the sentiment 仓位建议 line.
 * "20%–30%：…" → 25; "≤10%…" → 10; unparsable → 20 (a sane default).
 */
export function parseTargetPositionPct(positionHint: string | null): number {
  if (!positionHint) return 20;
  const range = positionHint.match(/(\d+(?:\.\d+)?)\s*[%]?\s*[–~\-]\s*(\d+(?:\.\d+)?)\s*%/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const cap = positionHint.match(/(?:≤|不超过|低于)\s*(\d+(?:\.\d+)?)\s*%/);
  if (cap) return Number(cap[1]);
  const single = positionHint.match(/(\d+(?:\.\d+)?)\s*%/);
  return single ? Number(single[1]) : 20;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function isAshare(ticker: string): boolean {
  return /\.(SS|SZ)$/i.test(ticker);
}

// ── Sell-side decisions (shared by evening fill & intraday flatten) ─

/**
 * 退潮 forced flat → 5-trading-day cap → AI TRIM. Appends executed SELLs to
 * `trades` and returns the tickers sold (buy side may not re-buy them).
 * `sessionTag` marks the reason so intraday fills are distinguishable in the
 * trade log ("" for the 22:00 close fill).
 */
function runSellSide(
  db: DatabaseSync,
  date: string,
  input: {
    prices: Record<string, number>;
    aiRecs: AIBuyRecommendation[];
    sentiment: MarketSentiment | null;
  },
  trades: ExecutedTrade[],
  sessionTag: string,
): Set<string> {
  const positions = () =>
    db.prepare("SELECT * FROM positions").all() as Array<{
      ticker: string; name: string; shares: number; avg_cost: number; entry_date: string | null;
    }>;
  const price = (t: string): number | undefined => input.prices[t];
  const soldToday = new Set<string>();

  const targetPct = input.sentiment?.phase === "退潮" ? 0 : parseTargetPositionPct(input.sentiment?.positionHint ?? null);
  if (targetPct === 0 && positions().length > 0) {
    trades.push(...closeAllPositions(db, date, input.prices, `退潮期清仓（情绪建议仓位≈0%）${sessionTag}`.trimEnd()));
    for (const t of trades) soldToday.add(t.ticker);
    return soldToday;
  }

  for (const p of positions()) {
    // 短线纪律：持仓超过 5 个交易日（周末不计）强制卖出，AI 说了也不算。
    const heldDays = tradingDaysBetween(p.entry_date, date);
    if (heldDays > MAX_HOLD_TRADING_DAYS) {
      const px = price(p.ticker);
      if (px != null) {
        db.prepare("DELETE FROM positions WHERE ticker = ?").run(p.ticker);
        const amount = p.shares * px;
        db.prepare("UPDATE account SET cash = cash + ? WHERE id = 1").run(amount);
        db.prepare(
          "INSERT INTO trades (trade_date, ts, ticker, name, action, shares, price, amount, reason) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(date, new Date().toISOString(), p.ticker, p.name, "SELL", p.shares, px, amount, `持仓满${MAX_HOLD_TRADING_DAYS}个交易日强制卖出（短线纪律）${sessionTag}`.trimEnd());
        trades.push({ action: "SELL", ticker: p.ticker, name: p.name, shares: p.shares, price: px, amount, reason: `持仓满${MAX_HOLD_TRADING_DAYS}个交易日强制卖出` });
        soldToday.add(p.ticker);
        continue;
      }
    }
    const rec = input.aiRecs.find((r) => r.ticker === p.ticker);
    if (rec?.action !== "TRIM") continue;
    const px = price(p.ticker);
    if (px == null) continue;
    const sellShares = Math.max(Math.floor(p.shares / 2 / LOT) * LOT, 0) || Math.min(p.shares, LOT);
    const amount = sellShares * px;
    db.prepare("UPDATE positions SET shares = shares - ?, updated_at = ? WHERE ticker = ?").run(
      sellShares, new Date().toISOString(), p.ticker,
    );
    if (p.shares - sellShares <= 0) db.prepare("DELETE FROM positions WHERE ticker = ?").run(p.ticker);
    db.prepare("UPDATE account SET cash = cash + ? WHERE id = 1").run(amount);
    db.prepare(
      "INSERT INTO trades (trade_date, ts, ticker, name, action, shares, price, amount, reason, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(date, new Date().toISOString(), p.ticker, p.name, "SELL", sellShares, px, amount, `AI 建议 TRIM（${rec.confidence}%）${sessionTag}`.trimEnd(), rec.confidence);
    trades.push({ action: "SELL", ticker: p.ticker, name: p.name, shares: sellShares, price: px, amount, reason: `AI TRIM (${rec.confidence}%)` });
    soldToday.add(p.ticker);
  }
  return soldToday;
}

// ── Core: execute the day's AI calls ────────────────────────────────

/**
 * Execute one day's simulated trades at close prices. Idempotent per date via
 * the trade_days marker (NOT daily_pnl — intraday summaries upsert that table
 * and must never block the evening run from filling).
 */
export function executeDailyTrades(
  book: BookId,
  input: {
    date?: string;
    prices: Record<string, number>; // CNY close prices, A-share tickers only
    aiRecs: AIBuyRecommendation[];
    sentiment: MarketSentiment | null;
  },
): { skipped: boolean; trades: ExecutedTrade[] } {
  const db = getDb(book);
  const date = input.date ?? beijingDate();
  ensureAccount(db, date);
  const trades: ExecutedTrade[] = [];
  if (needsMonthlyReset(db, date)) trades.push(...resetMonth(db, date, input.prices));

  const alreadyTraded = db.prepare("SELECT trade_date FROM trade_days WHERE trade_date = ?").get(date);
  if (alreadyTraded) {
    const stored = db
      .prepare("SELECT * FROM trades WHERE trade_date = ? ORDER BY id")
      .all(date) as Array<{
      action: string; ticker: string; name: string; shares: number; price: number; amount: number; reason: string;
    }>;
    return {
      skipped: true,
      trades: stored.map((t) => ({
        action: t.action as "BUY" | "SELL",
        ticker: t.ticker,
        name: t.name,
        shares: t.shares,
        price: t.price,
        amount: t.amount,
        reason: t.reason,
      })),
    };
  }

  const cash = () => (db.prepare("SELECT cash FROM account WHERE id = 1").get() as { cash: number }).cash;
  const positions = () =>
    db.prepare("SELECT * FROM positions").all() as Array<{
      ticker: string; name: string; shares: number; avg_cost: number; entry_date: string | null;
    }>;

  const phase = input.sentiment?.phase ?? null;
  const targetPct = phase === "退潮" ? 0 : parseTargetPositionPct(input.sentiment?.positionHint ?? null);

  const price = (t: string): number | undefined => input.prices[t];
  const marketValue = () =>
    positions().reduce((sum, p) => sum + (price(p.ticker) != null ? p.shares * price(p.ticker)! : p.avg_cost * p.shares), 0);
  const totalAssets = () => cash() + marketValue();

  // ── SELL side: forced flat in 退潮, stale positions past the 5-trading-day
  //    cap, then AI TRIM halves. Sold tickers may not be re-bought today —
  //    sell-then-rebuy would churn the book against a stale signal set.
  const soldToday = runSellSide(db, date, input, trades, "");

  // ── BUY side: fill up to the sentiment target with top-confidence calls ──
  if (targetPct > 0) {
    const held = new Set(positions().map((p) => p.ticker));
    const candidates = input.aiRecs
      .filter((r) => isAshare(r.ticker) && (r.action === "BUY" || r.action === "STRONG BUY"))
      .filter((r) => !held.has(r.ticker) && !soldToday.has(r.ticker) && price(r.ticker) != null)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_BUYS_PER_DAY);

    const budget = Math.min(totalAssets() * (targetPct / 100) - marketValue(), cash());
    if (candidates.length > 0 && budget >= MIN_BUDGET) {
      const perBuy = budget / candidates.length;
      for (const r of candidates) {
        const px = price(r.ticker)!;
        let shares = Math.floor(Math.min(perBuy, cash()) / px / LOT) * LOT;
        if (shares < LOT) continue;
        const amount = shares * px;
        db.prepare(
          "INSERT INTO positions (ticker, name, shares, avg_cost, entry_date, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(ticker) DO UPDATE SET shares = shares + excluded.shares, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at",
        ).run(r.ticker, displayName(r.ticker, r.tickerFullName), shares, px, date, new Date().toISOString());
        db.prepare("UPDATE account SET cash = cash - ? WHERE id = 1").run(amount);
        db.prepare(
          "INSERT INTO trades (trade_date, ts, ticker, name, action, shares, price, amount, reason, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(date, new Date().toISOString(), r.ticker, displayName(r.ticker, r.tickerFullName), "BUY", shares, px, amount, `AI ${r.action}（${r.confidence}%）`, r.confidence);
        trades.push({
          action: "BUY",
          ticker: r.ticker,
          name: displayName(r.ticker, r.tickerFullName),
          shares,
          price: px,
          amount,
          reason: `AI ${r.action} (${r.confidence}%)`,
        });
      }
    }
  }

  // Mark the day as filled — even with zero trades — so re-runs can't
  // double-fill against a later signal set.
  db.prepare("INSERT INTO trade_days (trade_date) VALUES (?) ON CONFLICT(trade_date) DO NOTHING").run(date);
  return { skipped: false, trades };
}

// ── Snapshot & summary ──────────────────────────────────────────────

function holdingsPct(p: { shares: number; avg_cost: number }, price?: number): number {
  if (price == null || p.avg_cost <= 0) return 0;
  return round2(((price - p.avg_cost) / p.avg_cost) * 100);
}

/**
 * Write the day's daily_pnl row (idempotent upsert) and return the summary
 * used by both QQ digests and the intraday email.
 */
export function snapshotAndSummarize(
  book: BookId,
  input: {
    date?: string;
    prices: Record<string, number>; // CNY prices for held tickers
  },
): PaperSummary {
  const db = getDb(book);
  const date = input.date ?? beijingDate();
  ensureAccount(db, date);

  const acc = db.prepare("SELECT * FROM account WHERE id = 1").get() as {
    cash: number; month: string; month_start: number;
  };
  const rows = db.prepare("SELECT * FROM positions").all() as Array<{
    ticker: string; name: string; shares: number; avg_cost: number;
  }>;
  const holdings = rows.map((p) => ({
    ticker: p.ticker,
    name: p.name,
    shares: p.shares,
    price: input.prices[p.ticker] ?? p.avg_cost,
    pnlPct: holdingsPct(p, input.prices[p.ticker]),
  }));
  const marketValue = holdings.reduce((s, h) => s + h.shares * h.price, 0);
  const total = acc.cash + marketValue;

  const prev = db
    .prepare("SELECT total FROM daily_pnl WHERE trade_date < ? ORDER BY trade_date DESC LIMIT 1")
    .get(date) as { total: number } | undefined;
  const pnlDay = prev ? round2(total - prev.total) : null;
  const pnlDayPct = prev && prev.total > 0 ? round2(((total - prev.total) / prev.total) * 100) : null;
  const pnlMonth = round2(total - acc.month_start);
  const pnlMonthPct = round2((pnlMonth / acc.month_start) * 100);

  db.prepare(
    "INSERT INTO daily_pnl (trade_date, cash, market_value, total, pnl_day, pnl_total, pnl_pct) VALUES (?,?,?,?,?,?,?) ON CONFLICT(trade_date) DO UPDATE SET cash=excluded.cash, market_value=excluded.market_value, total=excluded.total, pnl_day=excluded.pnl_day, pnl_total=excluded.pnl_total, pnl_pct=excluded.pnl_pct",
  ).run(date, acc.cash, marketValue, total, pnlDay, pnlMonth, pnlMonthPct);

  return {
    month: acc.month,
    cash: round2(acc.cash),
    marketValue: round2(marketValue),
    total: round2(total),
    positionPct: total > 0 ? round2((marketValue / total) * 100) : 0,
    holdings,
    pnlDay,
    pnlDayPct,
    pnlMonth,
    pnlMonthPct,
  };
}

/** Today's executed trades (for the evening digest's 操作 line). */
export function tradesForDate(book: BookId, date: string = beijingDate()): ExecutedTrade[] {
  const db = getDb(book);
  const rows = db.prepare("SELECT * FROM trades WHERE trade_date = ? ORDER BY id").all(date) as Array<{
    action: string; ticker: string; name: string; shares: number; price: number; amount: number; reason: string;
  }>;
  return rows.map((t) => ({
    action: t.action as "BUY" | "SELL",
    ticker: t.ticker,
    name: t.name,
    shares: t.shares,
    price: t.price,
    amount: t.amount,
    reason: t.reason,
  }));
}

/** Format a trade compactly for the QQ digest, e.g. 买入 生益科技 200股@19.00 ¥3800. */
export function formatTrade(t: ExecutedTrade): string {
  return `${t.action === "BUY" ? "买入" : "卖出"} ${t.name} ${t.shares}股@${t.price.toFixed(2)} ¥${round2(t.amount)}`;
}

// ── Intraday flatten (10:00 / 13:00) ────────────────────────────────

/**
 * SELL-ONLY fill during the intraday sessions: the AI may decide to go flat
 * mid-day (退潮清仓 / 5-trading-day cap / TRIM). Never buys — entries still
 * wait for the 22:00 close fill. Idempotent per (date, session) via the
 * trade_days marker; the evening run uses a different key so it still fills
 * the BUY side afterwards.
 */
export function executeIntradayFlat(
  book: BookId,
  input: {
    date?: string;
    session: "am" | "pm"; // 10:00 / 13:00 北京时间
    prices: Record<string, number>;
    aiRecs: AIBuyRecommendation[];
    sentiment: MarketSentiment | null;
  },
): { skipped: boolean; trades: ExecutedTrade[] } {
  const db = getDb(book);
  const date = input.date ?? beijingDate();
  ensureAccount(db, date);
  const key = `${date}#${input.session}`;
  if (db.prepare("SELECT trade_date FROM trade_days WHERE trade_date = ?").get(key)) {
    return { skipped: true, trades: tradesForDate(book, key) };
  }
  // New month and the evening reset hasn't run yet — never trade a stale book.
  if (needsMonthlyReset(db, date)) return { skipped: true, trades: [] };

  const trades: ExecutedTrade[] = [];
  runSellSide(db, date, input, trades, input.session === "am" ? "（盘中10:00）" : "（盘中13:00）");
  db.prepare("INSERT INTO trade_days (trade_date) VALUES (?) ON CONFLICT(trade_date) DO NOTHING").run(key);
  return { skipped: false, trades };
}

// ── Monthly statistics (monthly report) ─────────────────────────────

export interface RoundTrip {
  ticker: string;
  name: string;
  buyAmount: number;
  sellAmount: number;
  boughtShares: number;
  soldShares: number;
  /** Realized P&L on the sold portion (buy-avg-cost basis); null while fully held. */
  realized: number | null;
  status: "已平仓" | "部分平仓" | "持仓中";
  /** Trading days first-buy → last-sell; null while still held. */
  holdDays: number | null;
}

export interface MonthStats {
  month: string;
  /** monthly_history row — null while the month is still running. */
  startCapital: number;
  endTotal: number | null;
  pnl: number | null;
  pnlPct: number | null;
  equityCurve: Array<{ date: string; total: number }>;
  peak: number | null;
  trough: number | null;
  maxDrawdownPct: number | null;
  trades: Array<ExecutedTrade & { date: string; session: "收盘" | "盘中10:00" | "盘中13:00" }>;
  roundTrips: RoundTrip[];
  daysTraded: number;
  buyCount: number;
  sellCount: number;
  winCount: number;
  lossCount: number;
  /** Mean holding period of fully-closed round trips (trading days). */
  avgHoldDays: number | null;
  /** Days spent fully in cash. */
  flatDays: number;
}

/**
 * Aggregate one book's month: equity curve, round trips with realized P&L,
 * and operational stats. Works for a running month too (endTotal null).
 */
export function monthlyStats(book: BookId, month: string): MonthStats {
  const db = getDb(book);
  const prefix = `${month}%`;

  const hist = db.prepare("SELECT * FROM monthly_history WHERE month = ?").get(month) as
    | { month: string; start_capital: number; end_total: number; pnl: number; pnl_pct: number }
    | undefined;
  const acc = db.prepare("SELECT month_start FROM account WHERE id = 1").get() as
    | { month_start: number }
    | undefined;
  const startCapital = hist?.start_capital ?? acc?.month_start ?? MONTHLY_CAPITAL;

  const pnlRows = db
    .prepare("SELECT trade_date, total, market_value FROM daily_pnl WHERE trade_date LIKE ? ORDER BY trade_date")
    .all(prefix) as Array<{ trade_date: string; total: number; market_value: number }>;
  const equityCurve = pnlRows.map((r) => ({ date: r.trade_date, total: r.total }));
  const totals = equityCurve.map((p) => p.total);
  const peak = totals.length > 0 ? Math.max(...totals) : null;
  const trough = totals.length > 0 ? Math.min(...totals) : null;
  // Max peak→subsequent-trough drawdown over the curve.
  let maxDrawdownPct: number | null = null;
  let runningPeak = -Infinity;
  for (const t of totals) {
    runningPeak = Math.max(runningPeak, t);
    if (runningPeak > 0) {
      const dd = ((t - runningPeak) / runningPeak) * 100;
      maxDrawdownPct = dd < (maxDrawdownPct ?? 0) ? dd : maxDrawdownPct;
    }
  }

  const rawTrades = db
    .prepare("SELECT trade_date, ticker, name, action, shares, price, amount, reason FROM trades WHERE trade_date LIKE ? ORDER BY id")
    .all(prefix) as Array<{
    trade_date: string; ticker: string; name: string; action: string; shares: number; price: number; amount: number; reason: string;
  }>;
  const trades = rawTrades.map((t) => {
    const [d, session] = t.trade_date.split("#");
    return {
      date: d,
      session: (session === "am" ? "盘中10:00" : session === "pm" ? "盘中13:00" : "收盘") as "收盘" | "盘中10:00" | "盘中13:00",
      action: t.action as "BUY" | "SELL",
      ticker: t.ticker,
      name: t.name,
      shares: t.shares,
      price: t.price,
      amount: t.amount,
      reason: t.reason,
    };
  });

  // Round trips per ticker: avg-cost basis on the bought shares.
  const byTicker = new Map<string, { name: string; buyAmount: number; sellAmount: number; boughtShares: number; soldShares: number; firstBuy: string | null; lastSell: string | null }>();
  for (const t of trades) {
    const b = byTicker.get(t.ticker) ?? {
      name: t.name, buyAmount: 0, sellAmount: 0, boughtShares: 0, soldShares: 0, firstBuy: null, lastSell: null,
    };
    if (t.action === "BUY") {
      b.buyAmount += t.amount;
      b.boughtShares += t.shares;
      b.firstBuy ??= t.date;
    } else {
      b.sellAmount += t.amount;
      b.soldShares += t.shares;
      b.lastSell = t.date;
    }
    byTicker.set(t.ticker, b);
  }
  const roundTrips: RoundTrip[] = [...byTicker.entries()].map(([ticker, b]) => {
    const avgCost = b.boughtShares > 0 ? b.buyAmount / b.boughtShares : 0;
    const fullyClosed = b.boughtShares > 0 && b.soldShares >= b.boughtShares;
    const partiallySold = b.soldShares > 0 && b.soldShares < b.boughtShares;
    const realized =
      b.soldShares > 0 && b.boughtShares > 0
        ? round2(b.sellAmount - avgCost * b.soldShares)
        : null;
    const status: RoundTrip["status"] = fullyClosed ? "已平仓" : partiallySold ? "部分平仓" : "持仓中";
    return {
      ticker,
      name: b.name,
      buyAmount: round2(b.buyAmount),
      sellAmount: round2(b.sellAmount),
      boughtShares: b.boughtShares,
      soldShares: b.soldShares,
      realized,
      status,
      holdDays: fullyClosed && b.firstBuy && b.lastSell ? tradingDaysBetween(b.firstBuy, b.lastSell) : null,
    };
  }).sort((a, z) => (a.realized ?? 0) - (z.realized ?? 0)); // 亏最多的排前面

  const buyCount = trades.filter((t) => t.action === "BUY").length;
  const sellCount = trades.filter((t) => t.action === "SELL").length;
  const closed = roundTrips.filter((r) => r.status === "已平仓" && r.realized != null);
  const winCount = closed.filter((r) => r.realized! > 0).length;
  const lossCount = closed.filter((r) => r.realized! <= 0).length;
  const holdDays = closed.map((r) => r.holdDays ?? 0).filter((d) => d >= 0);

  return {
    month,
    startCapital,
    endTotal: hist?.end_total ?? null,
    pnl: hist?.pnl ?? null,
    pnlPct: hist?.pnl_pct ?? null,
    equityCurve,
    peak,
    trough,
    maxDrawdownPct,
    trades,
    roundTrips,
    daysTraded: new Set(trades.filter((t) => t.action === "BUY").map((t) => t.date)).size,
    buyCount,
    sellCount,
    winCount,
    lossCount,
    avgHoldDays: holdDays.length > 0 ? round2(holdDays.reduce((s, d) => s + d, 0) / holdDays.length) : null,
    // 当日收盘空仓的天数（market_value=0 的快照）。
    flatDays: pnlRows.filter((r) => r.market_value === 0).length,
  };
}
