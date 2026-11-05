// ── QQ 官方机器人推送 (v2 单聊接口) ─────────────────────────────────
// Second delivery channel next to the email: pushes a plain-text digest of
// the daily brief straight into the user's QQ message list via Tencent's
// official bot REST API — no WebSocket, no daemon, no unofficial protocol
// client. Enabled only when all three env vars are set:
//   QQ_BOT_APPID / QQ_BOT_SECRET / QQ_BOT_OPENID
// (q.qq.com → 创建机器人 → 实名认证; openid from a message sent to the bot
//  or the bot console).
//
// Quota reality (official docs): 主动消息 free of charge; per-user daily cap
// 1000 msgs, burst ~20/min for verified personal bots — a once-a-day digest
// never comes close. Content risk-control rejects very long/link-spammy
// payloads, so the digest is compact and chunked at ~900 chars per message.
//
// Failure policy: this channel is best-effort. Every error is logged as a
// warning and swallowed — the email is the source of truth and must never be
// affected by QQ-side problems.

import { defaultCurrency, displayName } from "./config.js";
import type { AIBuyRecommendation } from "./aiAnalysis.js";
import type { MarketSentiment } from "./marketSentiment.js";
import { formatMoney } from "./util.js";
import {
  BOOK_LABELS,
  type BookId,
  formatTrade,
  type ExecutedTrade,
  type PaperSummary,
} from "./paperTrading.js";

export interface BookState {
  id: BookId;
  paper: PaperSummary;
  trades: ExecutedTrade[];
}

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const MSG_URL = (openid: string) =>
  `https://api.bot.qq.com/v2/users/${openid}/messages`;
const CHUNK_LIMIT = 900; // stay well inside content risk-control limits

export interface QQBotConfig {
  appId: string;
  secret: string;
  openid: string;
}

export function qqBotConfigFromEnv(): QQBotConfig | null {
  const appId = process.env.QQ_BOT_APPID ?? "";
  const secret = process.env.QQ_BOT_SECRET ?? "";
  const openid = process.env.QQ_BOT_OPENID ?? "";
  if (!appId || !secret || !openid) return null;
  return { appId, secret, openid };
}

// ── Digest building (pure, tested) ──────────────────────────────────
// Two deliberately SHORT digests per the user's brief:
//   • evening (22:00): 大盘情绪一句话 + 模拟盘仓位/操作 + 盈亏
//   • intraday (10:00/13:00): 大盘情绪 + AI 推荐 + 持仓盈亏
// The long sectioned brief lives in the email; QQ only carries the essence.

const money = (x: number): string => `¥${Math.round(x).toLocaleString("en-US")}`;

const pct = (x: number | null): string =>
  x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

export function sentimentLine(s: MarketSentiment | null): string {
  if (!s) return "情绪:数据缺失";
  const m = s.metrics;
  const zbRate =
    m.ztCount + m.zbCount > 0 ? (m.zbCount / (m.ztCount + m.zbCount)) * 100 : 0;
  return (
    `情绪:${s.phase}(命中${s.matches}/6) 涨停${m.ztCount}家 最高${m.maxLbc}板 ` +
    `晋级${(m.promoteRate * 100).toFixed(0)}% 炸板${zbRate.toFixed(0)}%｜仓位建议:${s.positionHint.replace("仓位 ", "")}`
  );
}

export function bookLine(label: string, p: PaperSummary): string {
  const held = p.holdings
    .map((h) => `${h.name}(${pct(h.pnlPct)})`)
    .join("、");
  return (
    `${label}仓:总${money(p.total)} 仓位${p.positionPct.toFixed(0)}% ` +
    `盈亏:今日${pct(p.pnlDayPct)} 本月${pct(p.pnlMonthPct)}(${p.pnlMonth >= 0 ? "+" : ""}${Math.round(p.pnlMonth)}元)` +
    (held ? `｜持仓:${held}` : "｜空仓")
  );
}

