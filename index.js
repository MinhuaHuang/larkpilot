#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import {
  DATA_DIR,
  LOG_FILE,
  DB_FILE,
  loadConfig,
  setConfig,
  isAlive,
  sleep,
  createTaskLogger,
  resolveClaudeCmd,
  decodeChildText,
} from "./common.js";
import { handleStdin, installHooks } from "./hook.js";

const PID_FILE = path.join(DATA_DIR, "larkpilot.pid");
const BOT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "chat.js",
);

function readPid() {
  try {
    return parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

const program = new Command()
  .name("larkpilot")
  .description("飞书 claude 机器人")
  .version("1.0.1");

function startBot() {
  const pid = readPid();
  if (isAlive(pid)) {
    console.log(`已在运行 (pid ${pid})`);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [BOT_FILE], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // no console window on Windows
    windowsHide: true,
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  fs.closeSync(logFd);
  console.log(`已启动 (pid ${child.pid})，日志: ${LOG_FILE}`);
}

// kill is asynchronous — poll until the pid is really gone so a restart
// never races the old process's teardown (websocket, session files)
async function stopBot() {
  const pid = readPid();
  if (!isAlive(pid)) {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    console.log("未在运行");
    return;
  }
  process.kill(pid);
  fs.unlinkSync(PID_FILE);
  for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
  console.log(`已停止 (pid ${pid})`);
}

// ---- chat bot daemon ----
const chatCmd = program.command("chat").description("聊天后台服务管理");

chatCmd
  .command("start")
  .description("启动服务")
  .action(startBot);

chatCmd
  .command("stop")
  .description("停止服务")
  .action(stopBot);

chatCmd
  .command("restart")
  .description("重启服务")
  .action(async () => {
    await stopBot();
    startBot();
  });

chatCmd
  .command("status")
  .description("查看状态")
  .action(() => {
    const pid = readPid();
    console.log(isAlive(pid) ? `运行中 (pid ${pid})` : "未在运行");
  });

// one-shot claude run: fresh session every time, no chat-session.json involvement;
// resolves with the full final text
function runClaudeOnce(prompt) {
  const CLAUDE_DIR = path.join(DATA_DIR, "chats");
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const cmd =
      `"${resolveClaudeCmd()}" --print --output-format stream-json --verbose ` +
      "--permission-mode bypassPermissions";
    const child = spawn(cmd, {
      cwd: CLAUDE_DIR,
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    const stderrChunks = [];
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = decodeChildText(Buffer.concat(stderrChunks));
        return reject(
          new Error(stderr.trim() || `claude exited with code ${code}`),
        );
      }
      let resultText = "";
      let assistantText = "";
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === "result" && typeof evt.result === "string") {
          resultText = evt.result;
        }
        if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block.type === "text") assistantText += block.text;
          }
        }
      }
      const text = resultText || assistantText;
      if (!text) return reject(new Error("claude returned no text"));
      resolve(text);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---- ask queue: cross-process FIFO via spool dir + lock file ----
// jobs are json files named by arrival time; the process holding the lock
// runs as the sole runner and drains them in name order
const ASK_DIR = path.join(DATA_DIR, "ask-queue");
const ASK_LOCK = path.join(ASK_DIR, "lock");

function pendingAskJobs() {
  return fs
    .readdirSync(ASK_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function enqueueAskJob(chatId, content) {
  fs.mkdirSync(ASK_DIR, { recursive: true });
  const seq = fs.readdirSync(ASK_DIR).filter((f) => f.endsWith(".json")).length;
  const name = `${Date.now()}-${String(seq).padStart(6, "0")}-${randomUUID()}.json`;
  fs.writeFileSync(path.join(ASK_DIR, name), JSON.stringify({ chatId, content }));
  return name;
}

function askLockAlive() {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(ASK_LOCK, "utf8").trim(), 10);
  } catch {
    return false;
  }
  return isAlive(pid);
}

