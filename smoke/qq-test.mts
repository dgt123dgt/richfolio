import "dotenv/config";
import { sendQQDigest } from "../src/qqNotify.js";

// One-shot QQ push test — verifies credentials + openid with a tiny message.
// Safe to run anytime; deletes itself from the flow after the channel is live.
const ok = await sendQQDigest({
  report: { totalCurrentValue: 0, items: [] },
  aiRecs: [],
  sentiment: null,
  date: new Date(),
});
console.log(ok ? "QQ PUSH OK — check your QQ message list" : "QQ PUSH FAILED (see warnings above)");
