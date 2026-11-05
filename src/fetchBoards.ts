// ── Per-stock board info (industry / concepts / region) ────────────
// The tech-screen table gets a 板块 column like the Eastmoney app's 盘口·关联
// panel. One keyless request per stock returns all of it in one shot:
//   f127 → 行业板块 (元件), f128 → 地域板块 (广东板块),
//   f129 → 概念板块, comma-separated (5G概念,华为概念,PCB…),
//   f6   → 当日成交额 (CNY) — used by the long-term 僵尸冷门 label.
// ulist batching cannot be used here — under fltt the same field ids carry
// price-change values instead of names — so we go per-stock with a small pool.

const STOCK_GET_URL = "https://push2.eastmoney.com/api/qt/stock/get";
const CONCURRENCY = 8;

export interface BoardInfo {
  /** 行业板块, e.g. "元件". */
  industry: string;
  /** 地域板块, e.g. "广东板块". */
  region: string;
  /** 概念板块 list, e.g. ["5G概念", "华为概念", "PCB"]. */
  concepts: string[];
  /** 当日成交额 in CNY (f6) — feeds the 僵尸冷门 long-term label. */
  amount?: number;
}

/** config ticker ("600183.SS") → Eastmoney secid ("1.600183"); null for non-A-shares. */
function toSecid(ticker: string): string | null {
  const m = ticker.match(/^(\d{6})\.(SS|SZ)$/);
  if (!m) return null;
  return `${m[2] === "SS" ? "1" : "0"}.${m[1]}`;
}

interface BoardPayload {
  data?: {
    f127?: string | number;
    f128?: string | number;
    f129?: string | number;
    f6?: number;
  };
}

async function fetchOne(secid: string): Promise<BoardInfo | null> {
  try {
    const res = await fetch(
      `${STOCK_GET_URL}?secid=${secid}&fields=f127,f128,f129,f6`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Referer: "https://quote.eastmoney.com/",
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as BoardPayload;
    const d = json.data;
    if (!d) return null;
    const industry = typeof d.f127 === "string" ? d.f127 : "";
    const region = typeof d.f128 === "string" ? d.f128 : "";
    const concepts =
      typeof d.f129 === "string" ? d.f129.split(",").filter(Boolean) : [];
    const amount = typeof d.f6 === "number" && d.f6 > 0 ? d.f6 : undefined;
    if (!industry && !region && concepts.length === 0 && amount == null) return null;
    return { industry, region, concepts, amount };
  } catch {
    return null;
  }
}

/**
 * Board info for every A-share ticker in the list; failures and non-A-share
 * tickers are simply absent from the result so the email column renders "—".
 */
export async function fetchStockBoards(
  tickers: string[],
): Promise<Record<string, BoardInfo>> {
  const out: Record<string, BoardInfo> = {};
  const queue = tickers
    .map((t) => ({ ticker: t, secid: toSecid(t) }))
    .filter((j): j is { ticker: string; secid: string } => j.secid != null);

  async function worker(): Promise<void> {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const info = await fetchOne(job.secid);
      if (info) out[job.ticker] = info;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
  );
  if (Object.keys(out).length > 0) {
    console.log(`  Board info fetched for ${Object.keys(out).length} stock(s)`);
  }
  return out;
}
