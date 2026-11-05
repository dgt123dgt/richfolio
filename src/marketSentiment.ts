// ── 每日情绪 — 游资情绪周期量化 (混沌 / 主升 / 退潮) ─────────────────
// Framework from the 养家 lineage of short-term traders, quantified by later
// practitioners (92科比/陈小群 conventions): 赚钱效应 drives buying, 亏钱效应
// drives selling. Daily inputs are six market-wide numbers from Eastmoney's
// public limit-up/limit-down pools, plus per-concept scoring for the hot
// themes. Thresholds are EXPERIENCE RANGES, not switches — the classifier
// counts how many criteria a phase hits and requires resonance (3+/6) before
// naming a phase; in between it reports 分歧 (intra-trend churn), which is
// what the framework prescribes instead of a hard flip.
//
// 口径 notes:
//   晋级率   = 今日连板家数 ÷ 昨日涨停总数 (yesterday's pool via the same API)
//   炸板率   = 炸板家数 ÷ (涨停 + 炸板)
//   红盘率   = 昨日涨停股今日收盘红盘比例 (batch quotes via ulist)
//   大面     = 跌停池家数 + 昨日涨停股今日跌幅≤-8% 的高位大面 (proxy for the
//              market-wide -8% scan, which needs a full-market snapshot)
//   题材     = 概念板块 via f129 of each limit-up stock (daily board cache in
//              state/, because yesterday's concepts must survive to tomorrow)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const EX_UT = "7eea3edcaed734bea9cbfc24409ed989";
const POOL_URL = (ep: string, date: string) =>
  `https://push2ex.eastmoney.com/${ep}?ut=${EX_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=600&sort=fbt%3Aasc&date=${date}`;
const ULIST_URL =
  "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f3&secids=";
const STOCK_GET_URL = "https://push2.eastmoney.com/api/qt/stock/get";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  Referer: "https://quote.eastmoney.com/",
};
const CONCURRENCY = 8;
const STATE_DIR = resolve(process.cwd(), "state");
const BOARD_CACHE_FILE = resolve(STATE_DIR, "em-board-cache.json");
/** 概念标签黑名单 — 纯流动/指数类标签，凑涨停数没有意义。 */
const CONCEPT_BLACKLIST =
  /^(融资融券|转融券标的|沪深A股|沪股通|深股通|机构重仓|社保重仓|QFII重仓|基金重仓|信托重仓|保险重仓|预盈预增|预亏预减|亏损股|微盘股|低价股|高送转|破净股|壳资源|ST股|次新股|昨日涨停|昨日连板|昨日触板|昨日涨停_含一字|MSCI中国|富时罗素|标普道琼斯A股|上证50_|上证180_|上证380_|中证500|沪深300|茅指数|宁组合|央视50_|GDR|AB股|H股|B股|AH股|股权转让|含可转债|同花顺漂亮100)/;

export interface PoolStock {
  c: string;
  m: number;
  n: string;
  lbc: number;
  zdp: number;
  hybk: string;
  zbc: number;
  /** 涨停统计 {days, ct} — days>ct 表示断过板的趋势高标 (如 12天7板). */
  zttj?: { days: number; ct: number };
}

export interface SentimentMetrics {
  /** 涨停家数 (ST/20cm 计入). */
  ztCount: number;
  /** 炸板家数. */
  zbCount: number;
  /** 跌停家数 (池). */
  dtCount: number;
  /** 全市场最高连板高度. */
  maxLbc: number;
  /** 连板晋级率 0-1: 今日连板 ÷ 昨日涨停总数. */
  promoteRate: number;
  /** 昨日涨停今日红盘率 0-1. */
  redRate: number;
  /** 跌停 + 高位大面 (昨日涨停今日≤-8%) 家数. */
  bigLossCount: number;
  /** 昨日涨停今日平均溢价 %. */
  avgPremium: number;
  /** 昨日涨停总数 (晋级率分母). */
  yesterdayZtCount: number;
}

export type MarketPhase = "主升" | "混沌" | "退潮" | "分歧";

export interface ConceptScore {
  name: string;
  /** 今日涨停数. */
  ztCount: number;
  /** 昨日涨停数 (增量对比用). */
  yCount: number;
  /** 板块内最高连板. */
  maxLbc: number;
  /** 板块昨日涨停今日平均溢价 %. */
  premium: number;
  /** A/B/C/D 加权总分 0-100 — 仅用于内部排序选 TOP3，不展示. */
  score: number;
  phase: MarketPhase | "过渡";
  /** 板块龙头 (最高连板标的). */
  leader: { name: string; lbc: number } | null;
  /** 板块主力净流入 (亿, 负=流出)；匹配不到板块时 null. */
  mainNet: number | null;
  /** 谁在买：主力大单/游资/散户承接的一句话画像. */
  buyers: string | null;
  /** 板块今日成交额 (亿) 与量能状态 — 仅 TOP3 抓取历史. */
  amount: number | null;
  amountChangePct: number | null;
  volumeState: "放量" | "缩量" | "平量" | null;
}

