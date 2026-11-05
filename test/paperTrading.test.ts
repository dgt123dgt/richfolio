import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";

// DB must point at a throwaway file BEFORE the module loads (path read at import).
process.env.PAPER_TRADING_DB = "data/.test-paper.db";

const {
  executeDailyTrades,
  snapshotAndSummarize,
  parseTargetPositionPct,
  tradesForDate,
  formatTrade,
  MONTHLY_CAPITAL,
} = await import("../src/paperTrading.js");
import type { MarketSentiment } from "../src/marketSentiment.js";
import type { AIBuyRecommendation } from "../src/providers/types.js";
import type { ExecutedTrade } from "../src/paperTrading.js";

// ── fixtures ────────────────────────────────────────────────────────

function sentiment(overrides: Partial<MarketSentiment> = {}): MarketSentiment {
  return {
    date: "2026-11-05",
    metrics: {
      ztCount: 84, zbCount: 47, dtCount: 0, maxLbc: 4,
      promoteRate: 0.178, redRate: 0.81, bigLossCount: 1,
    },
    phase: "分歧",
    matches: 3,
    positionHint: "仓位 20%–30%：只做辨识度龙头，不批量扫低位首板",
    concepts: [
      {
        name: "光伏概念", ztCount: 20, yCount: 15, maxLbc: 4, premium: 8.2,
        score: 90, phase: "主升",
        leader: { name: "闽发铝业", lbc: 4 },
        mainNet: 33.1, buyers: null, amount: 2088.7, amountChangePct: 17.6, volumeState: "放量",
      },
    ],
    relayHint: null,
    ladderText: "4板×2 · 首板63",
    spaceText: null,
    tomorrowScenarios: [],
    leaderAlert: null,
    ...overrides,
  } as unknown as MarketSentiment;
}

function rec(ticker: string, action: string, confidence = 77): AIBuyRecommendation {
  return {
    ticker,
    tickerFullName: null,
    originalCurrency: "CNY",
    action,
    confidence,
    reason: "测试理由",
    suggestedBuyValue: 0,
  } as AIBuyRecommendation;
}

const PRICES = { "600519.SS": 19.0, "000001.SZ": 10.0, "002407.SZ": 30.0 };

function paperFixture(): PaperSummary {
  return {
    month: "2026-11",
    cash: 16200,
    marketValue: 3800,
    total: 20000,
    positionPct: 19,
    holdings: [{ ticker: "600519.SS", name: "贵州茅台", shares: 200, price: 19.5, pnlPct: 2.6 }],
    pnlDay: 12.5,
    pnlDayPct: 0.06,
    pnlMonth: 64,
    pnlMonthPct: 0.32,
  };
}

// ── position sizing ─────────────────────────────────────────────────

describe("parseTargetPositionPct", () => {
  it("takes the midpoint of a range hint", () => {
    assert.equal(parseTargetPositionPct("仓位 20%–30%：只做龙头"), 25);
    assert.equal(parseTargetPositionPct("仓位 10%-20%"), 15);
  });

  it("reads a capped hint and falls back sanely", () => {
    assert.equal(parseTargetPositionPct("仓位 ≤10%，现金为王"), 10);
    assert.equal(parseTargetPositionPct("仓位 15%"), 15);
    assert.equal(parseTargetPositionPct(null), 20);
  });
});

// ── engine ──────────────────────────────────────────────────────────

describe("paper trading engine", () => {
  before(() => {
    // Fresh file per test run keeps the fixture math predictable.
    try {
      unlinkSync("data/.test-paper.db");
    } catch {
      /* first run — nothing to clean */
    }
  });

  it("starts with the monthly capital and fills BUY calls in confidence order", () => {
    const { trades } = executeDailyTrades({
      date: "2026-11-05",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 82), rec("000001.SZ", "BUY", 71), rec("AAPL", "BUY", 99)],
      sentiment: sentiment(),
    });
    assert.equal(MONTHLY_CAPITAL, 20000);
    // AAPL is not an A-share — must never fill.
    assert.ok(trades.every((t: ExecutedTrade) => /\.(SS|SZ)$/.test(t.ticker)));
    assert.ok(trades.length >= 1, "at least one fill");
    const buy = trades[0];
    assert.equal(buy.action, "BUY");
    assert.equal(buy.shares % 100, 0, "board-lot rounding");
    const snap = snapshotAndSummarize({ date: "2026-11-05", prices: PRICES });
    assert.ok(snap.cash <= 20000 && snap.cash >= 0);
    assert.ok(snap.positionPct <= 30.5, `target 25% cap respected (got ${snap.positionPct}%)`);
  });

  it("is idempotent per trade date — a second run re-fills nothing", () => {
    const second = executeDailyTrades({
      date: "2026-11-05",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 82)],
      sentiment: sentiment(),
    });
    assert.equal(second.skipped, true);
    assert.deepEqual(second.trades, tradesForDate("2026-11-05"));
  });

  it("liquidates everything when the phase turns 退潮", () => {
    const s = sentiment({ phase: "退潮" } as Partial<MarketSentiment>);
    const { trades } = executeDailyTrades({
      date: "2026-11-06",
      prices: PRICES,
      aiRecs: [],
      sentiment: s,
    });
    assert.ok(trades.length > 0);
    assert.ok(trades.every((t: ExecutedTrade) => t.action === "SELL"));
    const snap = snapshotAndSummarize({ date: "2026-11-06", prices: PRICES });
    assert.equal(snap.positionPct, 0);
    assert.ok(snap.cash > 0);
  });

  it("resets to full capital when the month rolls over", () => {
    // Hold something into month-end (new November date, so no guard collision).
    const nov = executeDailyTrades({
      date: "2026-11-28",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 80)],
      sentiment: sentiment(),
    });
    console.log("DEBUG 11-28:", JSON.stringify(nov));
    const { trades } = executeDailyTrades({
      date: "2026-12-01",
      prices: PRICES,
      aiRecs: [],
      sentiment: sentiment(),
    });
    console.log("DEBUG 12-01 trades:", JSON.stringify(trades));
    // 2026-11 account existed → month change triggers liquidation + re-fund.
    assert.ok(trades.some((t: ExecutedTrade) => t.reason.includes("月末清仓")));
    const snap = snapshotAndSummarize({ date: "2026-12-01", prices: PRICES });
    assert.equal(snap.cash, 20000);
    assert.equal(snap.month, "2026-12");
  });

  it("formats trades compactly", () => {
    const text = formatTrade({
      action: "BUY", ticker: "600519.SS", name: "贵州茅台", shares: 200, price: 19.0, amount: 3800, reason: "AI BUY",
    });
    assert.equal(text, "买入 贵州茅台 200股@19.00 ¥3800");
  });
});
