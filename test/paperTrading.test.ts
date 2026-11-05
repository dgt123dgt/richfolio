import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, rmSync, mkdirSync } from "node:fs";

// Books must point at a throwaway dir BEFORE the module loads (paths read at import).
process.env.PAPER_TRADING_DB_DIR = "data/.test-paper-books";
mkdirSync("data/.test-paper-books", { recursive: true });

const {
  BOOK_IDS,
  executeDailyTrades,
  executeIntradayFlat,
  snapshotAndSummarize,
  parseTargetPositionPct,
  tradingDaysBetween,
  tradesForDate,
  monthlyStats,
  formatTrade,
  MONTHLY_CAPITAL,
} = await import("../src/paperTrading.js");
const { recsForProvider } = await import("../src/aiAggregation.js");
const { saveBriefArchive, loadBriefArchive, archiveContextBlock } = await import(
  "../src/briefArchive.js"
);
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

describe("tradingDaysBetween", () => {
  it("counts weekdays only — weekends never advance the 5-day clock", () => {
    assert.equal(tradingDaysBetween("2026-11-09", "2026-11-13"), 5, "Mon→Fri = 5");
    assert.equal(tradingDaysBetween("2026-11-09", "2026-11-16"), 6, "Fri→next Mon = 6 (weekend skipped)");
    assert.equal(tradingDaysBetween("2026-11-06", "2026-11-09"), 2, "Fri→Mon crosses a weekend = 2");
    assert.equal(tradingDaysBetween(null, "2026-11-09"), 0);
    assert.equal(tradingDaysBetween("2026-11-16", "2026-11-09"), 0, "future entry counts 0");
  });
});

// ── per-provider rec feeds ──────────────────────────────────────────

describe("recsForProvider", () => {
  it("splits aggregated recs into provider-private lists", () => {
    const aggregated = {
      ...rec("600519.SS", "STRONG BUY", 80),
      providers: [
        { providerId: "deepseek", action: "STRONG BUY", confidence: 88, reason: "DS 理由", suggestedBuyValue: 0 },
        { providerId: "gemini", action: "WAIT", confidence: 35, reason: "GM 理由", suggestedBuyValue: 0 },
      ],
    } as AIBuyRecommendation;
    const ds = recsForProvider([aggregated], "deepseek");
    const gm = recsForProvider([aggregated], "gemini");
    assert.equal(ds.length, 1);
    assert.equal(ds[0].action, "STRONG BUY");
    assert.equal(ds[0].confidence, 88);
    assert.equal(gm[0].action, "WAIT", "Gemini's own dissent survives");
    // A rec with no vote from that provider stays out of its book.
    const lone = recsForProvider([{ ...rec("000001.SZ", "BUY"), providers: [{ providerId: "deepseek", action: "BUY", confidence: 60, reason: "", suggestedBuyValue: 0 }] } as AIBuyRecommendation], "gemini");
    assert.equal(lone.length, 0);
  });
});

// ── engine (per book) ───────────────────────────────────────────────