// ── 资金面 ──────────────────────────────────────────────────────────

export interface SectorFlow {
  name: string;
  /** 主力净流入 in 亿元 (negative = outflow). */
  net: number;
}

export interface FundFlow {
  /** 两市成交额 (亿元). */
  totalAmount: number;
  /** 较昨日 % (正=放量). */
  amountChangePct: number;
  /** 较 5 日均量 % . */
  amountVs5dAvgPct: number;
  volumeState: "放量" | "缩量" | "平量";
  /** 两市主力净流入 (亿元), today. */
  mainNet: number;
  inflowSectors: SectorFlow[];
  outflowSectors: SectorFlow[];
  /** 一句话影响判断. */
  comment: string;
}

export interface MarketSentiment {
  /** 数据日期 YYYYMMDD. */
  date: string;
  metrics: SentimentMetrics;
  phase: MarketPhase;
  /** 命中的判定条数 / 6. */
  matches: number;
  /** 该阶段的仓位口径. */
  positionHint: string;
  /** 主升/退潮各自的命中明细 (哪些指标达标). */
  detail: string[];
  concepts: ConceptScore[];
  /** 题材接力/延续提示. */
  relayHint: string | null;
  /** 资金面 (成交额放量/缩量 + 板块主力净流入/流出)；抓取失败时缺省. */
  funds?: FundFlow;
  /** 主线龙头盯防：断板/大面/停牌(核查)预警；正常时也点名龙头. */
  leaderAlert: string | null;
  /** 连板梯队分布一句话，如 "4板×2 · 3板×2 · 2板×17 · 首板63". */
  ladderText: string;
  /** 空间板名单 + 趋势人气高标 (断板趋势龙)，如 "闽发铝业(4板·光伏)". */
  spaceText: string | null;
  /** 明日三分支确认条件（确认/退化/维持），按当前阶段生成. */
  tomorrowScenarios: string[];
}

// ── Pure classification (exported for tests) ────────────────────────

/** 一个阶段命中几条判定 (0-6). */
export function phaseMatches(
  phase: MarketPhase,
  m: SentimentMetrics,
): { hits: number; detail: string[] } {
  const zbRate = m.ztCount + m.zbCount > 0 ? m.zbCount / (m.ztCount + m.zbCount) : 0;
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const checks: Array<[MarketPhase, boolean, string]> = [
    ["主升", m.ztCount >= 60, `涨停${m.ztCount}家≥60`],
    ["主升", m.maxLbc >= 5, `最高${m.maxLbc}板≥5`],
    ["主升", m.promoteRate >= 0.5, `晋级率${pct(m.promoteRate)}≥50%`],
    ["主升", zbRate < 0.3, `炸板率${pct(zbRate)}<30%`],
    ["主升", m.redRate >= 0.7, `红盘率${pct(m.redRate)}≥70%`],
    ["主升", m.bigLossCount < 10, `大面${m.bigLossCount}家<10`],
    ["退潮", m.ztCount < 30, `涨停${m.ztCount}家<30`],
    ["退潮", m.maxLbc <= 3, `最高${m.maxLbc}板≤3`],
    ["退潮", m.promoteRate < 0.35, `晋级率${pct(m.promoteRate)}<35%`],
    ["退潮", zbRate > 0.45, `炸板率${pct(zbRate)}>45%`],
    ["退潮", m.redRate < 0.5, `红盘率${pct(m.redRate)}<50%`],
    ["退潮", m.bigLossCount > 20, `大面${m.bigLossCount}家>20`],
    ["混沌", m.ztCount >= 30 && m.ztCount <= 60, `涨停${m.ztCount}家在30~60`],
    ["混沌", m.maxLbc >= 2 && m.maxLbc <= 4, `最高${m.maxLbc}板在2~4`],
    ["混沌", m.promoteRate >= 0.35 && m.promoteRate <= 0.5, `晋级率${pct(m.promoteRate)}在35%~50%`],
    ["混沌", zbRate >= 0.35 && zbRate <= 0.45, `炸板率${pct(zbRate)}在35%~45%`],
    ["混沌", m.redRate >= 0.5 && m.redRate <= 0.7, `红盘率${pct(m.redRate)}在50%~70%`],
    ["混沌", m.bigLossCount < 15, `大面${m.bigLossCount}家<15`],
  ];
  const rows = checks.filter(([p]) => p === phase);
  const detail = rows.filter(([, ok]) => ok).map(([, , label]) => label);
  return { hits: detail.length, detail };
}