/** 22:00 盘后简报 — 情绪 + 两个模拟仓各自操作与盈亏. */
export function buildEveningDigest(input: {
  sentiment: MarketSentiment | null;
  books: BookState[];
  date?: Date;
}): string {
  const d = input.date ?? new Date();
  const lines: string[] = [
    `【盘后简报】${d.getMonth() + 1}/${d.getDate()}`,
    sentimentLine(input.sentiment),
  ];
  const top = input.sentiment?.concepts[0];
  if (top) {
    lines.push(
      `主线:${top.name}[${top.phase}]${top.leader ? ` 龙头${top.leader.name}${top.leader.lbc}板` : ""}${top.mainNet != null ? ` 主力${top.mainNet >= 0 ? "+" : ""}${top.mainNet}亿` : ""}`,
    );
  }
  if (input.sentiment?.leaderAlert) lines.push(input.sentiment.leaderAlert);
  for (const b of input.books) {
    lines.push(bookLine(BOOK_LABELS[b.id] ?? b.id, b.paper));
    lines.push(
      `  操作:${b.trades.length > 0 ? b.trades.map(formatTrade).join("；") : "无（观望）"}`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

/** 10:00 / 13:00 盘中快报 — 情绪 + AI 推荐 + 两仓盈亏. */
export function buildIntradayDigest(input: {
  sentiment: MarketSentiment | null;
  aiRecs: AIBuyRecommendation[];
  books: Array<{ id: BookId; paper: PaperSummary }>;
  date?: Date;
}): string {
  const d = input.date ?? new Date();
  const hhmm = d
    .toLocaleTimeString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false })
    .slice(0, 5);
  const lines: string[] = [
    `【盘中快报】${d.getMonth() + 1}/${d.getDate()} ${hhmm}(北京时间)`,
    sentimentLine(input.sentiment),
  ];
  const buys = input.aiRecs
    .filter((r) => r.action === "STRONG BUY" || r.action === "BUY")
    .slice(0, 4);
  if (buys.length > 0) {
    lines.push(
      `AI推荐:${buys
        .map(
          (r) =>
            `${r.action === "STRONG BUY" ? "★" : ""}${displayName(r.ticker, r.tickerFullName)}(${r.confidence}%)`,
        )
        .join("、")}`,
    );
    const first = buys[0];
    if (first?.reason) lines.push(`  首选理由:${first.reason.replace(/\n/g, " ").slice(0, 80)}`);
  } else {
    lines.push("AI推荐:今日暂无买入级标的");
  }
  for (const b of input.books) {
    lines.push(bookLine(BOOK_LABELS[b.id] ?? b.id, b.paper));
  }
  return lines.filter(Boolean).join("\n");
}

/** 按行切割长文本，每段不超过 limit 字符（QQ 内容风控友好）. */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current ? current.length + 1 : 0) + line.length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Sending ─────────────────────────────────────────────────────────

async function fetchAccessToken(cfg: QQBotConfig): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.secret }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const json = (await res.json()) as {
    access_token?: string;
    code?: number;
    message?: string;
  };
  if (!json.access_token) {
    throw new Error(`token denied: ${json.code ?? "?"} ${json.message ?? ""}`);
  }
  return json.access_token;
}

/**
 * Push any plain text (chunked). Returns true when every chunk was accepted;
 * false when QQ rejected anything (caller logs; email remains authoritative).
 */
export async function sendQQText(text: string): Promise<boolean> {
  const cfg = qqBotConfigFromEnv();
  if (!cfg) return false;

  const chunks = chunkText(text);
  const token = await fetchAccessToken(cfg);

  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(MSG_URL(cfg.openid), {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: chunks[i],
        msg_type: 0,
        msg_id: "",
        msg_seq: i + 1, // 主动消息必须有递增 seq
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`⚠ QQ push chunk ${i + 1} rejected: HTTP ${res.status} ${body.slice(0, 120)}`);
      ok = false;
    }
  }
  return ok;
}
