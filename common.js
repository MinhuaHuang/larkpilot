import { execSync } from "child_process";
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
// - chat_<chatId>: JSON string
//   {"prompt":"","disabled":false,"model":"","stream_end_at":true} —
//   prompt is a per-chat instruction appended to the claude prompt, disabled
//   turns the bot off in that chat, model overrides the claude model for
//   that chat (--model flag), stream_end_at sends an @-mention of the asker
//   after the run finishes (default on). a malformed value fails open (bot
//   stays on).
export function getChatDirectives(chatId) {
  const config = loadConfig();
  let directives = {};
  try {
    directives = JSON.parse(config[`chat_${chatId}`] ?? "{}");
  } catch {}
  return {
    disabled: directives.disabled === true,
    chatPrompt: directives.prompt || null,
    chatModel: directives.model || null,
    streamEndAt: directives.stream_end_at !== false,
  };
}

// read-modify-write of the per-chat JSON key chat_<chatId>: merge patch into
// the parsed value, keeping the other fields as they are; an unparseable
// existing value is overwritten (it was already dead to getChatDirectives)
function updateChatDirectives(chatId, patch) {
  const db = getDb();
  let directives = {};
  try {
    directives = JSON.parse(
      db.prepare("SELECT value FROM config WHERE key = ?").get(`chat_${chatId}`)
        ?.value ?? "{}",
    );
  } catch {}
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    `chat_${chatId}`,
    JSON.stringify({ ...directives, ...patch }),
  );
}

// update just the "model" field of the per-chat key chat_<chatId>, keeping
// prompt/disabled/stream_end_at as they are
export function setChatModel(chatId, model) {
  updateChatDirectives(chatId, { model });
}

// update just the "stream_end_at" field (default on) of the per-chat key
// chat_<chatId>, keeping the other fields as they are
export function setChatStreamEndAt(chatId, enabled) {
  updateChatDirectives(chatId, { stream_end_at: enabled });
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

// task concurrency (config key `max_concurrent`, default 2): how many claude
// runs may execute at once across all chats. read fresh on every use so
// `config set` applies without a bot restart; non-integer / < 1 falls back
// to the default
export function getMaxConcurrent() {
  const n = Number(loadConfig().max_concurrent);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

// config `lark_stream_loading_banner_img` (JSON string, {"default":
// "img_v2_...", "heavy": "img_v2_..."}): the loading banner image pinned on
// top of every streaming card while claude runs. `round` is the session's
// use counter: default shows for rounds 1-5, heavy wins from round 6 on
// (falling back to default when unset). an empty/missing default with no
// heavy means the banner is off; a malformed value fails off. read fresh so
// `config set` applies without a bot restart
export function getLoadingBannerImg(round) {
  let imgs = {};
  try {
    imgs = JSON.parse(loadConfig().lark_stream_loading_banner_img ?? "{}");
  } catch {}
  if (round > 5 && imgs.heavy) return imgs.heavy;
  return imgs.default || null;
}

// command line of a pid (null when the lookup itself fails; empty when the
// pid is gone or exposes no command line). win32: powershell prints in the
// console codepage (gbk on zh-CN Windows), hence decodeChildText; unix: ps
function readCmdline(pid) {
  try {
    if (process.platform === "win32") {
      return decodeChildText(
        execSync(
          `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
          { encoding: "buffer", windowsHide: true },
        ),
      ).trim();
    }
    return execSync(`ps -p ${pid} -o args=`, {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

// does a pid still correspond to a live process (signal-0 probe)? with
// `cmdlineMatches`, also require the process command line to satisfy the
// predicate: a recycled pid now running something else must not pass as
// ours (chat bot start/stop/status). a failed command-line lookup fails
// open (pid-only, the old behavior)
export function isAlive(pid, cmdlineMatches) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!cmdlineMatches) return true;
  const cmdline = readCmdline(pid);
  if (cmdline === null) return true;
  return cmdlineMatches(cmdline);
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
