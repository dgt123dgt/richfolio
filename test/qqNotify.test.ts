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
  it("renders full sections: sentiment, funds, themes, news, buys, portfolio", () => {
    const text = buildBriefDigest({
      report: { totalCurrentValue: 100000, items: [{}] as never[] },
      aiRecs: [rec({ reason: "放量突破平台，题材主线地位明确，回踩均线可分批建仓" })],
      sentiment: sentiment({
        funds: {
          totalAmount: 21000,
          amountChangePct: 3.2,
          amountVs5dAvgPct: 12,
          volumeState: "放量",
          mainNet: 39,
          inflowSectors: [{ name: "电力设备", net: 63 }],
          outflowSectors: [{ name: "元件", net: -67 }],
          comment: "增量资金助推，情绪看高一线",
        },
      }),
      hotNews: [
        { title: "央行宣布降准0.5个百分点", publishedAt: "2026-11-05T09:00:00", source: "x", url: "" } as NewsItem,
      ],
      date: new Date("2026-11-05T16:00:00"),
    });
    assert.ok(text.includes("【Richfolio 每日简报】11/5"));
    assert.ok(text.includes("〔市场情绪〕"));
    assert.ok(text.includes("周期:分歧(命中3/6)｜涨停84家"));
    assert.ok(text.includes("仓位建议:20%–30%"));
    assert.ok(text.includes("梯队:4板×2"));
    assert.ok(text.includes("空间板:闽发铝业（4板·工业金属）"));
    assert.ok(text.includes("主线龙头：闽发铝业"));
    assert.ok(text.includes("〔资金面〕"));
    assert.ok(text.includes("两市成交21000亿"));
    assert.ok(text.includes("主力净流入 +39亿"));
    assert.ok(text.includes("流入:电力设备+63亿"));
    assert.ok(text.includes("流出:元件-67亿"));
    assert.ok(text.includes("〔热门题材〕"));
    assert.ok(text.includes("1.光伏概念[主升] 涨停20家 最高4板"));
    assert.ok(text.includes("谁在买:超大单主导"));
    assert.ok(text.includes("▪明日:确认主升"));
    assert.ok(text.includes("〔市场热点〕"));
    assert.ok(text.includes("央行宣布降准"), "headline present");
    assert.ok(text.includes("利好"), "impact phrase present");
    assert.ok(text.includes("〔AI 推荐〕"));
    assert.ok(text.includes("★") && text.includes("(77%)"), "STRONG BUY star + confidence");
    assert.ok(text.includes("理由:放量突破平台"));
    assert.ok(text.includes("〔持仓〕"));
    assert.ok(text.includes("（1 只标的）"));
  });

  it("still renders a usable digest without sentiment data", () => {
    const text = buildBriefDigest({
      report: { totalCurrentValue: 50000, items: [] },
      aiRecs: [],
      sentiment: null,
      date: new Date("2026-11-05T16:00:00"),
    });
    assert.ok(text.includes("【Richfolio 每日简报】11/5"));
    assert.ok(text.includes("〔持仓〕"));
    assert.ok(!text.includes("〔市场情绪〕"));
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
