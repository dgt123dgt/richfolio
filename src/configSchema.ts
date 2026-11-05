import { parseCryptoPair } from "./fetchCrypto.js";
import type { CryptoPairSpec } from "./fetchCrypto.js";

// Pure config.json validation and defaults: no file I/O, no dotenv, no
// process.env. Lives apart from config.ts so the web app's config.json
// importer applies exactly the rules the pipeline does, and so it can be
// unit-tested (config.ts throws at import time without a config.json, and CI
// has none). Same pure/wrapper split as allocation.ts/analyze.ts.

export const SUPPORTED_CURRENCIES: readonly string[] = [
  "USD",
  "GBP",
  "EUR",
  "AUD",
  "CAD",
  "JPY",
  "CHF",
  "HKD",
  "SGD",
  "NZD",
  "CNY",
];

// ── Types ───────────────────────────────────────────────────────────
export interface IntradayAlertConfig {
  enabled: boolean;
  confidenceIncreaseThreshold: number;
  minConfidenceToAlert: number;
  actionUpgradesAlert: boolean;
  onlyAlertForActions: string[];
  /**
   * Frozen-data guard. Intraday technical indicators come from daily chart
   * candles that only update at the US close, and every intraday run fires
   * while the US market is shut — so the indicators are identical between runs.
   * An action/confidence flip with no material price move is therefore AI
   * scoring noise, not a real signal. Suppress any alert whose ticker moved
   * less than this % (absolute) versus the morning baseline price. Set to 0 to
   * disable and alert on every change (legacy behaviour).
   */
  minPriceMovePctToAlert: number;
}

export interface PortfolioConfig {
  targetPortfolio: Record<string, number>;
  currentHoldings: Record<string, number>;
  totalPortfolioValue: number;
  defaultCurrency?: string;
  /**
   * Optional ticker → display-name map (e.g. "513180.SS": "恒生科技ETF").
   * Rendered alongside the raw symbol in emails/console so human readers can
   * identify each position. Falls back to the quote's longName, then the ticker.
   */
  tickerNames?: Record<string, string>;
  /** Daily hot-stock tracking (Guba popularity). See HotStocksConfig. */
  hotStocks?: HotStocksConfig;
  intradayAlerts?: Partial<IntradayAlertConfig>;
  /**
   * Tickers tracked but NOT in your target portfolio. They get fetched, scored,
   * and surfaced in a "Watch List" section, but are excluded from allocation
   * math, gap-based STRONG BUY criteria, and the max-2 STRONG BUY cap. Use this
   * for tickers you're researching without committing to a target weight.
   */
  watching?: string[];
  /**
   * Crypto cross-pairs to watch, as `"BASE/QUOTE"` — "the price of BASE
   * denominated in QUOTE", i.e. the thing you're buying over the thing you're
   * spending. `"BTC/CRO"` means "what one BTC costs in CRO", the number you want
   * low before converting CRO into BTC.
   *
   * Priced from crypto.com's keyless public API rather than Yahoo, which does not
   * carry these markets. Direction is resolved from the exchange's own instrument
   * metadata, so either listing direction works and adding a pair is a
   * config-only change.
   *
   * Watch-only by construction: no target weight, no allocation gap, no suggested
   * buy size.
   */
  watchingCrypto?: string[];
  /** Alert thresholds for the high-cadence `--crypto` mode. */
  cryptoAlerts?: Partial<IntradayAlertConfig>;
  /**
   * Public social posting (X / Facebook Page / LinkedIn Page). Posts are
   * generic — STRONG BUY / BUY signals only, no holdings or allocation data.
   * Each platform additionally gates on its own env credentials, so leaving
   * keys unset skips that platform regardless of this toggle.
   */
  social?: SocialConfig;
  /** AI provider behaviour. */
  ai?: AIConfig;
}