const POSITION_HINTS: Record<MarketPhase, string> = {
  主升: "仓位 50%–80%：主线核心，赚钱效应扩散",
  混沌: "仓位 10%–20%：只试错，不重仓，快进快出",
  退潮: "仓位 0–10%：尽量空仓，等恐慌宣泄殆尽",
  分歧: "仓位 10%–30%：主升内震荡，看主线龙头是否被核",
};

/**
 * 多指标共振取命中最多的阶段；不足 3 条或前二并列 → 分歧（不硬判）。
 */
export function classifyMarketPhase(m: SentimentMetrics): {
  phase: MarketPhase;
  matches: number;
  detail: string[];
} {
  const scored = (["主升", "退潮", "混沌"] as MarketPhase[]).map((p) => ({
    phase: p,
    ...phaseMatches(p, m),
  }));
  scored.sort((a, b) => b.hits - a.hits);
  const top = scored[0];
  const second = scored[1];
  if (top.hits < 3 || top.hits === second.hits) {
    return { phase: "分歧", matches: top.hits, detail: top.detail };
  }
  return { phase: top.phase, matches: top.hits, detail: top.detail };
}

/** 单题材周期：主升 / 退潮 / 混沌 / 过渡（用 MarketPhase 值域之外补"过渡"）. */
export function classifyConceptPhase(c: {
  ztCount: number;
  yCount: number;
  maxLbc: number;
  premium: number;
}): MarketPhase | "过渡" {
  if (c.premium < 0 || (c.yCount > 0 && c.ztCount <= c.yCount * 0.5)) return "退潮";
  if (c.ztCount >= 7 && c.maxLbc >= 3 && c.premium >= 2) return "主升";
  if (c.ztCount >= 3 && c.maxLbc < 3) return "混沌";
  return "过渡";
}

/** A/B/C/D 加权总分: A 40 (涨停量) + B 30 (梯队) + C 20 (溢价) + D 10 (增量). */
export function scoreConcept(input: {
  ztCount: number;
  yCount: number;
  maxLbc: number;
  firstBoards: number;
  has2: boolean;
  has3: boolean;
  premium: number | null;
}): number {
  const a = Math.min(input.ztCount / 10, 1) * 40;
  const ladder =
    (input.has3 ? 15 : 0) + (input.has2 ? 8 : 0) + (Math.min(input.firstBoards, 7) / 7) * 7;
  const b = Math.min(ladder, 30);
  const c = input.premium == null ? 8 : Math.max(0, Math.min((input.premium + 2) / 4.5, 1)) * 20;
  const d = input.yCount === 0 ? 5 : input.ztCount > input.yCount ? 10 : input.ztCount === input.yCount ? 5 : 0;
  return Math.round((a + b + c + d) * 10) / 10;
}

// ── Fetching ────────────────────────────────────────────────────────

function dateStr(d: Date): string {
  const y = d.getFullYear();
  const mo = `${d.getMonth() + 1}`.padStart(2, "0");
  const da = `${d.getDate()}`.padStart(2, "0");
  return `${y}${mo}${da}`;
}

async function fetchPool(ep: string, date: string): Promise<PoolStock[]> {
  try {
    const res = await fetch(POOL_URL(ep, date), { headers: HEADERS });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { pool?: PoolStock[] } };
    return json.data?.pool ?? [];
  } catch {
    return [];
  }
}

/** 最近一个有涨停数据（即有交易）的日子；最多回看 7 天. */
async function fetchLatestPool(
  ep: string,
): Promise<{ date: string; pool: PoolStock[] } | null> {
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = dateStr(d);
    const pool = await fetchPool(ep, date);
    if (pool.length > 0) return { date, pool };
  }
  return null;
}