describe("paper trading books", () => {
  before(() => {
    // Fresh files per test run keep the fixture math predictable.
    for (const id of ["deepseek", "gemini"]) {
      try {
        unlinkSync(`data/.test-paper-books/paper-trading-${id}.db`);
      } catch {
        /* first run — nothing to clean */
      }
    }
  });

  it("each book starts with its own capital and fills only its provider's votes", () => {
    const [ds, gm] = BOOK_IDS;
    const { trades } = executeDailyTrades(ds, {
      date: "2026-11-05",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 82), rec("000001.SZ", "BUY", 71), rec("AAPL", "BUY", 99)],
      sentiment: sentiment(),
    });
    assert.equal(MONTHLY_CAPITAL, 20000);
    assert.ok(trades.every((t: ExecutedTrade) => /\.(SS|SZ)$/.test(t.ticker)));
    assert.ok(trades.length >= 1);
    assert.equal(trades[0].shares % 100, 0, "board-lot rounding");
    const snap = snapshotAndSummarize(ds, { date: "2026-11-05", prices: PRICES });
    assert.ok(snap.cash <= 20000 && snap.cash >= 0);
    assert.ok(snap.positionPct <= 30.5, `target 25% cap respected (got ${snap.positionPct}%)`);

    // Gemini's book is a separate universe — empty account, no shared state.
    const gmSnap = snapshotAndSummarize(gm, { date: "2026-11-05", prices: PRICES });
    assert.equal(gmSnap.total, 20000, "Gemini book untouched by DeepSeek fills");
    assert.equal(gmSnap.holdings.length, 0);
    assert.equal(gmSnap.cash, 20000);
  });

  it("is idempotent per trade date per book", () => {
    const [ds] = BOOK_IDS;
    const second = executeDailyTrades(ds, {
      date: "2026-11-05",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 82)],
      sentiment: sentiment(),
    });
    assert.equal(second.skipped, true);
    assert.deepEqual(second.trades, tradesForDate(ds, "2026-11-05"));
  });

  it("liquidates everything when the phase turns 退潮", () => {
    const gm = BOOK_IDS[1];
    // 先建仓（gm 自己的 11-05），次日退潮清仓。
    executeDailyTrades(gm, {
      date: "2026-11-05",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 80)],
      sentiment: sentiment(),
    });
    const { trades } = executeDailyTrades(gm, {
      date: "2026-11-06",
      prices: PRICES,
      aiRecs: [],
      sentiment: sentiment({ phase: "退潮" } as Partial<MarketSentiment>),
    });
    assert.ok(trades.length > 0);
    assert.ok(trades.every((t: ExecutedTrade) => t.action === "SELL"));
    const snap = snapshotAndSummarize(gm, { date: "2026-11-06", prices: PRICES });
    assert.equal(snap.positionPct, 0);
    assert.ok(snap.cash > 0);
  });

  it("enforces the 5-trading-day cap with weekends excluded", () => {
    const gm = BOOK_IDS[1];
    // Buy Monday 11-09 → held days: 9,10,11,12,13 (Fri) = 5; Monday 11-16 = 6 → force-sell.
    executeDailyTrades(gm, {
      date: "2026-11-09",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 80)],
      sentiment: sentiment(),
    });
    const { trades } = executeDailyTrades(gm, {
      date: "2026-11-16",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 85)], // AI 想加仓也不行
      sentiment: sentiment(),
    });
    assert.ok(
      trades.some((t: ExecutedTrade) => t.action === "SELL" && t.reason.includes("强制卖出")),
      `stale position force-sold, got: ${JSON.stringify(trades)}`,
    );
    const snap = snapshotAndSummarize(gm, { date: "2026-11-16", prices: PRICES });
    assert.equal(snap.holdings.length, 0);
  });

  it("resets to full capital when the month rolls over", () => {
    const [ds] = BOOK_IDS;
    // 先退潮清掉 11-05 的旧仓（它们早过了 5 日线，否则会被强平而不是留到月末），
    // 再在月末前建一笔新仓，跨月时应被月末清仓 + 资金重置。
    executeDailyTrades(ds, {
      date: "2026-11-25",
      prices: PRICES,
      aiRecs: [],
      sentiment: sentiment({ phase: "退潮" } as Partial<MarketSentiment>),
    });
    executeDailyTrades(ds, {
      date: "2026-11-26",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 80)],
      sentiment: sentiment(),
    });
    const { trades } = executeDailyTrades(ds, {
      date: "2026-12-01",
      prices: PRICES,
      aiRecs: [],
      sentiment: sentiment(),
    });
    assert.ok(trades.some((t: ExecutedTrade) => t.reason.includes("月末清仓")));
    const snap = snapshotAndSummarize(ds, { date: "2026-12-01", prices: PRICES });
    assert.equal(snap.cash, 20000);
    assert.equal(snap.month, "2026-12");
  });

  it("formats trades compactly", () => {
    const text = formatTrade({
      action: "BUY", ticker: "600519.SS", name: "贵州茅台", shares: 200, price: 19.0, amount: 3800, reason: "AI BUY",
    });
    assert.equal(text, "买入 贵州茅台 200股@19.00 ¥3800");
  });

  it("intraday sessions sell to flat but never buy", () => {
    const [ds, gm] = BOOK_IDS;
    // 建仓于 11-09，10:00 AI 说 TRIM → 盘中减半；13:00 再 TRIM 不重复（幂等 per session）。
    executeDailyTrades(ds, {
      date: "2026-11-09",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 80)],
      sentiment: sentiment(),
    });
    const am = executeIntradayFlat(ds, {
      date: "2026-11-12", session: "am",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "TRIM", 70)],
      sentiment: sentiment(),
    });
    assert.ok(am.trades.every((t: ExecutedTrade) => t.action === "SELL"), "intraday never buys");
    assert.ok(am.trades.length > 0, `am trades: ${JSON.stringify(am)}`);
    const amRerun = executeIntradayFlat(ds, {
      date: "2026-11-12", session: "am",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "TRIM", 70)],
      sentiment: sentiment(),
    });
    assert.equal(amRerun.skipped, true, "idempotent per session");
    // 13:00 是另一个会话键，可以再次 TRIM 剩余。
    const pm = executeIntradayFlat(ds, {
      date: "2026-11-12", session: "pm",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "TRIM", 70)],
      sentiment: sentiment(),
    });
    assert.ok(pm.trades.length > 0);
    const snap = snapshotAndSummarize(ds, { date: "2026-11-12", prices: PRICES });
    assert.equal(snap.holdings.length, 0, "fully trimmed flat");
    // Gemini 仓未被 DeepSeek 的盘中操作波及（11-16 强平后一直空仓）。
    const gmSnap = snapshotAndSummarize(gm, { date: "2026-11-12", prices: PRICES });
    assert.equal(gmSnap.holdings.length, 0, "other book untouched");
    assert.equal(gmSnap.total, 20000);
  });

  it("intraday 退潮 liquidates everything mid-day", () => {
    const gm = BOOK_IDS[1];
    executeDailyTrades(gm, {
      date: "2026-11-17",
      prices: PRICES,
      aiRecs: [rec("600519.SS", "STRONG BUY", 80)],
      sentiment: sentiment(),
    });
    const flat = executeIntradayFlat(gm, {
      date: "2026-11-18", session: "am",
      prices: PRICES,
      aiRecs: [],
      sentiment: sentiment({ phase: "退潮" } as Partial<MarketSentiment>),
    });
    assert.ok(flat.trades.length > 0);
    assert.ok(flat.trades.every((t: ExecutedTrade) => t.reason.includes("退潮")));
    const snap = snapshotAndSummarize(gm, { date: "2026-11-18", prices: PRICES });
    assert.equal(snap.positionPct, 0);
  });
});