export interface AIConfig {
  /**
   * Opt in to strict unanimity for STRONG BUY. Default **false**.
   *
   * Off (default), two rules apply. A multi-provider STRONG BUY survives while
   * every dissenter is within one rung (a dissenting BUY) or STRONG BUY is a majority, and caps at BUY as
   * soon as one is further out (HOLD/WAIT) — see computeConsensusAction. And on
   * a degraded run (2+ configured, not all answered) the survivor's STRONG BUY
   * stands, since a provider that never answered isn't a dissenter.
   *
   * On, both revert to the original hard cap: any dissent, or any missing
   * provider, demotes STRONG BUY to BUY.
   *
   * Either way the reader is told what happened — the per-provider breakdown, the
   * agreement badge and the `⚠ n/m AI` degradation badge all render regardless.
   * Only the capping is optional.
   *
   * Has no effect when only one provider is configured: that setup never
   * promised agreement, so it is not degraded.
   */
  strongBuyRequiresAllProviders?: boolean;
  /** Consensus vote weight per provider id, 1–10 (e.g. `{ "mistral": 2 }`); unset ids use providers/modelRank.ts. */
  providerRanks?: Record<string, number>;
}

export interface SocialConfig {
  /** Master kill-switch. When false, no platform is posted to. Default: true. */
  enabled?: boolean;
  /**
   * Include the analysis link in X posts. Off by default because a link
   * raises X's pay-per-use cost (~$0.20 vs ~$0.015 per post).
   */
  includeLinkInX?: boolean;
  /**
   * Generic hashtags appended (with the ticker hashtags) on Facebook / Threads
   * / LinkedIn posts to boost discoverability. The leading "#" is optional.
   * Not added on X (cashtags are native there and the 280-char budget is tight).
   */
  hashtags?: string[];
}

export const DEFAULT_ALERTS: IntradayAlertConfig = {
  enabled: true,
  confidenceIncreaseThreshold: 10,
  minConfidenceToAlert: 80,
  actionUpgradesAlert: true,
  onlyAlertForActions: ["STRONG BUY", "BUY"],
  minPriceMovePctToAlert: 1.0,
};

export interface HotStocksConfig {
  /** Inject the day's Guba-popularity top-N A-share stocks into the watch list. Default true. */
  enabled?: boolean;
  /** How many hot stocks to track (1-20). Default 10. */
  count?: number;
}

export const DEFAULT_HOT_STOCKS: Required<HotStocksConfig> = {
  enabled: true,
  count: 10,
};

export interface ParsedConfig {
  targetPortfolio: Record<string, number>;
  currentHoldings: Record<string, number>;
  totalPortfolioValue: number;
  defaultCurrency: string;
  tickerNames: Record<string, string>;
  hotStocks: Required<HotStocksConfig>;
  watchingTickers: string[];
  cryptoPairSpecs: CryptoPairSpec[];
  intradayAlerts: IntradayAlertConfig;
  cryptoAlerts: IntradayAlertConfig;
  social: SocialConfig;
  ai: AIConfig;
  /** Non-fatal problems. config.ts prints them; the web importer shows them. */
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberMap(json: Record<string, unknown>, key: string, required: boolean) {
  const value = json[key];
  if (value === undefined && !required) return {};
  if (!isPlainObject(value)) {
    throw new Error(`config.json: "${key}" must be an object of ticker → number.`);
  }
  for (const [ticker, n] of Object.entries(value)) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new Error(`config.json: "${key}.${ticker}" must be a number.`);
    }
  }
  return value as Record<string, number>;
}