async function fetchPctForCodes(
  stocks: PoolStock[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (let i = 0; i < stocks.length; i += 50) {
    const batch = stocks.slice(i, i + 50);
    try {
      const res = await fetch(
        `${ULIST_URL}${batch.map((s) => `${s.m}.${s.c}`).join(",")}`,
        { headers: HEADERS },
      );
      const json = (await res.json()) as {
        data?: { diff?: Array<{ f12: string; f3: number | "-" }> };
      };
      for (const row of json.data?.diff ?? []) {
        out.set(row.f12, typeof row.f3 === "number" ? row.f3 : null);
      }
    } catch {
      /* batch failed — those stocks count as suspended */
    }
  }
  return out;
}

interface BoardCache {
  [date: string]: { [code: string]: string[] };
}

function loadBoardCache(): BoardCache {
  try {
    if (!existsSync(BOARD_CACHE_FILE)) return {};
    return JSON.parse(readFileSync(BOARD_CACHE_FILE, "utf8")) as BoardCache;
  } catch {
    return {};
  }
}

function saveBoardCache(cache: BoardCache, keepDates: string[]): void {
  const trimmed: BoardCache = {};
  for (const d of keepDates) if (cache[d]) trimmed[d] = cache[d];
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(BOARD_CACHE_FILE, JSON.stringify(trimmed, null, 2));
}

/** 概念列表 (f129)，按日期缓存到 state/ — 昨日的板块归属明天还要用. */
async function fetchConcepts(
  date: string,
  stocks: PoolStock[],
  keepDates: string[],
): Promise<Map<string, string[]>> {
  const cache = loadBoardCache();
  const dayCache = cache[date] ?? {};
  const out = new Map<string, string[]>();
  const missing = stocks.filter((s) => dayCache[s.c] == null);

  const queue = [...missing];
  async function worker(): Promise<void> {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      try {
        const res = await fetch(
          `${STOCK_GET_URL}?secid=${s.m}.${s.c}&fields=f129`,
          { headers: HEADERS },
        );
        if (!res.ok) {
          dayCache[s.c] = [];
          continue;
        }
        const json = (await res.json()) as { data?: { f129?: string } };
        const raw = typeof json.data?.f129 === "string" ? json.data.f129 : "";
        dayCache[s.c] = raw
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x && !CONCEPT_BLACKLIST.test(x));
      } catch {
        dayCache[s.c] = [];
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
  );

  cache[date] = dayCache;
  saveBoardCache(cache, keepDates);
  for (const s of stocks) out.set(s.c, dayCache[s.c] ?? []);
  return out;
}

function groupByConcept(
  stocks: PoolStock[],
  concepts: Map<string, string[]>,
): Map<string, PoolStock[]> {
  const groups = new Map<string, PoolStock[]>();
  for (const s of stocks) {
    for (const c of concepts.get(s.c) ?? []) {
      const arr = groups.get(c) ?? [];
      arr.push(s);
      groups.set(c, arr);
    }
  }
  return groups;
}

// ── 资金面 helpers (pure, tested) ───────────────────────────────────

/**
 * 放量/缩量判定：单日环比 ±8% 且 5 日均量同向，或相对 5 日均量 ±20%。
 * 单日反弹但整体仍低于 5 日均量时不算放量（昨日地量后的正常回升归为缩量）。
 */
export function classifyVolumeState(
  changePct: number,
  vs5dPct: number,
): FundFlow["volumeState"] {
  if (changePct >= 8 && vs5dPct >= 0) return "放量";
  if (changePct <= -8 && vs5dPct <= 0) return "缩量";
  if (vs5dPct >= 20) return "放量";
  if (vs5dPct <= -20) return "缩量";
  return "平量";
}

/** 资金面 × 情绪影响一句话判断. */
export function buildFundComment(
  state: FundFlow["volumeState"],
  mainNet: number,
): string {
  if (state === "放量" && mainNet > 0)
    return "放量且主力净流入：增量资金助推，赚钱效应有扩散基础，情绪看高一线";
  if (state === "放量" && mainNet < 0)
    return "放量但主力净流出：分歧加大，高位兑现盘沉重，警惕冲高回落";
  if (state === "缩量" && mainNet > 0)
    return "缩量但主力净流入：存量资金回流修复，持续性待次日确认";
  if (state === "缩量" && mainNet < 0)
    return "缩量且主力净流出：承接乏力，情绪冰点或继续降温，防守为主";
  return mainNet > 0
    ? "量能平稳、主力净流入：情绪温和延续，跟随主线即可"
    : "量能平稳、主力净流出：观望情绪升温，等待方向选择";
}

/**
 * 明日三分支确认条件 — 按当前阶段列出「确认升级 / 退化降级 / 原地维持」各自
 * 的量化门槛，让分歧日有明确的分水岭可跟踪，而不是只给一个静态标签.
 */
export function buildTomorrowScenarios(phase: MarketPhase): string[] {
  switch (phase) {
    case "主升":
      return [
        "确认延续：涨停维持 ≥60，晋级率 ≥50%，炸板率 <30% 同时成立",
        "转分歧：涨停回落至 30–60 或炸板率抬升至 35–45%",
        "转退潮：涨停跌破 30、晋级率 <35% 或出现批量 -8% 大面",
      ];
    case "分歧":
      return [
        "确认主升：涨停回升 ≥60，晋级率站上 50%，炸板率回落 <30%，最高板继续打开高度",
        "重回退潮：涨停继续下滑 <30，或高位批量断板、出现批量 -8% 大面",
        "维持混沌：涨停 30–60 徘徊，炸板率维持 35–45% 高位，题材继续轮动",
      ];
    case "混沌":
      return [
        "转主升：一条主线连续两天保持梯队（涨停 ≥60、晋级率 ≥50%）",
        "维持混沌：题材每日轮换、梯队断层，无板块连续两天走强",
        "转退潮：涨停跌破 30 且昨日涨停红盘率 <50%",
      ];
    case "退潮":
      return [
        "修复转分歧：涨停回升 ≥30，大面停止扩散，炸板率回落",
        "继续退潮：涨停继续萎缩，晋级率 <35%，大面 >20 持续抬升",
        "冰点反转：恐慌宣泄殆尽后出现批量首板 + 红盘率显著回升",
      ];
  }
}

/** 连板梯队分布 + 空间板 + 趋势人气高标 (纯函数, 测试用). */
export function describeLadder(pool: PoolStock[]): {
  ladderText: string;
  spaceText: string | null;
} {
  if (pool.length === 0) return { ladderText: "", spaceText: null };
  const dist = new Map<number, number>();
  for (const s of pool) dist.set(s.lbc, (dist.get(s.lbc) ?? 0) + 1);
  const maxLbc = Math.max(...dist.keys());
  const ladder = [...dist.keys()]
    .sort((a, b) => b - a)
    .map((l) => (l === 1 ? `首板${dist.get(l)}` : `${l}板×${dist.get(l)}`))
    .join(" · ");

  const space = pool
    .filter((s) => s.lbc === maxLbc)
    .slice(0, 3)
    .map((s) => `${s.n}（${s.lbc}板${s.hybk ? `·${s.hybk}` : ""}）`)
    .join("、");

  const stars = pool
    .filter((s) => s.zttj && s.zttj.ct >= 3 && s.zttj.days > s.zttj.ct)
    .sort((a, b) => (b.zttj!.ct ?? 0) - (a.zttj!.ct ?? 0))
    .slice(0, 2)
    .map((s) => `${s.n} ${s.zttj!.days}天${s.zttj!.ct}板`);

  const spaceText = stars.length > 0 ? `${space}；趋势高标：${stars.join("、")}` : space;
  return { ladderText: ladder, spaceText: spaceText || null };
}

// ── 资金面 fetching ─────────────────────────────────────────────────

const KLINE_URL = (secid: string) =>
  `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f57&klt=101&fqt=1&end=20500101&lmt=6`;
const FFLOW_URL = (secid: string) =>
  `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=2&klt=101&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52`;
const SECTOR_FLOW_URL = (po: 0 | 1) =>
  `https://push2.eastmoney.com/api/qt/clist/get?fid=f62&po=${po}&pz=8&pn=1&np=1&fltt=2&invt=2&fs=m:90+t:2+f:!50&fields=f14,f62`;

/** 偶发 IPv6 连接超时 — 同一请求重试几次，仍失败则放弃（栏目降级）. */
async function fetchRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch {
      /* retry */
    }
  }
  return null;
}