// ── monthly statistics ──────────────────────────────────────────────

describe("monthlyStats", () => {
  it("aggregates round trips with realized P&L and equity curve", () => {
    const [ds] = BOOK_IDS;
    const stats = monthlyStats(ds, "2026-11");
    assert.ok(stats.trades.length > 0, "trades recorded across the month");
    assert.ok(stats.equityCurve.length > 0);
    assert.ok(stats.equityCurve.every((p: { date: string }) => p.date.startsWith("2026-11")));

    const maotai = stats.roundTrips.find((r) => r.ticker === "600519.SS");
    assert.ok(maotai, "Maotai round trip present");
    // 11-09 买 200 股@19，11-12 盘中 am/pm 两次 TRIM 卖 200 股（11-28 还有一次
    // 月末重置测试的买入）。已卖部分成本恰好等于卖得 → realized 0，部分平仓。
    assert.equal(maotai!.status, "部分平仓");
    assert.equal(maotai!.realized, 0);
    // 000001：11-05 买 200 股、11-25 退潮清仓卖出 → 已平仓、盈亏 0。
    const bank = stats.roundTrips.find((r) => r.ticker === "000001.SZ");
    assert.ok(bank && bank.status === "已平仓" && bank.realized === 0,
      `trades: ${JSON.stringify(stats.trades)}; roundTrips: ${JSON.stringify(stats.roundTrips)}`);
    // Equity curve from daily_pnl: totals are finite positive numbers.
    assert.ok(stats.equityCurve.every((p: { total: number }) => p.total > 0));
  });

  it("reports an unknown month as empty", () => {
    const gm = BOOK_IDS[1];
    const stats = monthlyStats(gm, "2020-01");
    assert.equal(stats.trades.length, 0);
    assert.equal(stats.roundTrips.length, 0);
    assert.equal(stats.equityCurve.length, 0);
    assert.equal(stats.startCapital, 20000);
  });
});

// ── brief archive ───────────────────────────────────────────────────

describe("brief archive", () => {
  it("roundtrips a day and renders a compact context block", () => {
    const archive = {
      date: "2026-11-05",
      sentiment: sentiment(),
      hotNews: [{ title: "央行宣布降准", source: "东方财富", publishedAt: "2026-11-05T09:00:00" }],
      aiRecs: [rec("600519.SS", "STRONG BUY", 80)],
      books: {
        deepseek: {
          paper: { month: "2026-11", cash: 16200, marketValue: 3800, total: 20000, positionPct: 19, holdings: [], pnlDay: 12.5, pnlDayPct: 0.06, pnlMonth: 64, pnlMonthPct: 0.32 },
          trades: [{ action: "BUY", ticker: "600519.SS", name: "贵州茅台", shares: 200, price: 19.0, amount: 3800, reason: "AI STRONG BUY" }],
        },
        gemini: {
          paper: { month: "2026-11", cash: 20000, marketValue: 0, total: 20000, positionPct: 0, holdings: [], pnlDay: null, pnlDayPct: null, pnlMonth: 0, pnlMonthPct: 0 },
          trades: [],
        },
      },
    };
    saveBriefArchive(archive as never);
    const loaded = loadBriefArchive("2026-11-05");
    assert.ok(loaded);
    assert.equal(loaded!.sentiment.phase, "分歧");
    assert.ok(loaded!.books.gemini);
    const block = archiveContextBlock([loaded!]);
    assert.ok(block.includes("■ 2026-11-05"));
    assert.ok(block.includes("情绪:分歧(命中3/6)"));
    assert.ok(block.includes("题材:光伏概念[主升]"));
    assert.ok(block.includes("deepseek仓:仓位19%"));
  });
});