function tryAcquireAskLock() {
  try {
    const fd = fs.openSync(ASK_LOCK, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// the lock holder executes every queued job (its own first among pending)
// in FIFO order, then releases the lock
async function runAskRunner() {
  const config = loadConfig();
  if (!config.appId || !config.appSecret) {
    console.error("缺少飞书应用配置，请先执行: larkpilot config set appId <id> appSecret <secret>");
    process.exit(1);
  }
  const { createLarkChannel } = await import("@larksuite/channel");
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
  });
  await channel.connect();
  try {
    while (true) {
      let jobs = pendingAskJobs();
      if (!jobs.length) {
        // release-race guard: a job enqueued while we were about to exit
        // still shows up on this second look, so the next ask's
        // "lock alive -> skip spawning" shortcut can never orphan it
        await sleep(100);
        jobs = pendingAskJobs();
        if (!jobs.length) break;
      }
      const file = jobs[0];
      const jobPath = path.join(ASK_DIR, file);
      const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      // task id = the uuid embedded in the job file name
      const taskId = file.split("-").slice(2).join("-").replace(/\.json$/, "");
      const log = createTaskLogger(taskId);
      log.log("ask job started:", job.content);
      try {
        const text = await runClaudeOnce(job.content);
        // plain send: auto-splits long markdown into chained messages
        await channel.send(job.chatId, { markdown: text });
        log.log("ask job sent");
        console.log(`已发送 (${file})`);
      } catch (err) {
        log.error("ask job failed:", err);
        console.error(`任务 ${file} 失败:`, err.message || err);
      } finally {
        try {
          fs.unlinkSync(jobPath);
        } catch {}
      }
    }
  } finally {
    try {
      fs.unlinkSync(ASK_LOCK);
    } catch {}
    await channel.disconnect();
  }
}

// detached background runner: takes the lock if it can (stealing from a
// dead holder), drains the queue, releases; exits instantly if a live
// runner already holds the lock
function spawnAskRunner() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "__drain-ask"],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}

program
  .command("__drain-ask", { hidden: true })
  .action(async () => {
    const runnerLog = createTaskLogger("ask-runner");
    runnerLog.log("drain process starting, pid", process.pid);
    if (!tryAcquireAskLock()) {
      if (askLockAlive()) {
        runnerLog.log("live runner already holds the lock, exiting");
        return;
      }
      runnerLog.log("stealing lock from dead holder");
      fs.rmSync(ASK_LOCK, { force: true });
      if (!tryAcquireAskLock()) {
        runnerLog.log("lock stolen by someone else, exiting");
        return;
      }
    }
    runnerLog.log("lock acquired, draining");
    await runAskRunner();
    runnerLog.log("drain finished");
  });

program
  .command("ask")
  .description("转发内容给 claude 执行，结果发送到指定飞书会话（全局串行队列，异步）")
  .requiredOption("--chatId <id>", "目标飞书会话 ID")
  .requiredOption("--content <text>", "发给 claude 的内容")
  .action((opts) => {
    fs.mkdirSync(ASK_DIR, { recursive: true });
    enqueueAskJob(opts.chatId, opts.content);
    // a live runner will drain the queue (it re-checks before releasing,
    // so an enqueue racing with its exit is still picked up); only spawn
    // a fresh drain process when nobody holds the lock
    if (!(fs.existsSync(ASK_LOCK) && askLockAlive())) {
      spawnAskRunner();
    }
    console.log(`已提交（当前队列 ${pendingAskJobs().length} 个任务）`);
  });

// ---- hook: local interactive claude notifies Lark via larkpilot ----
const hookCmd = program.command("hook").description("hook 管理");

hookCmd
  .command("stdin")
  .description("从 stdin 读取 hook 数据，落库并发送飞书通知")
  .action(() => handleStdin());

hookCmd
  .command("install")
  .description("安装 hook 配置到 Claude settings.json")
  .option("-g, --global", "安装到全局配置 (~/.claude/settings.json)")
  .action((opts) => installHooks(opts));

const configCmd = program
  .command("config")
  .description("配置管理");

configCmd
  .command("set")
  .description("写入配置项（key value 成对，可多组，增量合并）")
  .argument("<pairs...>", "key value [key value ...]")
  .action((pairs) => {
    if (pairs.length % 2 !== 0) {
      console.error("参数必须为 key value 成对，如: larkpilot config set appId xxx appSecret yyy");
      process.exit(1);
    }
    for (let i = 0; i < pairs.length; i += 2) setConfig(pairs[i], pairs[i + 1]);
    console.log(`已写入 ${DB_FILE}`);
  });

configCmd
  .command("list")
  .description("查看当前配置")
  .action(() => {
    const cur = loadConfig();
    const entries = Object.entries(cur);
    if (!entries.length) {
      console.log("未配置。用法: larkpilot config set appId <id> appSecret <secret>");
      return;
    }
    for (const [k, v] of entries) {
      console.log(`${k} = ${/secret/i.test(k) && v ? "***" : v}`);
    }
  });

program.parse();