async function fetchDailyAmounts(secid: string): Promise<number[]> {
  return (
    (await fetchRetry(async () => {
      const res = await fetch(KLINE_URL(secid), { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: { klines?: string[] } };
      const rows = json.data?.klines ?? [];
      return rows.map((r) => Number(r.split(",")[1]));
    })) ?? []
  );
}

async function fetchMainFlow(secid: string): Promise<number | null> {
  return fetchRetry(async () => {
    const res = await fetch(FFLOW_URL(secid), { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { klines?: string[] } };
    const rows = json.data?.klines ?? [];
    if (rows.length === 0) return null;
    // Last bar = today; f52 is 主力净流入 in 元.
    return Number(rows[rows.length - 1].split(",")[1]) / 1e8;
  });
}

async function fetchSectorFlows(po: 0 | 1): Promise<SectorFlow[]> {
  return (
    (await fetchRetry(async () => {
      const res = await fetch(SECTOR_FLOW_URL(po), { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        data?: { diff?: Array<{ f14: string; f62: number }> };
      };
      return (json.data?.diff ?? []).map((d) => ({
        name: d.f14,
        net: Math.round((d.f62 / 1e8) * 10) / 10,
      }));
    })) ?? []
  );
}

const YI = 1e8; // 元 → 亿元

/** 汇总两市成交/主力资金/行业板块流入流出；任一关键数据缺失返回 null. */
export async function fetchFundFlow(): Promise<FundFlow | null> {
  const [shAmt, szAmt, shNet, szNet, inflow, outflow] = await Promise.all([
    fetchDailyAmounts("1.000001"),
    fetchDailyAmounts("0.399001"),
    fetchMainFlow("1.000001"),
    fetchMainFlow("0.399001"),
    fetchSectorFlows(1),
    fetchSectorFlows(0),
  ]);
  if (shAmt.length < 2 || szAmt.length < 2) return null;

  const dailyTotals = shAmt.map((a, i) => a + (szAmt[i] ?? 0));
  const today = dailyTotals[dailyTotals.length - 1] / YI;
  const prev = dailyTotals[dailyTotals.length - 2] / YI;
  const base5 =
    dailyTotals.slice(-6, -1).reduce((a, b) => a + b, 0) /
    Math.max(dailyTotals.slice(-6, -1).length, 1) / YI;
  const amountChangePct = prev > 0 ? Math.round(((today - prev) / prev) * 1000) / 10 : 0;
  const amountVs5dAvgPct =
    base5 > 0 ? Math.round(((today - base5) / base5) * 1000) / 10 : 0;
  const mainNet = (shNet ?? 0) + (szNet ?? 0);
  const volumeState = classifyVolumeState(amountChangePct, amountVs5dAvgPct);

  return {
    totalAmount: Math.round(today * 10) / 10,
    amountChangePct,
    amountVs5dAvgPct,
    volumeState,
    mainNet: Math.round(mainNet * 10) / 10,
    inflowSectors: inflow.slice(0, 3),
    outflowSectors: outflow.slice(0, 3),
    comment: buildFundComment(volumeState, mainNet),
  };
}

/** 谁在买 — 由主力/超大单/大单净额推断资金画像 (纯函数, 测试用). */
export function describeBuyers(
  mainNet: number,
  superNet: number,
  bigNet: number,
): string {
  if (Math.abs(mainNet) < 2) return "主力资金分歧不大，方向未定";
  if (mainNet > 0) {
    if (superNet > 0) return "超大单主导买入（机构/顶级游资加仓），散户在卖";
    if (bigNet > 0) return "游资中坚资金接力买入，超大单观望";
    return "主力小幅回流，力度一般";
  }
  return "主力净流出、散户资金承接——注意兑现风险";
}

interface ConceptFlowRow {
  bk: string;
  mainNet: number;
  superNet: number;
  bigNet: number;
  amount: number;
}

/** 全量概念板块资金流 (含超大/大单拆分与成交额), name→row. */
async function fetchConceptFlowIndex(): Promise<Map<string, ConceptFlowRow>> {
  const out = new Map<string, ConceptFlowRow>();
  for (let pn = 1; pn <= 7; pn++) {
    const rows = await fetchRetry(() =>
      fetch(
        `https://push2.eastmoney.com/api/qt/clist/get?fid=f62&po=1&pz=100&pn=${pn}&np=1&fltt=2&invt=2&fs=m:90+t:3+f:!50&fields=f12,f14,f62,f66,f72,f6`,
        { headers: HEADERS },
      ).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          data?: { diff?: Array<{ f12: string; f14: string; f62: number; f66: number; f72: number; f6: number }> };
        };
        return json.data?.diff ?? [];
      }),
    );
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      out.set(r.f14, {
        bk: r.f12,
        mainNet: r.f62 / YI,
        superNet: r.f66 / YI,
        bigNet: r.f72 / YI,
        amount: r.f6 / YI,
      });
    }
  }
  return out;
}

