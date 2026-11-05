import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEmailHtml } from "../src/email.js";
import type { AllocationReport } from "../src/allocation.js";
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
): string {
  return buildEmailHtml(report, {}, [], technicals, priceData, [], hotNews, nationalTeam);
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
});
