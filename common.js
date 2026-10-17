import fs from "fs";
import os from "os";
import path from "path";

export const DATA_DIR = path.join(os.homedir(), ".larkpilot");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const LOG_FILE = path.join(DATA_DIR, "larkpilot.log");

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
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

// task logger: appends every line to LOG_FILE with `time|id| ` prefix.
// id = messageId for bot message tasks, task uuid for ask jobs,
// "app" for bot-level (non-task) logs.
export function createTaskLogger(id) {
  const write = (args) =>
    fs.appendFileSync(
      LOG_FILE,
      `${timestamp()}|${id}| ${args.map(serialize).join(" ")}\n`,
    );
  return {
    log: (...args) => write(args),
    error: (...args) => write(["ERROR:", ...args]),
  };
}
