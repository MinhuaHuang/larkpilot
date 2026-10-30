import fs from "fs";
import path from "path";
import os from "os";
import { getDb, loadConfig, createTaskLogger, DATA_DIR, CHAT_CWD } from "./common.js";

// hook logs share larkpilot.log; raw stdin goes to the db only
const log = createTaskLogger("hook");

let _db;
function db() {
  if (_db) return _db;
  _db = getDb();
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_hook_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      fire_time  TEXT    NOT NULL,
      session_id TEXT    NOT NULL,
      cwd        TEXT    NOT NULL,
      event_name TEXT    NOT NULL,
      stdin      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_hook_log_session_event
      ON agent_hook_log (session_id, event_name);
  `);
  return _db;
}

function insertHookLog(fireTime, sessionId, cwd, eventName, stdin) {
  db()
    .prepare(
      "INSERT INTO agent_hook_log (fire_time, session_id, cwd, event_name, stdin) VALUES (?, ?, ?, ?, ?)",
    )
    .run(fireTime, sessionId, cwd, eventName, stdin);
}

function getLastUserPrompt(sessionId) {
  const row = db()
    .prepare(
      "SELECT stdin FROM agent_hook_log WHERE session_id = ? AND event_name = 'UserPromptSubmit' ORDER BY id DESC LIMIT 1",
    )
    .get(sessionId);
  if (!row) return null;
  try {
    return JSON.parse(row.stdin).prompt || null;
  } catch {
    return null;
  }
}
function isChatSession(cwd) {
  if (!cwd) return false;
  const a = path.resolve(cwd);
  // win32 paths are case-insensitive; elsewhere compare exactly
  const [x, base] =
    process.platform === "win32"
      ? [a.toLowerCase(), CHAT_CWD.toLowerCase()]
      : [a, CHAT_CWD];
  // cwd is CHAT_CWD itself or any subdirectory under it
  return x === base || x.startsWith(base + path.sep);
}

async function sendNotify(msg) {
  const config = loadConfig();
  if (!config.hookChatId) {
    log.error(msg.sessionId + " | 未配置 hookChatId，跳过通知: larkpilot config set hookChatId <chatId>");
    return;
  }
  if (!config.appId || !config.appSecret) {
    log.error(msg.sessionId + "| 缺少飞书应用配置，请先执行: larkpilot config set appId <id> appSecret <secret>");
    return;
  }

  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `ClaudeCode - ${msg.title || "消息通知✴"}` },
      template: msg.color || "orange",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**项目路径:** ${(msg.cwd || "N/A").replace(/\./g, "\\.")}`,
          },
        },
        { tag: "hr" },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: [
              `**会话ID:** ${msg.sessionId || "N/A"}`,
              `**最近提问:** ${msg.lastUserPrompt || "N/A"}`,
            ].join("\n"),
          },
        },
        { tag: "hr" },
        { tag: "div", text: { tag: "lark_md", content: msg.content } },
        { tag: "hr" },
        {
          tag: "markdown",
          content: "<at id=all></at>请及时前往终端查看",
        },
      ],
    },
  };

  const { createLarkChannel } = await import("@larksuite/channel");
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
  });
  await channel.connect();
  try {
    await channel.send(config.hookChatId, { card });
  } catch (e) {
    log.error(msg.sessionId + "| send failed:", e);
  } finally {
    await channel.disconnect();
  }
}

// local interactive claude sessions pipe their hook payloads here; every
// event is recorded in agent_hook_log, only some trigger a Lark notification
export async function handleStdin() {
  const rawInput = await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf.trim()));
    process.stdin.on("error", reject);
  });

  let parsed;
  try {
    parsed = JSON.parse(rawInput);
  } catch (e) {
    log.error("invalid hook json:", e);
    process.exit(1);
  }

  const eventName = parsed.hook_event_name || "";
  insertHookLog(
    new Date().toISOString(),
    parsed.session_id || "",
    parsed.cwd || process.cwd(),
    eventName,
    rawInput,
  );

  // bot sessions are logged above but never notify
  if (isChatSession(parsed.cwd || process.cwd())) return;

  if (eventName === "Notification") {
    // idle_prompt fires every 60s while claude waits for input — too noisy
    if (parsed.notification_type === "idle_prompt") return;
    await sendNotify({
      title: "消息通知✴",
      color: "orange",
      cwd: parsed.cwd || process.cwd(),
      sessionId: parsed.session_id,
      lastUserPrompt: getLastUserPrompt(parsed.session_id) || "N/A",
      content: parsed.message || "",
    });
  } else if (eventName === "Stop" || eventName === "StopFailure") {
    await sendNotify({
      title: `任务结束${eventName === "Stop" ? "✅" : "❌"}`,
      color: eventName === "Stop" ? "green" : "red",
      cwd: parsed.cwd || process.cwd(),
      sessionId: parsed.session_id,
      lastUserPrompt: getLastUserPrompt(parsed.session_id) || "N/A",
      content: parsed.last_assistant_message || "",
    });
  }
}

export function installHooks(opts) {
  const settingsPath = opts.global
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(process.cwd(), ".claude", "settings.json");

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {}

  if (!settings.hooks) settings.hooks = {};

  const command = "larkpilot hook stdin";
  const hookEntry = { type: "command", command, async: true };
  // UserPromptSubmit is db-only (feeds getLastUserPrompt), never notifies
  const events = ["Notification", "Stop", "StopFailure", "UserPromptSubmit"];

  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const exists = settings.hooks[event].some(
      (group) => group.hooks && group.hooks.some((h) => h.command === command),
    );
    if (!exists) settings.hooks[event].push({ hooks: [hookEntry] });
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`已安装到 ${settingsPath}`);
  for (const event of events) console.log(`  ${event}`);
}
