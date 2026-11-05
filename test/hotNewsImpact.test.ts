import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyHotNewsImpact, detectStockScopes } from "../src/hotNewsImpact.js";

describe("classifyHotNewsImpact", () => {
  it("reads a central-bank liquidity injection as bullish and market-wide", () => {
    const r = classifyHotNewsImpact("央行开展5000亿元MLF操作，净投放3000亿元", "");
    assert.equal(r.impact, "利好");
    assert.deepEqual(r.scopes, ["大盘"]);
  });

  it("tags 个股 scope from known names and colon-prefixed company names", () => {
    const r = classifyHotNewsImpact("生益科技：前三季度净利润预增234%", "", ["生益科技"]);
    assert.equal(r.impact, "利好");
    assert.ok(r.scopes.some((s) => s === "个股 生益科技"));
  });

  it("does not treat regulators as individual stocks", () => {
    assert.deepEqual(detectStockScopes("证监会：进一步优化融券机制", []), []);
  });

  it("separates industry and concept scopes in one item", () => {
    const r = classifyHotNewsImpact(
      "半导体设备国产化替代进程加快，产业链公司订单增长",
      "",
    );
    assert.equal(r.impact, "利好");
    assert.ok(r.scopes.includes("板块 半导体"), JSON.stringify(r.scopes));
    assert.ok(r.scopes.includes("概念 国产替代"), JSON.stringify(r.scopes));
    assert.ok(!r.scopes.includes("大盘"), "specific scopes replace the fallback");
  });

  it("reads investigations and penalties as bearish for that stock", () => {
    const r = classifyHotNewsImpact(
      "鹏都农牧：涉嫌信披违规被证监会立案调查",
      "",
    );
    assert.equal(r.impact, "利空");
    assert.ok(r.scopes.some((s) => s.startsWith("个股")));
  });

  it("falls back to 大盘 when nothing specific matches", () => {
    const r = classifyHotNewsImpact("两市成交额突破1.8万亿元", "");
    assert.ok(r.scopes.includes("大盘"));
  });

  it("returns a null impact when no directional vocabulary appears", () => {
    const r = classifyHotNewsImpact("某基金公司发布新产品公告", "");
    assert.equal(r.impact, null);
  });
});