export function parsePortfolioConfig(json: unknown): ParsedConfig {
  if (!isPlainObject(json)) throw new Error("config.json must be a JSON object.");
  const warnings: string[] = [];

  // Portfolio tracking is now optional: omit both maps for a pure watch-list
  // setup (e.g. hot-stock screening), where no allocation math or money stats
  // are computed.
  const targetPortfolio = numberMap(json, "targetPortfolio", false);
  const currentHoldings = numberMap(json, "currentHoldings", false);

  const rawWatching = json.watching;
  if (rawWatching !== undefined && !Array.isArray(rawWatching)) {
    throw new Error('config.json: "watching" must be an array of ticker symbols.');
  }
  const watchingTickers = Array.isArray(rawWatching)
    ? rawWatching.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];

  // Malformed pairs are warned about and skipped rather than thrown: one typo
  // should not take down a run that has other pairs to report on.
  const rawWatchingCrypto = json.watchingCrypto;
  if (rawWatchingCrypto !== undefined && !Array.isArray(rawWatchingCrypto)) {
    throw new Error('config.json: "watchingCrypto" must be an array of "BASE/QUOTE" strings.');
  }
  const cryptoPairSpecs = (Array.isArray(rawWatchingCrypto) ? rawWatchingCrypto : []).flatMap(
    (entry) => {
      const spec = parseCryptoPair(entry as string);
      if (!spec) {
        warnings.push(
          `config.json: ignoring invalid "watchingCrypto" entry ${JSON.stringify(entry)} — ` +
            `expected "BASE/QUOTE", e.g. "BTC/CRO".`,
        );
        return [];
      }
      return [spec];
    },
  );

  // Migration guard — old field name is no longer accepted
  if (json.totalPortfolioValueUSD !== undefined) {
    throw new Error(
      'config.json: "totalPortfolioValueUSD" is deprecated. ' +
        'Rename it to "totalPortfolioValue" and add "defaultCurrency" (e.g. "USD"). ' +
        "See config.example.json.",
    );
  }
  if (json.totalPortfolioValue === undefined) {
    if (Object.keys(json.targetPortfolio ?? {}).length > 0 || Object.keys(json.currentHoldings ?? {}).length > 0) {
      throw new Error('config.json: "totalPortfolioValue" is required when a portfolio is configured.');
    }
    warnings.push('config.json: "totalPortfolioValue" missing — watch-only mode, no money sizing.');
  } else if (typeof json.totalPortfolioValue !== "number") {
    throw new Error('config.json: "totalPortfolioValue" must be a number.');
  }

  const rawCurrency = json.defaultCurrency;
  if (rawCurrency === undefined) {
    warnings.push('config.json: "defaultCurrency" missing — defaulting to "USD".');
  } else if (typeof rawCurrency !== "string") {
    throw new Error('config.json: "defaultCurrency" must be a string (e.g. "USD").');
  }
  const defaultCurrency = typeof rawCurrency === "string" ? rawCurrency.toUpperCase() : "USD";
  if (!SUPPORTED_CURRENCIES.includes(defaultCurrency)) {
    throw new Error(
      `config.json: "defaultCurrency": "${defaultCurrency}" is not supported. ` +
        `Supported: ${SUPPORTED_CURRENCIES.join(", ")}.`,
    );
  }

  // Optional friendly names. Non-object → warn+ignore; non-string values are
  // skipped rather than thrown — a bad name entry should never kill a run.
  let tickerNames: Record<string, string> = {};
  const rawTickerNames = json.tickerNames;
  if (rawTickerNames !== undefined) {
    if (isPlainObject(rawTickerNames)) {
      tickerNames = Object.fromEntries(
        Object.entries(rawTickerNames).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
        ),
      );
    } else {
      warnings.push('config.json: ignoring "tickerNames" — must be an object of ticker → name.');
    }
  }

  return {
    targetPortfolio,
    currentHoldings,
    totalPortfolioValue: (json.totalPortfolioValue as number | undefined) ?? 0,
    defaultCurrency,
    tickerNames,
    hotStocks: { ...DEFAULT_HOT_STOCKS, ...(json.hotStocks as object | undefined) },
    watchingTickers,
    cryptoPairSpecs,
    intradayAlerts: { ...DEFAULT_ALERTS, ...(json.intradayAlerts as object | undefined) },
    // Same knobs as intraday, tuned separately: cross-pairs trade 24/7.
    cryptoAlerts: { ...DEFAULT_ALERTS, ...(json.cryptoAlerts as object | undefined) },
    social: {
      enabled: true,
      includeLinkInX: false,
      hashtags: ["investing", "stocks", "stockmarket", "ETFs"],
      ...(json.social as object | undefined),
    },
    ai: { strongBuyRequiresAllProviders: false, ...(json.ai as object | undefined) },
    warnings,
  };
}
