import "dotenv/config";

// One-shot helper: capture your user_openid for the QQ bot push channel.
//
// Openid is per-user-per-bot and can only be learned from a message event, so
// this script connects to Tencent's OFFICIAL bot WebSocket gateway, listens
// for a C2C (single-chat) message, prints the sender's openid, and exits.
//
// Usage:
//   1. Add your QQ as a sandbox member in the bot console (q.qq.com).
//   2. npx tsx smoke/qq-openid.ts
//   3. While it is listening, send ANY message to the bot in QQ.
//   4. Copy the printed openid into .env (QQ_BOT_OPENID) and GitHub Secrets.
//
// Needs QQ_BOT_APPID / QQ_BOT_SECRET in .env.

const APP_ID = process.env.QQ_BOT_APPID;
const SECRET = process.env.QQ_BOT_SECRET;

if (!APP_ID || !SECRET) {
  console.log("Need QQ_BOT_APPID / QQ_BOT_SECRET in .env");
  process.exit(1);
}

const H = { "Content-Type": "application/json" };
const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ appId: APP_ID, clientSecret: SECRET }),
});
const tokenBody = (await tokenRes.json()) as { access_token?: string };
const token = tokenBody.access_token;
if (!token) {
  console.log("Token fetch failed — check AppID/Secret:", JSON.stringify(tokenBody));
  process.exit(1);
}
console.log("✓ access token ok");

const gwRes = await fetch("https://api.sgroup.qq.com/gateway", {
  headers: { Authorization: `QQBot ${token}` },
});
const gw = ((await gwRes.json()) as { url?: string }).url;
if (!gw) {
  console.log("Gateway fetch failed:", await gwRes.text());
  process.exit(1);
}
console.log("✓ gateway:", gw);

const ws = new WebSocket(gw);
let lastSeq: number | null = null;
let heartbeatMs = 30_000;
const TIMEOUT = setTimeout(() => {
  console.log("\n⏱ 120s without a message — run again and send a message to the bot.");
  process.exit(0);
}, 120_000);

ws.onmessage = (ev) => {
  const p = JSON.parse(String(ev.data)) as {
    op: number;
    d?: unknown;
    t?: string;
    s?: number;
  };
  if (p.op === 10) {
    heartbeatMs = (p.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 30_000;
    // C2C_GROUP_AT_MESSAGES = 1 << 25 (group + single-chat message events).
    ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] } }));
    setInterval(() => ws.send(JSON.stringify({ op: 1, d: lastSeq })), heartbeatMs);
  } else if (p.op === 0 && p.t) {
    if (typeof p.s === "number") lastSeq = p.s;
    const d = p.d as {
      content?: string;
      author?: { user_openid?: string };
    };
    console.log(`\n✓ event ${p.t}: content="${d.content ?? ""}" openid=${d.author?.user_openid ?? "?"}`);
    if (d.author?.user_openid) {
      console.log("\n=== Paste into .env and GitHub Secret QQ_BOT_OPENID ===");
      console.log(`QQ_BOT_OPENID=${d.author.user_openid}`);
      clearTimeout(TIMEOUT);
      setTimeout(() => process.exit(0), 300);
    }
  }
};

ws.onerror = (e) => {
  console.log("ws error:", e.message);
  process.exit(1);
};

console.log("Listening 120s — send ANY message to the bot in QQ now…");
