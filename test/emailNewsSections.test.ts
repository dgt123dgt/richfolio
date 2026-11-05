import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEmailHtml } from "../src/email.js";
import type { AllocationReport } from "../src/allocation.js";
import type { AIBuyRecommendation } from "../src/providers/types.js";
import type { NewsItem } from "../src/fetchNews.js";
import type { QuoteData } from "../src/fetchPrices.js";

const report: AllocationReport = {
  items: [],
  untrackedItems: [],
  watchingItems: [],
  portfolioBeta: null,
  estimatedAnnualDividend: 0,
  totalCurrentValue: 0,
};

function rec(ticker: string, action: string): AIBuyRecommendation {
  return {
    ticker,
    tickerFullName: null,
    originalCurrency: "CNY",
    action,
    confidence: 80,
    reason: "测试理由",
    suggestedBuyValue: 0,
    isWatching: true,
  } as AIBuyRecommendation;
}

const newsItem = (title: string): NewsItem => ({
  title,
  url: "https://example.com/a",
  source: "证券时报",
  publishedAt: "2026-11-05 10:00:00",
});

describe("buildEmailHtml news sections", () => {
  const news: Record<string, NewsItem[]> = {
    "600519.SS": [newsItem("贵州茅台三季报超预期")],
    "000001.SZ": [newsItem("平安银行再融资获批")],
  };
  const aiRecs = [rec("600519.SS", "BUY"), rec("000001.SZ", "WAIT")];
  const priceData: Record<string, QuoteData> = {
    "600519.SS": { ticker: "600519.SS", price: 1500, currency: "CNY" } as unknown as QuoteData,
    "000001.SZ": { ticker: "000001.SZ", price: 12, currency: "CNY" } as unknown as QuoteData,
  };
  const hotNews: NewsItem[] = [
    {
      ...newsItem("央行开展5000亿元MLF操作，净投放3000亿元"),
      publishedAt: "2026-11-05 19:30:00",
    },
  ];

  it("shows per-ticker news only for AI BUY calls", () => {
    const html = buildEmailHtml(report, news, aiRecs, {}, priceData, [], hotNews);
    assert.ok(html.includes("推荐买入标的的相关新闻"));
    assert.ok(html.includes("贵州茅台三季报超预期"), "buy ticker news should render");
    assert.ok(!html.includes("平安银行再融资获批"), "non-buy ticker news must be filtered out");
  });

  it("renders the 6-hour market hot news block", () => {
    const html = buildEmailHtml(report, news, aiRecs, {}, priceData, [], hotNews);
    assert.ok(html.includes("近 6 小时市场热点"));
    assert.ok(html.includes("央行开展5000亿元MLF操作"));
    assert.ok(html.includes("19:30"), "hot news shows its time");
  });

  it("annotates each hot flash with plain 利好大盘 phrasing", () => {
    const html = buildEmailHtml(report, news, aiRecs, {}, priceData, [], hotNews);
    assert.ok(html.includes("利好大盘"), "plain-text scope phrasing");
    assert.ok(!html.includes("影响："), "no wrapper label");
  });

  it("shows current price on AI cards", () => {
    const html = buildEmailHtml(report, news, aiRecs, {}, priceData, [], hotNews);
    assert.ok(html.includes("现价"));
    assert.ok(html.includes("1,500"), "buy card carries the live price");
  });

  it("omits both news blocks when there is nothing to show", () => {
    const html = buildEmailHtml(report, {}, [rec("600519.SS", "HOLD")], {}, priceData, [], []);
    assert.ok(!html.includes("推荐买入标的的相关新闻"));
    assert.ok(!html.includes("近 6 小时市场热点"));
  });
});
