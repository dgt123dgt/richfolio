// Renders a sample daily-brief email with mock data so layout changes can be
// reviewed in a browser without sending an email or running the pipeline.
import { writeFileSync } from "node:fs";
import { buildEmailHtml } from "../src/email.js";
// Preview fidelity: production fills runtimeTickerNames from the Guba hot-stock
// ranking, so the bold text on every card is the Chinese name. Populate the
// same way here, otherwise display names fall back to the raw symbol.
import { runtimeTickerNames } from "../src/config.js";
import { computeLongTermLabels } from "../src/stockLabels.js";
import { fetchMarketSentiment } from "../src/marketSentiment.js";
import type { BoardInfo } from "../src/fetchBoards.js";
import type { AIBuyRecommendation } from "../src/providers/types.js";
import type { TechnicalData } from "../src/technicals.js";
import type { QuoteData } from "../src/fetchPrices.js";
import type { NewsItem } from "../src/fetchNews.js";
import type { AllocationReport } from "../src/allocation.js";

// Same names the Guba ranking would supply at runtime.
Object.assign(runtimeTickerNames, {
  "600183.SS": "生益科技",
  "002463.SZ": "深南电路",
  "000651.SZ": "格力电器",
  "601398.SS": "工商银行",
  "600519.SS": "贵州茅台",
  "601988.SS": "中国银行",
  "601318.SS": "中国平安",
});

const report: AllocationReport = {
  items: [],
  untrackedItems: [],
  watchingItems: [],
  portfolioBeta: null,
  estimatedAnnualDividend: 0,
  totalCurrentValue: 0,
};

function rec(t: string, action: string, confidence: number): AIBuyRecommendation {
  return {
    ticker: t,
    tickerFullName: null,
    originalCurrency: "CNY",
    action,
    confidence,
    reason:
      "52w 位置 19%、价格低于 200MA 且价格层信号一致；RSI 24.2、Stochastic 12.9、%B 0.09 三重超卖确认。Trailing P/E 24.8、ROE 37.3%、盈利同比 +234.1%。",
    suggestedBuyValue: 0,
    isWatching: true,
    providers: [
      { providerId: "gemini", providerLabel: "Gemini", providerShortLabel: "G", action: action === "STRONG BUY" ? "STRONG BUY" : "BUY", confidence, reason: "超卖区基本面 ROE 高，估值合理，有显著的技术修复空间。", suggestedBuyValue: 0 },
      { providerId: "deepseek", providerLabel: "DeepSeek", providerShortLabel: "D", action, confidence: confidence - 3, reason: "与 002463 同属深度超卖+高盈利质量的组合。", suggestedBuyValue: 0 },
    ],
    agreement: "unanimous",
  } as AIBuyRecommendation;
}

function tech(t: string, overrides: Partial<TechnicalData> = {}): TechnicalData {
  return {
    ticker: t,
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
    priceChange1d: 1.2,
    consecutiveLimitUps: 0,
    recentGain5d: 3,
    yearGainPct: 40,
    limitUpDays2y: 4,
    ...overrides,
  };
}

function quote(t: string, price: number, overrides: Partial<QuoteData> = {}): QuoteData {
  return {
    ticker: t,
    name: null,
    longName: null,
    currency: "CNY",
    originalCurrency: "CNY",
    price,
    trailingPE: 24.8,
    forwardPE: 13.5,
    adjustedPE: null,
    fiftyTwoWeekHigh: 120,
    fiftyTwoWeekLow: 80,
    fiftyTwoWeekPercent: 0.45,
    marketCap: 6e10,
    dividendYield: 0.02,
    distributionYield: null,
    beta: 1,
    holdings: null,
    returnOnEquity: 0.37,
    debtToEquity: 30,
    freeCashflow: null,
    operatingCashflow: null,
    profitMargins: 0.25,
    revenueGrowth: 0.12,
    earningsGrowth: 2.34,
    targetMeanPrice: 187,
    recommendationKey: "buy",
    postMarketPrice: null,
    preMarketPrice: null,
    earningsDate: null,
    daysToEarnings: null,
    ...overrides,
  } as QuoteData;
}

const newsItem = (title: string, source: string): NewsItem => ({
  title,
  url: "https://example.com",
  source,
  publishedAt: "2026-11-05 10:00:00",
});

