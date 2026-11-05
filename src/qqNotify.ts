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
import type { AllocationReport } from "./analyze.js";
import type { AIBuyRecommendation } from "./aiAnalysis.js";
import type { MarketSentiment } from "./marketSentiment.js";
import type { NewsItem } from "./fetchNews.js";
import { classifyHotNewsImpact } from "./hotNewsImpact.js";
import { formatMoney } from "./util.js";

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

const section = (title: string): string =>
  `\n〔${title}〕`;

export function buildBriefDigest(input: {
  report: Pick<AllocationReport, "totalCurrentValue" | "items">;
  aiRecs: AIBuyRecommendation[];
  sentiment: MarketSentiment | null;
  hotNews?: NewsItem[];
  date: Date;
}): string {
  const lines: string[] = [];
  const d = input.date;
  lines.push(
    `【Richfolio 每日简报】${d.getMonth() + 1}/${d.getDate()}`,
  );

  if (input.sentiment) {
    const s = input.sentiment;
    const m = s.metrics;
    const zbRate =
      m.ztCount + m.zbCount > 0 ? (m.zbCount / (m.ztCount + m.zbCount)) * 100 : 0;
    lines.push(`${section("市场情绪")}`);
    lines.push(
      `周期:${s.phase}(命中${s.matches}/6)｜涨停${m.ztCount}家 最高${m.maxLbc}板`,
    );
    lines.push(
      `晋级率${(m.promoteRate * 100).toFixed(0)}% 炸板率${zbRate.toFixed(0)}% 红盘率${(m.redRate * 100).toFixed(0)}% 跌停/大面${m.bigLossCount}家`,
    );
    lines.push(`仓位建议:${s.positionHint.replace("仓位 ", "")}`);
    if (s.ladderText) lines.push(`梯队:${s.ladderText}`);
    if (s.spaceText) lines.push(`空间板:${s.spaceText}`);
    if (s.leaderAlert) lines.push(s.leaderAlert);

    if (s.funds) {
      lines.push(`${section("资金面")}`);
      lines.push(
        `两市成交${s.funds.totalAmount}亿 较昨日${s.funds.amountChangePct >= 0 ? "+" : ""}${s.funds.amountChangePct}% → ${s.funds.volumeState}`,
      );
      lines.push(
        `主力${s.funds.mainNet >= 0 ? "净流入 +" : "净流出 "}${Math.abs(s.funds.mainNet)}亿｜${s.funds.comment}`,
      );
      const ins = s.funds.inflowSectors.map((x) => `${x.name}+${x.net}亿`).join("、");
      const outs = s.funds.outflowSectors.map((x) => `${x.name}${x.net}亿`).join("、");
      if (ins) lines.push(`流入:${ins}`);
      if (outs) lines.push(`流出:${outs}`);
    }

    if (s.concepts.length > 0) {
      lines.push(`${section("热门题材")}`);
      s.concepts.forEach((c, i) => {
        lines.push(
          `${i + 1}.${c.name}[${c.phase}] 涨停${c.ztCount}家 最高${c.maxLbc}板 溢价${c.premium >= 0 ? "+" : ""}${c.premium.toFixed(1)}%${c.mainNet != null ? ` 主力${c.mainNet >= 0 ? "+" : ""}${c.mainNet}亿` : ""}${c.leader ? ` 龙头:${c.leader.name}(${c.leader.lbc}板)` : ""}${c.volumeState ? ` ${c.volumeState}${(c.amountChangePct ?? 0) >= 0 ? "+" : ""}${c.amountChangePct}%` : ""}`,
        );
        if (c.buyers) lines.push(`  谁在买:${c.buyers}`);
      });
      for (const t of s.tomorrowScenarios) lines.push(`▪明日:${t}`);
    }
  }

  if (input.hotNews && input.hotNews.length > 0) {
    lines.push(`${section("市场热点")}`);
    for (const a of input.hotNews.slice(0, 3)) {
      const im = classifyHotNewsImpact(a.title, "", []);
      const impact = im.impact ? `${im.impact}${im.scopes.length > 0 ? "(大盘)" : ""}` : "";
      lines.push(`• ${impact ? `[${impact}] ` : ""}${a.title.slice(0, 40)}`);
    }
  }

  const buys = input.aiRecs
    .filter((r) => r.action === "STRONG BUY" || r.action === "BUY")
    .slice(0, 4);
  if (buys.length > 0) {
    lines.push(`${section("AI 推荐")}`);
    for (const r of buys) {
      const buyTxt = r.suggestedBuyValue > 0 ? ` 建议${formatMoney(r.suggestedBuyValue, r.quoteCurrency ?? defaultCurrency)}` : "";
      lines.push(
        `${r.action === "STRONG BUY" ? "★" : "·"}${displayName(r.ticker, r.tickerFullName)} ${r.action}(${r.confidence}%)${buyTxt}`,
      );
      if (r.reason) lines.push(`  理由:${r.reason.replace(/\n/g, " ").slice(0, 60)}…`);
    }
  }

  lines.push(`${section("持仓")}`);
  lines.push(
    `持仓市值:${formatMoney(input.report.totalCurrentValue, defaultCurrency)}（${input.report.items.length} 只标的）`,
  );

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
 * Push the digest. Returns true when every chunk was accepted; false when QQ
 * rejected anything (caller logs; email remains the authoritative channel).
 */
export async function sendQQDigest(input: {
  report: Pick<AllocationReport, "totalCurrentValue" | "items">;
  aiRecs: AIBuyRecommendation[];
  sentiment: MarketSentiment | null;
  hotNews?: NewsItem[];
  date?: Date;
}): Promise<boolean> {
  const cfg = qqBotConfigFromEnv();
  if (!cfg) return false;

  const text = buildBriefDigest({ ...input, date: input.date ?? new Date() });
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
