import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBriefDigest, chunkText } from "../src/qqNotify.js";
import type { MarketSentiment } from "../src/marketSentiment.js";
import type { AIBuyRecommendation } from "../src/providers/types.js";

const sentiment = (overrides: Partial<MarketSentiment> = {}): MarketSentiment => ({
  date: "20261105",
  metrics: {
    ztCount: 84,
    zbCount: 48,
    dtCount: 0,
    maxLbc: 4,
    promoteRate: 0.178,
    redRate: 0.814,
    bigLossCount: 1,
    avgPremium: 4.5,
    yesterdayZtCount: 118,
  },
  phase: "分歧",
  matches: 3,
  positionHint: "仓位 20%–30%：只做辨识度龙头，不批量扫低位首板",
  detail: [],
  concepts: [
    {
      name: "光伏概念",
      ztCount: 20,
      yCount: 16,
      maxLbc: 4,
      premium: 8,
      score: 100,
      phase: "主升",
      leader: { name: "闽发铝业", lbc: 4 },
      mainNet: 33.1,
      buyers: "超大单主导买入（机构/顶级游资加仓），散户在卖",
      amount: 2088.7,
      amountChangePct: 17.6,
      volumeState: "放量",
    },
  ],
  relayHint: null,
  leaderAlert: "主线龙头：闽发铝业（光伏概念 · 4板）继续涨停，梯队完好",
  ladderText: "4板×2 · 3板×2 · 2板×17 · 首板63",
  spaceText: "闽发铝业（4板·工业金属）",
  tomorrowScenarios: ["确认主升：涨停回升 ≥60", "重回退潮：涨停 <30", "维持混沌：徘徊"],
  ...overrides,
});

const rec = (overrides: Partial<AIBuyRecommendation>): AIBuyRecommendation =>
  ({
    ticker: "600183.SS",
    action: "STRONG BUY",
    confidence: 77,
    ...overrides,
  }) as AIBuyRecommendation;

describe("buildBriefDigest", () => {
  it("renders sentiment, ladder, themes, buys and portfolio into plain text", () => {
    const text = buildBriefDigest({
      report: { totalCurrentValue: 100000 },
      aiRecs: [rec({})],
      sentiment: sentiment(),
      date: new Date("2026-11-05T16:00:00"),
    });
    assert.ok(text.includes("【Richfolio 每日简报】11/5"));
    assert.ok(text.includes("情绪:分歧(3/6) 涨停84家"));
    assert.ok(text.includes("仓位:20%–30%"));
    assert.ok(text.includes("梯队:4板×2"));
    assert.ok(text.includes("闽发铝业"));
    assert.ok(text.includes("题材:光伏概念[主升]20家 主力+33.1亿 龙头闽发铝业4板"));
    assert.ok(text.includes("▪确认主升"));
    assert.ok(text.includes("AI推荐:"), "AI rec line present");
    assert.ok(text.includes("★(77%)"), "STRONG BUY star + confidence");
    assert.ok(text.includes("持仓:"));
  });

  it("still renders a usable digest without sentiment data", () => {
    const text = buildBriefDigest({
      report: { totalCurrentValue: 50000 },
      aiRecs: [],
      sentiment: null,
      date: new Date("2026-11-05T16:00:00"),
    });
    assert.ok(text.includes("【Richfolio 每日简报】11/5"));
    assert.ok(text.includes("持仓:"));
    assert.ok(!text.includes("情绪:"));
  });
});

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    assert.deepEqual(chunkText("你好", 100), ["你好"]);
  });

  it("splits long text on line boundaries without breaking a line", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `第${i}行${"内容".repeat(30)}`);
    const text = lines.join("\n");
    const chunks = chunkText(text, 900);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 900);
    // Every source line survives intact somewhere.
    for (const line of lines) {
      assert.ok(chunks.some((c) => c.includes(line)));
    }
  });

  it("handles a single over-long line by keeping it as one chunk", () => {
    const long = "字".repeat(1200);
    const chunks = chunkText(long, 900);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], long);
  });
});
