import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeLongTermLabels,
  getLongTermLabels,
} from "../src/stockLabels.js";
import type { QuoteData } from "../src/fetchPrices.js";
import type { BoardInfo } from "../src/fetchBoards.js";

// Tests run from the project root, so the DB lands in the real state/ dir —
// start each test from a clean slate.
const DB_FILE = resolve(process.cwd(), "state", "stock-labels.json");

function quote(overrides: Partial<QuoteData> = {}): QuoteData {
  return {
    ticker: "600519.SS",
    currency: "CNY",
    price: 1500,
    trailingPE: 25,
    dividendYield: 0.03,
    beta: 1,
    marketCap: 6e11,
    returnOnEquity: 0.3,
    revenueGrowth: 0.12,
    earningsGrowth: 0.15,
    ...overrides,
  } as unknown as QuoteData;
}

describe("computeLongTermLabels", () => {
  it("labels a big profitable reasonably-valued stock 白马", () => {
    const labels = computeLongTermLabels(quote(), { industry: "白酒Ⅱ", region: "", concepts: [] });
    assert.ok(labels.includes("白马"));
  });

  it("labels a fast-growing company 成长 — revenue AND earnings must confirm", () => {
    const labels = computeLongTermLabels(
      quote({ marketCap: 2e10, trailingPE: 80, revenueGrowth: 0.45, earningsGrowth: 0.35 }),
      undefined,
    );
    assert.ok(labels.includes("成长"));
    assert.ok(!labels.includes("白马"), "small cap with rich PE is not a 白马");
  });

  it("does NOT label 成长 on a revenue spike with weak earnings", () => {
    const labels = computeLongTermLabels(
      quote({ revenueGrowth: 0.45, earningsGrowth: 0.05 }),
      undefined,
    );
    assert.ok(!labels.includes("成长"), "quarterly boom ≠ durable growth");
  });

  it("does NOT label 成长 when growth data is missing", () => {
    const labels = computeLongTermLabels(
      quote({ revenueGrowth: null, earningsGrowth: null }),
      undefined,
    );
    assert.ok(!labels.includes("成长"));
  });

  it("labels cheap high-dividend stocks 价值", () => {
    const labels = computeLongTermLabels(
      quote({ trailingPE: 9, dividendYield: 0.05, revenueGrowth: 0.02 }),
      undefined,
    );
    assert.ok(labels.includes("价值"));
  });

  it("derives 周期 from a cyclical industry board", () => {
    const labels = computeLongTermLabels(
      quote(),
      { industry: "煤炭开采", region: "", concepts: [] } as BoardInfo,
    );
    assert.ok(labels.includes("周期"));
  });

  it("derives 防御 from rigid-demand industries or fat dividend + low beta", () => {
    const a = computeLongTermLabels(quote(), { industry: "电力", region: "", concepts: [] } as BoardInfo);
    assert.ok(a.includes("防御"));
    const b = computeLongTermLabels(quote({ dividendYield: 0.05, beta: 0.6 }), undefined);
    assert.ok(b.includes("防御"));
  });

  it("labels ST / loss-making stocks 绩差", () => {
    const st = computeLongTermLabels(quote({ name: "ST某某" }), undefined);
    assert.ok(st.includes("绩差"));
    const loss = computeLongTermLabels(quote({ trailingPE: -3 }), undefined);
    assert.ok(loss.includes("绩差"));
  });

  it("labels illiquid names 僵尸冷门 by daily turnover", () => {
    const labels = computeLongTermLabels(quote(), {
      industry: "",
      region: "",
      concepts: [],
      amount: 2.5e7,
    } as BoardInfo);
    assert.ok(labels.includes("僵尸冷门"));
  });
});

describe("getLongTermLabels cache", () => {
  beforeEach(() => {
    rmSync(DB_FILE, { force: true });
    mkdirSync(resolve(process.cwd(), "state"), { recursive: true });
  });

  const tickers = ["600519.SS"];
  const quotes = { "600519.SS": quote() };

  it("computes and persists, then serves from cache without recompute", () => {
    const first = getLongTermLabels(tickers, quotes, {}, 1_000_000);
    assert.ok(first["600519.SS"].length > 0, "computed on miss");

    // The quote changes (would flip labels) but the DB is still fresh — the
    // cached entry must win until the half-year TTL expires.
    quotes["600519.SS"] = quote({ marketCap: 1e9, returnOnEquity: 0.01 });
    const second = getLongTermLabels(tickers, quotes, {}, 1_000_000 + 60_000);
    assert.deepEqual(second["600519.SS"], first["600519.SS"], "fresh cache reused");
  });

  it("recomputes after the half-year TTL expires", () => {
    // The previous test left a mutated quote in the shared record — restore a
    // clean one so this test starts from the healthy fundamentals.
    quotes["600519.SS"] = quote();
    const first = getLongTermLabels(tickers, quotes, {}, 1_000_000);
    quotes["600519.SS"] = quote({ marketCap: 1e9, returnOnEquity: 0.01, trailingPE: -2 });
    const later = getLongTermLabels(
      tickers,
      quotes,
      {},
      1_000_000 + 183 * 24 * 3600 * 1000 + 60_000,
    );
    assert.ok(!later["600519.SS"].includes("白马"), "expired entry recomputed");
    assert.ok(later["600519.SS"].includes("绩差"), "new fundamentals applied");
    assert.ok(first["600519.SS"].length > 0, "sanity");
  });

  it("keeps stale labels for tickers without quote data instead of dropping", () => {
    const first = getLongTermLabels(tickers, quotes, {}, 1_000_000);
    const later = getLongTermLabels(["600519.SS"], {}, {}, 1_000_000 + 400 * 24 * 3600 * 1000);
    assert.deepEqual(later["600519.SS"], first["600519.SS"]);
  });
});
