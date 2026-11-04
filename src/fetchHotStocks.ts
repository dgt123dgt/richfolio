// ── Daily hot A-share stocks (Eastmoney Guba popularity ranking) ────
// The user's portfolio is built from OTC-fund→ETF mappings, so it contains
// almost no single stocks. This module injects the day's most-discussed
// stocks (Guba 人气榜, the ranking retail traders actually watch) into the
// watch list so the AI also scores them. Both endpoints are keyless public
// web APIs mirrored from eastmoney.com pages.

import { runtimeTickerNames } from "./config.js";

const RANK_URL = "https://emappdata.eastmoney.com/stockrank/getAllCurrentList";
const NAME_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get";
// Over-fetch: thresholded-board codes get filtered out before taking `count`.
const RANK_FETCH_SIZE = 50;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  Referer: "https://guba.eastmoney.com/",
};

export interface HotStock {
  ticker: string;
  name: string;
  rank: number;
}

/**
 * Only SH/SZ main board (600/601/603/605, 000/001/002/003) — boards an ordinary
 * cash account can trade without thresholds:
 *   创业板 300/301/302 — needs 2y experience + ¥100k; 科创板 688/689 — ¥500k;
 *   北交所 (BJ prefix / 4/8/9 codes) — ¥500k, dropped by toConfigTicker already.
 */
function isMainBoard(sc: string): boolean {
  if (sc.startsWith("SH")) return /^60[0135]/.test(sc.slice(2));
  if (sc.startsWith("SZ")) return /^00[0-3]/.test(sc.slice(2));
  return false;
}

/** "SH600519" → "600519.SS", "SZ000651" → "000651.SZ". BJ (北交所) etc. → null. */
function toConfigTicker(sc: string): string | null {
  if (sc.startsWith("SH")) return `${sc.slice(2)}.SS`;
  if (sc.startsWith("SZ")) return `${sc.slice(2)}.SZ`;
  return null;
}

/**
 * Fetch the current Guba popularity ranking and resolve Chinese names.
 * Populates `runtimeTickerNames` so emails and Eastmoney news keywords
 * immediately use the Chinese name. Throws on rank failure — callers decide
 * whether to degrade gracefully.
 */
export async function fetchHotAshareStocks(count: number): Promise<HotStock[]> {
  const res = await fetch(RANK_URL, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: "appId01",
      globalId: "786e4c21-70dc-435a-93bb-38",
      marketType: "",
      pageNo: 1,
      pageSize: RANK_FETCH_SIZE,
    }),
  });
  if (!res.ok) throw new Error(`Guba rank ${res.status}`);

  const json = (await res.json()) as { data?: Array<{ sc: string; rk: number }> };
  const rows = (json.data ?? []).filter((row) => isMainBoard(row.sc));

  const stocks: HotStock[] = [];
  for (const row of rows) {
    const ticker = toConfigTicker(row.sc);
    if (!ticker) continue;
    stocks.push({ ticker, name: "", rank: row.rk });
    if (stocks.length >= count) break;
  }
  if (stocks.length === 0) return [];

  // Batch-resolve Chinese names via Eastmoney quotes (secids: 1.=SH, 0.=SZ).
  const secids = stocks
    .map((s) => `${s.ticker.endsWith(".SS") ? "1" : "0"}.${s.ticker.slice(0, 6)}`)
    .join(",");
  try {
    const nameRes = await fetch(`${NAME_URL}?fltt=2&fields=f12,f14&secids=${secids}`, {
      headers: { ...HEADERS, Referer: "https://quote.eastmoney.com/" },
    });
    if (!nameRes.ok) throw new Error(`names ${nameRes.status}`);
    const nameJson = (await nameRes.json()) as {
      data?: { diff?: Array<{ f12: string; f14: string }> } | null;
    };
    const codeToName = new Map<string, string>();
    for (const d of nameJson.data?.diff ?? []) {
      if (d.f12 && d.f14) codeToName.set(d.f12, d.f14);
    }
    for (const s of stocks) {
      const name = codeToName.get(s.ticker.slice(0, 6));
      if (name) {
        s.name = name;
        runtimeTickerNames[s.ticker] = name;
      }
    }
  } catch (err) {
    // Names are cosmetic — ranking still works with Yahoo's fallback name.
    console.warn(`  ⚠ Hot-stock name lookup failed: ${(err as Error).message}`);
  }

  return stocks;
}
