// ── National-team shareholder flags (Eastmoney F10) ─────────────────
// The "国家队" tag marks stocks whose top shareholders include sovereign
// institutions: 汇金/证金 (the two stabilisation vehicles), 社保 (the National
// Social Security Fund), 基本养老保险 and 中国国新. Data source: Eastmoney's
// F10 ShareholderResearch endpoint — latest top-10 holders and top-10 free-float
// holders, one request per stock, keyless.

const EASTMONEY_F10_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax";
const KEYWORD_RE = /(汇金|证金|社保|养老|国新|平准)/;
const CONCURRENCY = 6;

/** config ticker ("600519.SS") → Eastmoney code ("SH600519"); null for non-A-shares. */
function toEastmoneyCode(ticker: string): string | null {
  const m = ticker.match(/^(\d{6})\.(SS|SZ)$/);
  if (!m) return null;
  return (m[2] === "SS" ? "SH" : "SZ") + m[1];
}

interface F10Holder {
  HOLDER_NAME?: string;
}

async function hasNationalTeamHolder(code: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${EASTMONEY_F10_URL}?code=${code}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://emweb.securities.eastmoney.com/",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      sdltgd?: F10Holder[];
      sdgd?: F10Holder[];
    };
    const names = [...(json.sdltgd ?? []), ...(json.sdgd ?? [])]
      .map((h) => h.HOLDER_NAME ?? "")
      .filter(Boolean);
    return names.some((n) => KEYWORD_RE.test(n));
  } catch {
    return null;
  }
}

/**
 * Returns the tickers whose latest top-10 holder lists include a national-team
 * institution. Failures are tolerated per-ticker (the stock just stays untagged)
 * so a flaky F10 endpoint can never break the brief.
 */
export async function fetchNationalTeamFlags(
  tickers: string[],
): Promise<Set<string>> {
  const flagged = new Set<string>();
  const queue = tickers.map((t) => ({ ticker: t, code: toEastmoneyCode(t) }));

  async function worker(): Promise<void> {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      if (!job.code) continue;
      const hit = await hasNationalTeamHolder(job.code);
      if (hit) flagged.add(job.ticker);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
  );
  if (flagged.size > 0) {
    console.log(`  National-team holders: ${flagged.size} stock(s) flagged`);
  }
  return flagged;
}
