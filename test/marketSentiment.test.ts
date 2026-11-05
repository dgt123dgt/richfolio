import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMarketPhase,
  classifyConceptPhase,
  scoreConcept,
  phaseMatches,
  classifyVolumeState,
  buildFundComment,
  type SentimentMetrics,
} from "../src/marketSentiment.js";

function metrics(overrides: Partial<SentimentMetrics> = {}): SentimentMetrics {
  return {
    ztCount: 84,
    zbCount: 48,
    dtCount: 0,
    maxLbc: 4,
    promoteRate: 0.18,
    redRate: 0.81,
    bigLossCount: 1,
    avgPremium: 4.5,
    yesterdayZtCount: 118,
    ...overrides,
  };
}

describe("classifyMarketPhase", () => {
  it("calls 主升 when breadth, ladder, promotion and premium all line up", () => {
    const m = metrics({
      ztCount: 85,
      maxLbc: 6,
      promoteRate: 0.55,
      zbCount: 10,
      redRate: 0.75,
      bigLossCount: 3,
    });
    const r = classifyMarketPhase(m);
    assert.equal(r.phase, "主升");
    assert.ok(r.matches >= 5);
  });

  it("calls 退潮 when the ladder collapses and losses spread", () => {
    const m = metrics({
      ztCount: 18,
      maxLbc: 2,
      promoteRate: 0.2,
      zbCount: 30,
      redRate: 0.3,
      bigLossCount: 25,
    });
    const r = classifyMarketPhase(m);
    assert.equal(r.phase, "退潮");
  });

  it("calls 混沌 when everything sits in the middling ranges", () => {
    const m = metrics({
      ztCount: 45,
      maxLbc: 3,
      promoteRate: 0.42,
      zbCount: 20,
      redRate: 0.6,
      bigLossCount: 5,
    });
    const r = classifyMarketPhase(m);
    assert.equal(r.phase, "混沌");
  });

  it("reports 分歧 instead of a hard flip on conflicting signals", () => {
    // 涨停 84 (主升 range) but promotion collapsed (退潮 range) — resonance fails.
    const r = classifyMarketPhase(metrics());
    assert.equal(r.phase, "分歧");
  });
});

describe("scoreConcept", () => {
  it("rewards a full ladder, fat premium and rising count near the 100 cap", () => {
    const s = scoreConcept({
      ztCount: 12,
      yCount: 8,
      maxLbc: 4,
      firstBoards: 8,
      has2: true,
      has3: true,
      premium: 8,
    });
    assert.ok(s >= 95, `score ${s}`);
  });

  it("scores an all-first-board pulse far below a real ladder", () => {
    const pulse = scoreConcept({
      ztCount: 10,
      yCount: 2,
      maxLbc: 1,
      firstBoards: 10,
      has2: false,
      has3: false,
      premium: 0,
    });
    const ladder = scoreConcept({
      ztCount: 10,
      yCount: 2,
      maxLbc: 4,
      firstBoards: 6,
      has2: true,
      has3: true,
      premium: 3,
    });
    assert.ok(pulse < ladder * 0.8, `pulse ${pulse} vs ladder ${ladder}`);
  });

  it("treats a shrinking theme as weak on the D component", () => {
    const rising = scoreConcept({ ztCount: 6, yCount: 2, maxLbc: 2, firstBoards: 4, has2: true, has3: false, premium: 2 });
    const falling = scoreConcept({ ztCount: 6, yCount: 10, maxLbc: 2, firstBoards: 4, has2: true, has3: false, premium: 2 });
    assert.ok(rising > falling, `rising ${rising} vs falling ${falling}`);
  });
});

describe("classifyConceptPhase", () => {
  it("marks a theme with leader, ladder and fat premium as 题材主升", () => {
    const r = classifyConceptPhase({ ztCount: 12, yCount: 9, maxLbc: 4, premium: 8 });
    assert.equal(r, "主升");
  });

  it("marks negative premium as 退潮 even with many limit-ups", () => {
    const r = classifyConceptPhase({ ztCount: 12, yCount: 15, maxLbc: 4, premium: -3 });
    assert.equal(r, "退潮");
  });

  it("marks a count halved from yesterday as 退潮", () => {
    const r = classifyConceptPhase({ ztCount: 4, yCount: 12, maxLbc: 2, premium: 1 });
    assert.equal(r, "退潮");
  });

  it("marks first-board-only small themes as 混沌", () => {
    const r = classifyConceptPhase({ ztCount: 4, yCount: 4, maxLbc: 1, premium: 0.5 });
    assert.equal(r, "混沌");
  });
});

describe("phaseMatches detail labels", () => {
  it("lists the human-readable criteria that hit", () => {
    const m = metrics({ ztCount: 85 });
    const r = phaseMatches("主升", m);
    assert.ok(r.detail.some((d) => d.includes("涨停85家")));
  });
});

describe("classifyVolumeState", () => {
  it("calls 放量 on a ≥8% daily surge with non-negative 5d base", () => {
    assert.equal(classifyVolumeState(12, 5), "放量");
    assert.equal(classifyVolumeState(10, 30), "放量");
  });

  it("calls 缩量 on a ≥8% drop or a deep 5d-avg contraction", () => {
    assert.equal(classifyVolumeState(-15, -5), "缩量");
    assert.equal(classifyVolumeState(-3, -25), "缩量");
  });

  it("keeps a dead-volume bounce out of 放量", () => {
    // +9% day-over-day but still 25% under the 5-day average → still dry.
    assert.equal(classifyVolumeState(9, -25), "缩量");
  });

  it("treats small moves as 平量", () => {
    assert.equal(classifyVolumeState(3, 8), "平量");
  });
});

describe("buildFundComment", () => {
  it("pairs volume state and main-force direction into distinct verdicts", () => {
    assert.ok(buildFundComment("放量", 120).includes("增量资金"));
    assert.ok(buildFundComment("放量", -120).includes("分歧"));
    assert.ok(buildFundComment("缩量", 120).includes("存量"));
    assert.ok(buildFundComment("缩量", -120).includes("冰点"));
    assert.ok(buildFundComment("平量", 30).includes("温和"));
    assert.ok(buildFundComment("平量", -30).includes("观望"));
  });
});
