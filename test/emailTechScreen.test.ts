import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEmailHtml } from "../src/email.js";
import type { AllocationReport } from "../src/allocation.js";
import type { AIBuyRecommendation } from "../src/providers/types.js";
import type { BoardInfo } from "../src/fetchBoards.js";
import type { TechnicalData } from "../src/technicals.js";
import type { QuoteData } from "../src/fetchPrices.js";
import type { NewsItem } from "../src/fetchNews.js";

const report: AllocationReport = {
  items: [],
  untrackedItems: [],
  watchingItems: [],
  portfolioBeta: null,
  estimatedAnnualDividend: 0,
  totalCurrentValue: 0,
};

function tech(overrides: Partial<TechnicalData> = {}): TechnicalData {
  return {
    ticker: "TEST",
    sma50: 100,
    sma200: 95,
    rsi14: 55,
    priceVsSma50: 2,
    priceVsSma200: 5,
    goldenCross: true,
    deathCross: false,
    momentumSignal: "bullish",
    recentLow7d: 95,
    recentLow30d: 90,
    volumeChange7d: null,
    macd: null,
    macdSignal: null,
    macdHistogram: null,
    macdCrossover: null,
    bollUpper: null,
    bollMiddle: null,
    bollLower: null,
    bollPercentB: null,
    bollBandwidth: null,
    bollSqueeze: false,
    atr14: null,
    atrPercent: null,
    stochK: null,
    stochD: null,
    obvTrend: null,
    pricePercentile90d: null,
    volumeLatest1d: null,
    priceChange1d: null,
    consecutiveLimitUps: 0,
    recentGain5d: null,
    yearGainPct: null,
    limitUpDays2y: 0,
    ...overrides,
  };
}

function quote(overrides: Partial<QuoteData> = {}): QuoteData {
  return {
    ticker: "TEST",
    name: null,
    longName: null,
    currency: "CNY",
    originalCurrency: "CNY",
    price: 100,
    trailingPE: 20,
    forwardPE: null,
    adjustedPE: null,
    fiftyTwoWeekHigh: 120,
    fiftyTwoWeekLow: 80,
    fiftyTwoWeekPercent: 0.5,
    marketCap: 6e10,
    dividendYield: 0.02,
    distributionYield: null,
    beta: 1,
    holdings: null,
    returnOnEquity: 0.2,
    debtToEquity: 30,
    freeCashflow: null,
    operatingCashflow: null,
    profitMargins: 0.2,
    revenueGrowth: 0.1,
    earningsGrowth: 0.1,
    targetMeanPrice: null,
    recommendationKey: null,
    postMarketPrice: null,
    preMarketPrice: null,
    earningsDate: null,
    daysToEarnings: null,
    ...overrides,
  } as QuoteData;
}

const hotNews: NewsItem[] = [
  { title: "市场热点标题", url: "", source: "东方财富", publishedAt: "2026-11-05 19:30:00" },
];

function render(
  technicals: Record<string, TechnicalData>,
  priceData: Record<string, QuoteData>,
  nationalTeam: ReadonlySet<string> = new Set(),
  boards: Record<string, BoardInfo> = {},
  longTermLabels: Record<string, string[]> = {},
): string {
  return buildEmailHtml(report, {}, [], technicals, priceData, [], hotNews, nationalTeam, boards, longTermLabels);
}