const aiRecs = [
  rec("600183.SS", "STRONG BUY", 77),
  rec("002463.SZ", "BUY", 66),
  rec("000651.SZ", "HOLD", 55),
];

const news: Record<string, NewsItem[]> = {
  "600183.SS": [newsItem("生益科技三季报超预期，覆铜板提价落地", "证券时报")],
  "002463.SZ": [newsItem("深南电路 AI 服务器 PCB 订单饱满", "上海证券报")],
};

const technicals: Record<string, TechnicalData> = {
  "600183.SS": tech("600183.SS", { rsi14: 24, priceChange1d: -1.2, yearGainPct: 120, limitUpDays2y: 18 }),
  "002463.SZ": tech("002463.SZ", { rsi14: 25 }),
  "000651.SZ": tech("000651.SZ", { rsi14: 60 }),
  "601398.SS": tech("601398.SS", { priceChange1d: 0.4 }),
  "600519.SS": tech("600519.SS", { priceChange1d: 10.03, consecutiveLimitUps: 2, rsi14: 82 }),
  "601988.SS": tech("601988.SS", { priceChange1d: -10.01 }),
  "601318.SS": tech("601318.SS", { priceChange1d: 2.1 }),
};

const priceData: Record<string, QuoteData> = {
  "600183.SS": quote("600183.SS", 18.55),
  "002463.SZ": quote("002463.SZ", 32.1),
  "000651.SZ": quote("000651.SZ", 45.2),
  "601398.SS": quote("601398.SS", 6.12),
  "600519.SS": quote("600519.SS", 1500, { marketCap: 1.8e12, dividendYield: 0.034, returnOnEquity: 0.34, trailingPE: 22 }),
  "601988.SS": quote("601988.SS", 5.02),
  "601318.SS": quote("601318.SS", 58.3, { marketCap: 1e12, returnOnEquity: 0.12, trailingPE: 9 }),
};

const hotNews: NewsItem[] = [
  { title: "央行开展 5000 亿元 MLF 操作，净投放 3000 亿元", url: "https://example.com", source: "财联社", publishedAt: "2026-11-05 19:30:00" },
  { title: "证监会：进一步优化融券机制", url: "https://example.com", source: "上证报", publishedAt: "2026-11-05 18:55:00" },
];

// 板块 column sample data — mirrors Eastmoney f127/f128/f129.
const boards: Record<string, BoardInfo> = {
  "600183.SS": { industry: "元件", region: "广东板块", concepts: ["5G概念", "华为概念", "PCB", "存储芯片", "通信技术"] },
  "002463.SZ": { industry: "元件", region: "广东板块", concepts: ["PCB概念", "ChatGPT概念", "苹果概念"] },
  "000651.SZ": { industry: "白色家电", region: "广东板块", concepts: ["消费电器", "智能家居", "超级品牌"] },
  "601398.SS": { industry: "银行Ⅱ", region: "北京板块", concepts: ["参股银行", "跨境支付", "互联网金融"] },
  "600519.SS": { industry: "白酒Ⅱ", region: "贵州板块", concepts: ["超级品牌", "融资融券", "沪股通"] },
  "601988.SS": { industry: "银行Ⅱ", region: "北京板块", concepts: ["参股银行", "沪股通"] },
  "601318.SS": { industry: "保险Ⅱ", region: "广东板块", concepts: ["参股银行", "沪股通", "富时罗素概念"] },
};

// Long-term 底色 labels — same rules the live run caches into the DB.
const longTermLabels: Record<string, string[]> = {};
for (const t of Object.keys(priceData)) {
  longTermLabels[t] = computeLongTermLabels(priceData[t], boards[t]);
}

// 每日情绪 — real market data (pools are keyless), falls back to null off-hours.
const sentiment = await fetchMarketSentiment().catch(() => null);

const html = buildEmailHtml(
  report,
  news,
  aiRecs,
  technicals,
  priceData,
  [],
  hotNews,
  new Set(["601398.SS"]),
  boards,
  longTermLabels,
  sentiment,
);

writeFileSync("smoke/email-preview.html", html, "utf8");
console.log("written smoke/email-preview.html", html.length, "bytes");
