import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEveningDigest,
  buildIntradayDigest,
  sentimentLine,
  bookLine,
  chunkText,
} from "../src/qqNotify.js";
import type { MarketSentiment } from "../src/marketSentiment.js";
import type { AIBuyRecommendation } from "../src/providers/types.js";
import type { PaperSummary, ExecutedTrade } from "../src/paperTrading.js";

function sentiment(): MarketSentiment {
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

describe("sentimentLine / bookLine", () => {
  it("one line each: sentiment verdict + book position & P&L", () => {
    const s = sentimentLine(sentiment());
    assert.ok(s.includes("情绪:分歧(命中3/6)"));
    assert.ok(s.includes("仓位建议:20%–30%"));
    const p = bookLine("DeepSeek", paperFixture());
    assert.ok(p.startsWith("DeepSeek仓:总¥20,000 仓位19%"));
    assert.ok(p.includes("本月+0.3%"));
    assert.ok(p.includes("持仓:贵州茅台"));
  });

  it("handles missing sentiment data", () => {
    assert.ok(sentimentLine(null).includes("数据缺失"));
  });
});

describe("buildEveningDigest", () => {
  it("sentiment + mainline + both books' ops + P&L — nothing else", () => {
    const text = buildEveningDigest({
      sentiment: sentiment(),
      books: [
        { id: "deepseek", paper: paperFixture(), trades: [
          { action: "BUY", ticker: "600519.SS", name: "贵州茅台", shares: 200, price: 19.0, amount: 3800, reason: "AI STRONG BUY" },
        ] },
        { id: "gemini", paper: { ...paperFixture(), holdings: [], pnlDay: null, pnlDayPct: null, pnlMonth: 0, pnlMonthPct: 0 }, trades: [] },
      ],
      date: new Date("2026-11-05T22:00:00"),
    });
    assert.ok(text.startsWith("【盘后简报】11/5"));
    assert.ok(text.includes("情绪:分歧(命中3/6)"));
    assert.ok(text.includes("主线:光伏概念[主升] 龙头闽发铝业4板"));
    assert.ok(text.includes("DeepSeek仓:总¥20,000 仓位19%"));
    assert.ok(text.includes("Gemini仓:"));
    assert.ok(text.includes("买入 贵州茅台 200股@19.00 ¥3800"));
    assert.ok(text.includes("操作:无（观望）"), "idle book still reported");
    // The noise the user asked to strip must NOT come back:
    assert.ok(!text.includes("梯队:"), "no ladder line");
    assert.ok(!text.includes("〔"), "no section banners");
    assert.ok(!text.includes("明日:"), "no scenario branches");
    assert.ok(!text.includes("题材:"), "no concept dump");
  });
});

describe("buildIntradayDigest", () => {
  it("sentiment + AI picks + both books' P&L only", () => {
    const text = buildIntradayDigest({
      sentiment: sentiment(),
      aiRecs: [rec("600519.SS", "STRONG BUY", 82), rec("000001.SZ", "WAIT", 40)],
      books: [
        { id: "deepseek", paper: paperFixture() },
        { id: "gemini", paper: { ...paperFixture(), holdings: [], pnlDay: null, pnlDayPct: null, pnlMonth: 0, pnlMonthPct: 0 } },
      ],
      date: new Date("2026-11-06T10:00:00"),
    });
    assert.ok(text.startsWith("【盘中快报】11/6"));
    assert.ok(text.includes("AI推荐:"), "AI line present");
    assert.ok(text.includes("(82%)"), "top pick with confidence");
    assert.ok(!text.includes("(40%)"), "non-buy recs stay out");
    assert.ok(text.includes("DeepSeek仓:"));
    assert.ok(text.includes("Gemini仓:"));
    assert.ok(text.includes("持仓:"));
    assert.ok(!text.includes("梯队:"), "no ladder line");
  });

  it("says so when nothing is buyable today", () => {
    const text = buildIntradayDigest({
      sentiment: sentiment(),
      aiRecs: [rec("600519.SS", "HOLD", 50)],
      books: [{ id: "deepseek", paper: paperFixture() }],
      date: new Date("2026-11-06T13:00:00"),
    });
    assert.ok(text.includes("今日暂无买入级标的"));
  });
});

describe("chunkText", () => {
  it("splits long text by line within the limit", () => {
    const long = Array.from({ length: 60 }, (_, i) => `line-${i}`).join("\n");
    const chunks = chunkText(long, 200);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 200));
  });
});