/** 板块成交额历史 (今日/昨日/5日均) → 放量百分比. */
async function fetchBoardAmountStats(
  bk: string,
): Promise<{ amount: number; changePct: number; vs5dPct: number } | null> {
  const amounts = await fetchRetry(async () => {
    const res = await fetch(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.${bk}&fields1=f1,f2,f3,f7&fields2=f51,f57&klt=101&fqt=1&end=20500101&lmt=6`,
      { headers: HEADERS },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { klines?: string[] } };
    return (json.data?.klines ?? []).map((r) => Number(r.split(",")[1]) / YI);
  });
  if (!amounts || amounts.length < 2) return null;
  const today = amounts[amounts.length - 1];
  const prev = amounts[amounts.length - 2];
  const base5 = amounts.slice(-6, -1).reduce((a, b) => a + b, 0) / Math.max(amounts.slice(-6, -1).length, 1);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    amount: r1(today),
    changePct: prev > 0 ? r1(((today - prev) / prev) * 100) : 0,
    vs5dPct: base5 > 0 ? r1(((today - base5) / base5) * 100) : 0,
  };
}

/** f129 概念名 → 资金流行 (精确匹配, 再退到去"概念"后缀的模糊匹配). */
function matchConceptFlow(
  name: string,
  index: Map<string, ConceptFlowRow>,
): ConceptFlowRow | null {
  const exact = index.get(name);
  if (exact) return exact;
  const stem = name.replace(/概念$/, "");
  for (const [bkName, row] of index) {
    if (bkName.replace(/概念$/, "") === stem) return row;
  }
  return null;
}

// ── Orchestration ───────────────────────────────────────────────────

/**
 * Fetch and classify today's sentiment cycle. Returns null when the pools are
 * unavailable (non-trading day / API down) so the brief simply omits the block.
 */
export async function fetchMarketSentiment(): Promise<MarketSentiment | null> {
  const today = await fetchLatestPool("getTopicZTPool");
  if (!today || today.pool.length === 0) return null;
  const zb = await fetchPool("getTopicZBPool", today.date);
  const dt = await fetchPool("getTopicDTPool", today.date);

  // Yesterday = the latest trading day strictly before the data date.
  let yesterday: { date: string; pool: PoolStock[] } | null = null;
  const base = today.date;
  for (let i = 1; i <= 10 && !yesterday; i++) {
    const d = new Date(
      Number(base.slice(0, 4)),
      Number(base.slice(4, 6)) - 1,
      Number(base.slice(6, 8)) - i,
    );
    const date = dateStr(d);
    const pool = await fetchPool("getTopicZTPool", date);
    if (pool.length > 0) yesterday = { date, pool };
  }

  const pctMap = yesterday ? await fetchPctForCodes(yesterday.pool) : new Map();
  const withPct = [...pctMap.values()].filter((v): v is number => v != null);
  const redRate =
    withPct.length > 0 ? withPct.filter((v) => v > 0).length / withPct.length : 0;
  const avgPremium =
    withPct.length > 0 ? withPct.reduce((a, b) => a + b, 0) / withPct.length : 0;
  const highBigLoss = yesterday
    ? yesterday.pool.filter((s) => (pctMap.get(s.c) ?? 0) <= -8).length
    : 0;

  const keepDates = [today.date, yesterday?.date].filter(Boolean) as string[];
  const todayConcepts = await fetchConcepts(today.date, today.pool, keepDates);
  const yConcepts = yesterday
    ? await fetchConcepts(yesterday.date, yesterday.pool, keepDates)
    : new Map<string, string[]>();

  const lbcDist = today.pool.map((s) => s.lbc);
  const metrics: SentimentMetrics = {
    ztCount: today.pool.length,
    zbCount: zb.length,
    dtCount: dt.length,
    maxLbc: Math.max(0, ...lbcDist),
    promoteRate:
      yesterday && yesterday.pool.length > 0
        ? lbcDist.filter((x) => x >= 2).length / yesterday.pool.length
        : 0,
    redRate,
    bigLossCount: dt.length + highBigLoss,
    avgPremium,
    yesterdayZtCount: yesterday?.pool.length ?? 0,
  };

  const cls = classifyMarketPhase(metrics);

  // Concept scoring.
  const todayGroups = groupByConcept(today.pool, todayConcepts);
  const yGroups = groupByConcept(yesterday?.pool ?? [], yConcepts);
  const concepts: ConceptScore[] = [];
  for (const [name, stocks] of todayGroups) {
    const yStocks = yGroups.get(name) ?? [];
    const yPcts = yStocks.map((s) => pctMap.get(s.c)).filter((v): v is number => v != null);
    const premium =
      yPcts.length > 0 ? yPcts.reduce((a, b) => a + b, 0) / yPcts.length : null;
    const maxLbc = Math.max(...stocks.map((s) => s.lbc));
    const input = {
      ztCount: stocks.length,
      yCount: yStocks.length,
      maxLbc,
      firstBoards: stocks.filter((s) => s.lbc === 1).length,
      has2: stocks.some((s) => s.lbc === 2),
      has3: stocks.some((s) => s.lbc >= 3),
      premium,
    };
    if (input.ztCount < 3) continue; // 太弱的板块不值得展示
    const score = scoreConcept(input);
    const phase = classifyConceptPhase({ ...input, premium: premium ?? 0 });
    const leaderStock = [...stocks].sort((a, b) => b.lbc - a.lbc)[0] ?? null;
    concepts.push({
      name,
      ztCount: input.ztCount,
      yCount: input.yCount,
      maxLbc: input.maxLbc,
      premium: premium ?? 0,
      score,
      phase,
      leader: leaderStock ? { name: leaderStock.n, lbc: leaderStock.lbc } : null,
      mainNet: null,
      buyers: null,
      amount: null,
      amountChangePct: null,
      volumeState: null,
    });
  }
  concepts.sort((a, b) => b.score - a.score);
  // Display order: raw limit-up count first (score stays internal for TOP3
  // selection only — the weight formula is not shown in the brief).
  const top3 = concepts.slice(0, 3).sort((a, b) => b.ztCount - a.ztCount || b.premium - a.premium);

  // Relay hint: yesterday's biggest theme vs today's top scorer.
  let relayHint: string | null = null;
  const yTop = [...yGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const todayTop = top3[0]?.name;
  if (todayTop && yTop && todayTop !== yTop && top3[0].ztCount >= 8 && top3[0].maxLbc >= 3) {
    relayHint = `注意接力信号：${todayTop} 正在卡位旧主线 ${yTop}（昨日涨停${yGroups.get(yTop)?.length ?? 0}家 → 今日转弱）——明日确认：${todayTop} 涨停维持 ≥${top3[0].ztCount} 家且龙头不断板；若资金回流 ${yTop} 则卡位失败，重回轮动`;
  } else if (todayTop && yTop && todayTop === yTop) {
    relayHint = `主线延续：${todayTop}（昨日涨停${yGroups.get(yTop)?.length ?? 0}家 → 今日${top3[0].ztCount}家）`;
  }

  // 主线龙头盯防 — the 仓位 hint says "看主线龙头是否被核", so name the leader
  // and check its state: 继续涨停 / 断板回落 / 大面(被核) / 停牌(核查风险).
  // The leader is yesterday's biggest theme's highest-board stock; today's
  // pool membership + its quote tell which state it is in.
  let leaderAlert: string | null = null;
  const yLeaderGroup = yTop ? yGroups.get(yTop) : undefined;
  const leaderPool = yLeaderGroup ?? (top3[0] ? todayGroups.get(top3[0].name) : undefined);
  if (leaderPool && leaderPool.length > 0) {
    const leader = [...leaderPool].sort((a, b) => b.lbc - a.lbc)[0];
    const themeLabel = yTop ?? top3[0]?.name ?? "";
    const inToday = today.pool.find((s) => s.c === leader.c);
    if (inToday) {
      leaderAlert = `主线龙头：${leader.n}（${themeLabel} · ${leader.lbc}板→今日${inToday.lbc}板）继续涨停，梯队完好`;
    } else {
      const pct = pctMap.get(leader.c);
      const label = `${leader.n}（${themeLabel} · 昨${leader.lbc}板）`;
      if (pct == null) {
        leaderAlert = `⚠ 主线龙头 ${label} 今日停牌——警惕停牌核查/监管风险，题材高度或受限`;
      } else if (pct <= -8) {
        leaderAlert = `⚠ 主线龙头 ${label} 今日大面 ${pct.toFixed(1)}%，已被核——谨防板块批量退潮，勿抄底`;
      } else if (pct < 0) {
        leaderAlert = `⚠ 主线龙头 ${label} 今日断板回落 ${pct.toFixed(1)}%——赚钱效应收缩，注意分歧`;
      } else {
        leaderAlert = `主线龙头 ${label} 今日断板（+${pct.toFixed(1)}%）——梯队断层，观察低位能否承接`;
      }
    }
  }

  // 题材资金画像: 主力/超大单拆分 + TOP3 板块成交额放量幅度.
  if (top3.length > 0) {
    const flowIndex =
      (await fetchConceptFlowIndex().catch(() => null)) ??
      new Map<string, ConceptFlowRow>();
    await Promise.all(
      top3.map(async (c) => {
        const flow = matchConceptFlow(c.name, flowIndex);
        if (!flow) return;
        c.mainNet = Math.round(flow.mainNet * 10) / 10;
        c.buyers = describeBuyers(flow.mainNet, flow.superNet, flow.bigNet);
        const stats = await fetchBoardAmountStats(flow.bk).catch(() => null);
        if (stats) {
          c.amount = stats.amount;
          c.amountChangePct = stats.changePct;
          c.volumeState = classifyVolumeState(stats.changePct, stats.vs5dPct);
        }
      }),
    );
  }

  // 梯队结构 + 空间板 + 趋势人气高标.
  const { ladderText, spaceText } = describeLadder(today.pool);

  // 资金面 — failure degrades to a missing funds row, never kills the section.
  const funds = await fetchFundFlow().catch(() => null);

  // 分歧日的仓位口径看亏钱效应是否扩散：大面少 + 主力资金未撤退 →
  // 压到 20–30% 只做辨识度龙头；否则维持保守默认。
  let positionHint = POSITION_HINTS[cls.phase];
  if (
    cls.phase === "分歧" &&
    metrics.bigLossCount <= 5 &&
    (funds?.mainNet ?? 0) > 0
  ) {
    positionHint = "仓位 20%–30%：只做辨识度龙头，不批量扫低位首板";
  }

  return {
    date: today.date,
    metrics,
    phase: cls.phase,
    matches: cls.matches,
    positionHint,
    detail: cls.detail,
    concepts: top3,
    relayHint,
    leaderAlert,
    ladderText,
    spaceText,
    tomorrowScenarios: buildTomorrowScenarios(cls.phase),
    ...(funds ? { funds } : {}),
  };
}
