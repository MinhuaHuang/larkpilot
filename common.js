import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

export const DATA_DIR = path.join(os.homedir(), ".larkpilot");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const CHAT_CWD = path.join(DATA_DIR, "chats");
fs.mkdirSync(CHAT_CWD, { recursive: true });

// legacy json config, migrated into the db on first run
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const LOG_FILE = path.join(DATA_DIR, "larkpilot.log");
// env override exists for tests: point the db at a throwaway file
export const DB_FILE =
  process.env.LARKPILOT_DB || path.join(DATA_DIR, "larkpilot.db");

let _db;
// shared sqlite handle (bot / cli / hook processes each open their own)
export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_FILE, { timeout: 5000 });
  // WAL: the bot reads while cli/hook processes occasionally write
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_bot_msg_session (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  if (_db.prepare("SELECT COUNT(*) AS n FROM config").get().n === 0) {
    try {
      const legacy = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      const upsert = _db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
      );
      for (const [k, v] of Object.entries(legacy)) upsert.run(k, String(v));
    } catch {}
  }
  return _db;
}

export function loadConfig() {
  return Object.fromEntries(
    getDb()
      .prepare("SELECT key, value FROM config")
      .all()
      .map((r) => [r.key, r.value]),
  );
}

export function setConfig(key, value) {
  getDb()
    .prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
    .run(key, value);
}

// per-chat runtime switches, read fresh from the config table on every call
// so `config set` applies without a bot restart:
// - disable_chat_ids: JSON array of chat ids where the bot is turned off
// - chat_prompt_<chatId>: optional per-chat instruction appended to the
//   claude prompt. a malformed disable_chat_ids fails open (bot stays on).
export function getChatDirectives(chatId) {
  const config = loadConfig();
  let disabledIds = [];
  try {
    disabledIds = JSON.parse(config.disable_chat_ids ?? "[]");
  } catch {}
  return {
    disabled: Array.isArray(disabledIds) && disabledIds.includes(chatId),
    chatPrompt: config[`chat_prompt_${chatId}`] || null,
  };
}

// bot card message -> claude session mapping: lets a later reply to any card
// of a run find back the session it belonged to (continue that conversation).
// one row per card — rollover cards each get their own message_id.
// best-effort: a failed write only degrades later lookup, so it must never
// escape into the caller (the card stream's producer)
export function recordChatBotMsgSession(messageId, sessionId) {
  try {
    getDb()
      .prepare(
        "INSERT INTO chat_bot_msg_session (message_id, session_id, created_at) VALUES (?, ?, ?)",
      )
      .run(messageId, sessionId, new Date().toISOString());
  } catch (e) {
    createTaskLogger("db").error("recordChatBotMsgSession failed:", e);
  }
}

// reverse lookup: the session a bot card message belonged to, so a reply to
// that card can continue that conversation
export function getSessionIdByMsgId(messageId) {
  return (
    getDb()
      .prepare(
        "SELECT session_id FROM chat_bot_msg_session WHERE message_id = ?",
      )
      .get(messageId)?.session_id ?? null
  );
}

// config `claudePath` (absolute path to claude.cmd) overrides the plain
// PATH lookup — the daemon's PATH does not reach the fnm-managed claude
export function resolveClaudeCmd() {
  return loadConfig().claudePath || "claude";
}

// does a pid still correspond to a live process (signal-0 probe)?
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timestamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

function serialize(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// child stderr can come from cmd.exe in the OEM codepage (gbk on zh-CN
// Windows) instead of claude's utf-8 — try strict utf-8 first, fall back
export function decodeChildText(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("utf-8");
    }
  }
}

// task logger: appends every line to LOG_FILE with `time|id| ` prefix.
// id = messageId for bot message tasks, task uuid for ask jobs,
// "app" for bot-level (non-task) logs.
// daily rolling: when the existing log's last write was on an earlier day,
// archive it as larkpilot.log.<date> and start fresh; benign if a concurrent
// process wins the rename — the loser just keeps appending
function rotateLog() {
  let st;
  try {
    st = fs.statSync(LOG_FILE);
  } catch {
    return; // no file yet — appendFileSync creates it
  }
  const day = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day(st.mtime) >= day(new Date())) return;
  try {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.${day(st.mtime)}`);
  } catch {}
}

export function createTaskLogger(id) {
  const write = (args) => {
    rotateLog();
    fs.appendFileSync(
      LOG_FILE,
      `${timestamp()}|${id}| ${args.map(serialize).join(" ")}\n`,
    );
  };
  return {
    log: (...args) => write(args),
    error: (...args) => write(["ERROR:", ...args]),
  };
}
