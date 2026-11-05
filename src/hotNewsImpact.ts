// ── Hot-flash impact classifier (利好/利空 + scope) ─────────────────
// Each market-wide flash under 近 6 小时市场热点 gets a one-line readout of
// what it probably helps or hurts and at what granularity: the whole market
// (大盘), an industry board (板块), a concept board (概念), or a single
// stock (个股). Rule-based on purpose — the feed is free-form prose and the
// readout must be instant, offline-safe and free, so keyword lists here trade
// a little precision for zero cost and zero latency.

export interface HotNewsImpact {
  /** "利好" / "利空" — null when no directional keyword appears. */
  impact: "利好" | "利空" | null;
  /** Scope labels, e.g. ["大盘"], ["板块 银行"], ["概念 低空经济"], ["个股 生益科技"]. */
  scopes: string[];
}

/** Industry boards — keyword → display label. */
const INDUSTRY_KEYWORDS: Array<[RegExp, string]> = [
  [/银行/, "银行"],
  [/保险/, "保险"],
  [/券商|证券|基金/, "券商·基金"],
  [/房地产|楼市|地产/, "房地产"],
  [/半导体|芯片|晶圆|存储/, "半导体"],
  [/医药|医疗|疫苗|创新药/, "医药"],
  [/白酒|食品|饮料/, "食品饮料"],
  [/汽车|车企|整车/, "汽车"],
  [/光伏|锂电|储能|风电|新能源/, "新能源"],
  [/军工|国防|航天/, "军工"],
  [/煤炭/, "煤炭"],
  [/钢铁|钢材/, "钢铁"],
  [/有色|黄金|铜|稀土/, "有色金属"],
  [/电力|电网|核电/, "电力"],
  [/生猪|养殖|农业|种业/, "农业"],
  [/游戏|传媒|影视|文化/, "传媒"],
  [/软件|信创|计算机/, "计算机"],
  [/通信|运营商|光模块/, "通信"],
  [/航运|港口|物流|快递/, "交运物流"],
  [/化工|化学品/, "化工"],
  [/机械|设备制造/, "机械设备"],
  [/家电|白色家电/, "家电"],
  [/旅游|酒店|免税/, "旅游消费"],
  [/基建|工程机械|水泥/, "基建"],
];

/** Concept boards — keyword → display label. */
const CONCEPT_KEYWORDS: Array<[RegExp, string]> = [
  [/人工智能|大模型|AI/, "AI"],
  [/算力|数据中心|GPU/, "算力"],
  [/机器人|人形机器人/, "机器人"],
  [/低空经济|无人机|eVTOL/, "低空经济"],
  [/数据要素|数字经济/, "数据要素"],
  [/华为|鸿蒙|欧拉/, "华为链"],
  [/苹果|iPhone|Vision Pro/, "苹果链"],
  [/固态电池/, "固态电池"],
  [/氢能|燃料电池/, "氢能"],
  [/智能驾驶|无人驾驶|自动驾驶/, "智能驾驶"],
  [/国产替代|自主可控|国产化/, "国产替代"],
  [/商业卫星|卫星互联网|北斗/, "卫星互联网"],
  [/区块链|数字货币|数字人民币/, "数字货币"],
  [/元宇宙|虚拟现实|VR|AR/, "XR"],
  [/充电桩|换电/, "充换电"],
  [/跨境电商|外贸|出口/, "跨境贸易"],
];

/** Whole-market signals — policy or index-level vocabulary. */
const MARKET_KEYWORDS =
  /(A股|沪深|两市|沪指|深成指|创业板指|科创|北证|大盘|市场情绪|成交量|成交额|北向资金|外资|涨停家数|跌停家数|央行|证监会|国务院|财政部|发改委|国资委|金融监管|降准|降息|LPR|MLF|逆回购|公开市场|货币政策|财政政策|印花税|IPO|再融资|限售解禁|美联储|加息|汇率|人民币)/;

/** Directional vocabulary. Positive hits outweigh negatives of the same count. */
const POSITIVE_KEYWORDS =
  /(利好|降准|降息|净投放|加大|加力|出台|支持|加快|扩大|补贴|减税|免税|退税|免征|超预期|增长|预增|扭亏|回购|增持|中标|签约|获批|突破|新高|提升|提振|上涨|回暖|复苏|放宽|松绑|激励|分红|业绩增长|净流入)/;
const NEGATIVE_KEYWORDS =
  /(利空|收紧|限制|上调(?!.*目标)|处罚|罚款|立案|调查|警示|减持|质押|爆仓|下滑|下降|下降|亏损|预亏|暴雷|退市|破发|下跌|回调|回落|风险|警告|加征|关税|制裁|封禁|处罚|警示函|监管函|问询|冻结)/;

/**
 * Stock names we know about (watch list + AI recs), used to tag 个股 scope.
 * A Chinese run of text immediately followed by a full-width colon is also
 * treated as a company name — Eastmoney flash headlines commonly open with
 * "生益科技：三季度净利润预增234%".
 */
export function detectStockScopes(title: string, knownNames: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of knownNames) {
    if (name && name.length >= 2 && title.includes(name)) out.push(name);
  }
  const colonMatch = title.match(/([\u4e00-\u9fa5]{2,8})(?=[：:])/);
  const candidate = colonMatch?.[1];
  if (candidate && !out.includes(candidate)) {
    // Skip obvious non-company tokens that can precede a colon.
    if (!/^(快讯|重磅|突发|独家|快评|直击|数据|预告|提醒|盘前|盘中|收盘|开盘|证监会|央行|国务院|财政部|发改委|国资委|交易所|上交所|深交所|北交所|金融监管总局|国家统计局|人社部|商务部|工信部)$/.test(candidate)) {
      out.push(candidate);
    }
  }
  return out.slice(0, 2);
}

/**
 * Classify one flash item. Scopes degrade gracefully: no specific scope found
 * but market-level (or no) vocabulary present → the item is read as 大盘.
 */
export function classifyHotNewsImpact(
  title: string,
  summary: string,
  knownNames: Iterable<string> = [],
): HotNewsImpact {
  const text = `${title} ${summary}`;

  const scopes: string[] = [];
  for (const name of detectStockScopes(title, knownNames)) scopes.push(`个股 ${name}`);
  for (const [re, label] of INDUSTRY_KEYWORDS) {
    if (re.test(text) && !scopes.some((s) => s.includes(label))) scopes.push(`板块 ${label}`);
  }
  for (const [re, label] of CONCEPT_KEYWORDS) {
    if (re.test(text) && !scopes.some((s) => s.includes(label))) scopes.push(`概念 ${label}`);
  }
  if (scopes.length === 0) scopes.push("大盘");
  else if (MARKET_KEYWORDS.test(text) && scopes.every((s) => !s.startsWith("板块") && !s.startsWith("概念"))) {
    // Policy / index vocabulary with no sector hit — market-wide first.
    scopes.unshift("大盘");
  }

  const pos = (text.match(new RegExp(POSITIVE_KEYWORDS, "g")) ?? []).length;
  const neg = (text.match(new RegExp(NEGATIVE_KEYWORDS, "g")) ?? []).length;
  const impact = pos > neg ? "利好" : neg > pos ? "利空" : null;

  return { impact, scopes: scopes.slice(0, 4) };
}