describe("hot-stock technical screen", () => {
  it("renders at the end of the brief, after the news blocks", () => {
    const html = render({ "600519.SS": tech({ ticker: "600519.SS" }) }, {
      "600519.SS": quote({ ticker: "600519.SS" }),
    });
    const screenAt = html.indexOf("热度股技术面快筛");
    assert.ok(screenAt > 0, "screen should render in watch-only mode");
    assert.ok(screenAt > html.indexOf("近 6 小时市场热点"), "screen moved after the news");
    assert.ok(screenAt > html.indexOf("AI 买入建议"), "screen moved after the AI section");
    assert.ok(screenAt < html.indexOf("Powered by Richfolio"), "screen stays above the footer");
  });

  it("flags a limit-up row red with a 涨停 chip and refuses to call it buyable", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: 10 }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("#fef2f2"), "limit-up row tint applied");
    assert.ok(html.includes("涨停·勿追"), "verdict overrides the bullish momentum");
  });

  it("flags a limit-down row green with a 跌停 chip", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: -10 }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("#f0fdf4"), "limit-down row tint applied");
    assert.ok(html.includes("跌停·勿接"), "limit-down verdict present");
  });

  it("tags a multi-day limit-up run as 妖股 with the purple accent", () => {
    const html = render(
      {
        "600519.SS": tech({
          ticker: "600519.SS",
          priceChange1d: 10,
          consecutiveLimitUps: 3,
        }),
      },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("3连板"), "streak count rendered");
    assert.ok(html.includes("#f5f3ff"), "demon-stock row tint outranks the limit-up tint");
    assert.ok(html.includes("妖股·勿追"), "demon-stock verdict");
  });

  it("tags a stock with >100% yearly gain and >15 limit-up days as 老龙头", () => {
    const html = render(
      {
        "600519.SS": tech({
          ticker: "600519.SS",
          priceChange1d: 1,
          yearGainPct: 130,
          limitUpDays2y: 18,
        }),
      },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("#fdf2f8"), "old-leader row tint applied");
    assert.ok(html.includes("老龙头"), "old-leader chip present");
  });

  it("does not tag 老龙头 when either criterion misses", () => {
    const html = render(
      {
        "600519.SS": tech({
          ticker: "600519.SS",
          priceChange1d: 1,
          yearGainPct: 130,
          limitUpDays2y: 10, // too few limit-ups
        }),
      },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(!html.includes("#fdf2f8"), "no old-leader tint");
  });

  it("tags stocks whose top holders include a national-team institution", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: 1 }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
      new Set(["600519.SS"]),
    );
    assert.ok(html.includes("#f0fdfa"), "national-team row tint applied");
    assert.ok(html.includes("国家队"), "national-team chip present");
  });

  it("tags a large, profitable, sanely valued name as 白马", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: 1 }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("#fffbeb"), "white-horse row tint applied");
    assert.ok(html.includes("白马"), "white-horse chip present");
  });

  it("leaves an ordinary row untinted and without chips", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: 1.5 }) },
      {
        "600519.SS": quote({
          ticker: "600519.SS",
          marketCap: 2e9, // too small for 白马
          returnOnEquity: 0.05,
        }),
      },
    );
    assert.ok(!html.includes("#fef2f2"), "no limit-up tint");
    assert.ok(!html.includes("#f0fdf4"), "no limit-down tint");
    assert.ok(!html.includes("#f5f3ff"), "no demon tint");
    assert.ok(!html.includes("#fffbeb"), "no white-horse tint");
    assert.ok(html.includes("可关注"));
  });

  it("upgrades to 密切关注 when two bullish signals line up", () => {
    const html = render(
      {
        "600519.SS": tech({
          ticker: "600519.SS",
          goldenCross: true,
          rsi14: 28, // oversold bounce + golden cross = 2 bullish signals
        }),
      },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("密切关注"), "tiered verdict present");
    assert.ok(html.includes("#dcfce7"), "green pill applied");
  });

  it("prefixes the tier with the short-term form (趋势中军·可关注)", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: 1.5, recentGain5d: 3 }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("趋势中军·可关注"), "form·tier format");
  });

  it("tags a heavy-bounce oversold name as 超跌反弹", () => {
    const html = render(
      {
        "600519.SS": tech({
          ticker: "600519.SS",
          goldenCross: false,
          priceVsSma50: -6,
          priceVsSma200: -10,
          recentGain5d: 8,
          volumeLatest1d: 2,
          priceChange1d: 3,
          rsi14: 45,
        }),
      },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("超跌反弹·可关注"));
  });

  it("flags a low-volume dead-cat bounce as 反抽·回避", () => {
    const html = render(
      {
        "600519.SS": tech({
          ticker: "600519.SS",
          goldenCross: false,
          priceVsSma50: -6,
          priceVsSma200: -10,
          recentGain5d: 1,
          volumeLatest1d: 0.6,
          priceChange1d: 2,
        }),
      },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(html.includes("反抽·回避"));
  });

  it("shows long-term 底色 chips from the label DB", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: 1.5 }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
      new Set(),
      {},
      { "600519.SS": ["周期", "价值"] },
    );
    assert.ok(html.includes(">周期<"), "周期 chip rendered");
    assert.ok(html.includes(">价值<"), "价值 chip rendered");
  });

  it("hides 无需关注 rows entirely from the table", () => {
    const html = render(
      {
        "600519.SS": tech({
          ticker: "600519.SS",
          goldenCross: false,
          deathCross: true,
          macdCrossover: "bearish",
        }),
      },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
    );
    assert.ok(!html.includes("600519"), "row suppressed, not rendered with a grey pill");
    assert.ok(html.includes("无需关注"), "legend still explains the hidden tier");
  });

  it("renders an industry / region / concept board column", () => {
    const html = render(
      { "600519.SS": tech({ ticker: "600519.SS" }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
      new Set(),
      {
        "600519.SS": {
          industry: "白酒Ⅱ",
          region: "贵州板块",
          concepts: ["超级品牌", "融资融券", "沪股通", "MSCI中国"],
        },
      },
    );
    assert.ok(html.includes("白酒Ⅱ · 贵州板块"), "industry and region on one line");
    assert.ok(html.includes("超级品牌 / 融资融券 / 沪股通"), "top-3 concepts shown");
    assert.ok(!html.includes("MSCI中国"), "concepts capped at three");
  });

  it("shows a dash in the board column when info is missing", () => {
    const html = render(
      { "AAPL": tech({ ticker: "AAPL" }) },
      { "AAPL": quote({ ticker: "AAPL", currency: "USD", originalCurrency: "USD" }) },
    );
    assert.ok(html.includes("<td style=\"padding:4px 3px;border-bottom:1px solid #e2e8f0;color:#1a202c;\">—</td>"));
  });

  it("carries the same chips everywhere the stock name appears in the brief", () => {
    const rec = {
      ticker: "600519.SS",
      tickerFullName: null,
      originalCurrency: "CNY",
      action: "BUY",
      confidence: 80,
      reason: "测试理由",
      suggestedBuyValue: 0,
      isWatching: true,
    };
    const news = {
      "600519.SS": [
        { title: "标题", url: "https://example.com", source: "证券时报", publishedAt: "" },
      ],
    };
    const html = buildEmailHtml(
      report,
      news,
      [rec as AIBuyRecommendation],
      { "600519.SS": tech({ ticker: "600519.SS", priceChange1d: 1, yearGainPct: 150, limitUpDays2y: 20 }) },
      { "600519.SS": quote({ ticker: "600519.SS" }) },
      [],
      hotNews,
      new Set(["600519.SS"]),
    );
    // AI card + news header + technical-screen row must all carry the tags.
    const oldLeaderCount = html.split("老龙头").length - 1;
    const nationalTeamCount = html.split("国家队").length - 1;
    assert.ok(oldLeaderCount >= 3, `老龙头 should appear ≥3 times, got ${oldLeaderCount}`);
    assert.ok(nationalTeamCount >= 3, `国家队 should appear ≥3 times, got ${nationalTeamCount}`);
    // The AI section (before the news block) must already carry the chips.
    const aiRegion = html.slice(0, html.indexOf("推荐买入标的的相关新闻"));
    assert.ok(aiRegion.includes("老龙头"), "chip renders on the AI card");
    assert.ok(aiRegion.includes("国家队"), "national-team chip renders on the AI card");
  });
});
