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

const DB_PATH = process.env.PAPER_TRADING_DB ?? "data/paper-trading.db";
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

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (_db) return _db;
  const file = resolve(DB_PATH);
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
  _db = db;
  return db;
}

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

// ── Core: execute the day's AI calls ────────────────────────────────

/**
 * Execute one day's simulated trades at close prices. Idempotent per date via
 * the trade_days marker (NOT daily_pnl — intraday summaries upsert that table
 * and must never block the evening run from filling).
 */
export function executeDailyTrades(input: {
  date?: string;
  prices: Record<string, number>; // CNY close prices, A-share tickers only
  aiRecs: AIBuyRecommendation[];
  sentiment: MarketSentiment | null;
}): { skipped: boolean; trades: ExecutedTrade[] } {
  const db = getDb();
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
      ticker: string; name: string; shares: number; avg_cost: number;
    }>;

  const phase = input.sentiment?.phase ?? null;
  const targetPct = phase === "退潮" ? 0 : parseTargetPositionPct(input.sentiment?.positionHint ?? null);

  const price = (t: string): number | undefined => input.prices[t];
  const marketValue = () =>
    positions().reduce((sum, p) => sum + (price(p.ticker) != null ? p.shares * price(p.ticker)! : p.avg_cost * p.shares), 0);
  const totalAssets = () => cash() + marketValue();

  // ── SELL side: forced flat in 退潮, TRIM halves ────────────────────
  if (targetPct === 0 && positions().length > 0) {
    trades.push(...closeAllPositions(db, date, input.prices, `退潮期清仓（情绪建议仓位≈0%）`));
  } else {
    for (const p of positions()) {
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
      ).run(date, new Date().toISOString(), p.ticker, p.name, "SELL", sellShares, px, amount, `AI 建议 TRIM（${rec.confidence}%）`, rec.confidence);
      trades.push({ action: "SELL", ticker: p.ticker, name: p.name, shares: sellShares, price: px, amount, reason: `AI TRIM (${rec.confidence}%)` });
    }
  }

  // ── BUY side: fill up to the sentiment target with top-confidence calls ──
  if (targetPct > 0) {
    const held = new Set(positions().map((p) => p.ticker));
    const candidates = input.aiRecs
      .filter((r) => isAshare(r.ticker) && (r.action === "BUY" || r.action === "STRONG BUY"))
      .filter((r) => !held.has(r.ticker) && price(r.ticker) != null)
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
          "INSERT INTO positions (ticker, name, shares, avg_cost, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(ticker) DO UPDATE SET shares = shares + excluded.shares, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at",
        ).run(r.ticker, displayName(r.ticker, r.tickerFullName), shares, px, new Date().toISOString());
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
export function snapshotAndSummarize(input: {
  date?: string;
  prices: Record<string, number>; // CNY prices for held tickers
}): PaperSummary {
  const db = getDb();
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
export function tradesForDate(date: string = beijingDate()): ExecutedTrade[] {
  const db = getDb();
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
