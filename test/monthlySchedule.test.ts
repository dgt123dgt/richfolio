// ── monthly scheduling & month-end fallback ─────────────────────────
// 月报在月末最后交易日晚 23:00 触发（cron 28-31 日每晚派发，isLastWeekdayOfMonth
// 守卫），此时月初重置尚未发生 → monthly_history 没有该月行，期末资产从净值
// 曲线末点推导。独立进程运行，自建账本状态。

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// 独立 DB 目录：node --test 并行运行测试文件，不能与 paperTrading.test.ts
// 共享 data/.test-paper-books。
process.env.PAPER_TRADING_DB_DIR = "data/.test-paper-books-monthly";
import { rmSync } from "node:fs";

before(() => {
  rmSync("data/.test-paper-books-monthly", { recursive: true, force: true });
});

const { isLastWeekdayOfMonth } = await import("../src/monthlyReport.js");
const {
  BOOK_IDS,
  executeDailyTrades,
  snapshotAndSummarize,
  monthlyStats,
} = await import("../src/paperTrading.js");

// Minimal local fixtures（与 paperTrading.test.ts 同款，测试文件间不共享模块）。
const mkRec = (ticker: string, action: string, confidence = 80) => ({
  ticker,
  tickerFullName: null,
  originalCurrency: "CNY",
  action,
  confidence,
  reason: "r",
  suggestedBuyValue: 0,
});
const mkSentiment = { phase: "分歧", positionHint: "仓位 20%–30%：只做辨识度龙头", metrics: { ztCount: 1 }, concepts: [], matches: 1 };
const P: Record<string, number> = { "600519.SS": 19.0, "000001.SZ": 10.0, "002407.SZ": 30.0 };

describe("isLastWeekdayOfMonth", () => {
  it("true on the last weekday of the month", () => {
    assert.equal(isLastWeekdayOfMonth("2026-11-30"), true, "Nov 30 2026 is a Monday");
    assert.equal(isLastWeekdayOfMonth("2026-02-27"), true, "Feb 28 2026 is a Saturday → Feb 27");
    assert.equal(isLastWeekdayOfMonth("2026-10-30"), true, "Oct 31 2026 is a Saturday → Oct 30");
    assert.equal(isLastWeekdayOfMonth("2026-01-30"), true, "Jan 31 2026 is a Saturday → Jan 30");
    assert.equal(isLastWeekdayOfMonth("2026-03-31"), true, "Mar 31 2026 is a Tuesday");
  });

  it("false on weekends and on days before the last weekday", () => {
    assert.equal(isLastWeekdayOfMonth("2026-11-28"), false, "Saturday");
    assert.equal(isLastWeekdayOfMonth("2026-11-29"), false, "Sunday");
    assert.equal(isLastWeekdayOfMonth("2026-11-27"), false, "Friday before last Monday");
    assert.equal(isLastWeekdayOfMonth("2026-10-31"), false, "Saturday, month ends Friday 30th");
    assert.equal(isLastWeekdayOfMonth("2026-01-31"), false, "Saturday, month ends Friday 30th");
  });
});

describe("monthlyStats month-end fallback", () => {
  it("derives endTotal/pnl from the equity curve when monthly_history is absent", () => {
    const [ds] = BOOK_IDS;
    // 10 月内交易但不跨月 → 没有任何月初重置 → monthly_history 无 2026-10 行。
    executeDailyTrades(ds, {
      date: "2026-10-12",
      prices: P,
      aiRecs: [mkRec("600519.SS", "STRONG BUY", 80)],
      sentiment: mkSentiment as never,
    });
    const snap = snapshotAndSummarize(ds, { date: "2026-10-12", prices: P });

    const stats = monthlyStats(ds, "2026-10");
    assert.equal(stats.month, "2026-10");
    assert.equal(stats.endTotal, snap.total, "endTotal = last equity point");
    assert.equal(stats.pnl, Math.round((snap.total - 20000) * 100) / 100);
    assert.equal(
      stats.pnlPct,
      Math.round(((snap.total - 20000) / 20000) * 100 * 100) / 100,
    );
    assert.ok(stats.equityCurve.length > 0);
  });
});
