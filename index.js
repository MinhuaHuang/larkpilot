import { createLarkChannel } from "@larksuite/channel";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(os.homedir(), ".larkpilot");
fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

const CLAUDE_DIR = path.join(DATA_DIR, "chats");
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const channel = createLarkChannel({
  appId: "cli_aa5a22bc81b85d21",
  appSecret: "jjIcGbRsnd8zqscmDUo4lbwgaSq1AwXK",
  // default per-chat pipeline serializes handlers (next message waits for
  // the previous one); disable it — concurrency is governed by our own
  // session lock + global slot instead
  chatQueue: { enabled: false },
});

// ---- sessions ----
// json (session.json) holds only EXECUTED session ids: { [chatId+senderId]: [{ sessionId, expiresAt }] }
// fresh unused ids live in memory (pendingSessions), one per key max,
// get consumed before spawn and land in json when claude closes
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_MAX_PER_KEY = 20;

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    // strip legacy `used` field
    for (const list of Object.values(raw)) {
      for (const e of list) delete e.used;
    }
    return raw;
  } catch {
    return {};
  }
}
const sessionStore = loadSessions();
const pendingSessions = new Map(); // key -> { sessionId, expiresAt } (unused)

function saveSessions() {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionStore, null, 2));
}

// register a fresh unused session in memory; existing pending is left untouched
function newSession(key) {
  if (pendingSessions.has(key)) return pendingSessions.get(key);
  const entry = {
    sessionId: randomUUID(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  pendingSessions.set(key, entry);
  return entry;
}

// pending (unused) wins; else latest non-expired json entry; else new pending
function getOrCreateSession(key) {
  const pending = pendingSessions.get(key);
  if (pending && pending.expiresAt > Date.now()) return pending;
  const list = sessionStore[key] ?? [];
  const latest = list.reduce(
    (a, b) => (!a || b.expiresAt > a.expiresAt ? b : a),
    null,
  );
  if (latest && latest.expiresAt > Date.now()) return latest;
  return newSession(key);
}

// record an executed session: renew expiry, dedupe, cap at SESSION_MAX_PER_KEY
function persistSession(key, entry) {
  const list = sessionStore[key] ?? [];
  entry.expiresAt = Date.now() + SESSION_TTL_MS;
  if (!list.some((e) => e.sessionId === entry.sessionId)) list.push(entry);
  sessionStore[key] = list
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(-SESSION_MAX_PER_KEY);
  saveSessions();
}

// ---- task queue: global FIFO, max 2 running, per-session exclusive ----
const MAX_CONCURRENT = 2;
let runningCount = 0;
const runningSessions = new Set();
const taskQueue = []; // FIFO: { sessionKey, run }

function tryDispatch() {
  while (runningCount < MAX_CONCURRENT) {
    // earliest task whose session is idle; session-blocked tasks stay put —
    // later independent tasks overtake them (pure FIFO would stall a slot
    // behind a task that physically cannot run yet)
    const idx = taskQueue.findIndex((t) => !runningSessions.has(t.sessionKey));
    if (idx === -1) return;
    const [task] = taskQueue.splice(idx, 1);
    runningSessions.add(task.sessionKey);
    runningCount++;
    task.run();
  }
}

function completeTask(sessionKey) {
  runningSessions.delete(sessionKey);
  runningCount--;
  tryDispatch();
}

function runClaudeStream(prompt, sessionKey, ctl) {
  console.log("claude prompt: ", prompt);
  const session = getOrCreateSession(sessionKey);
  const seedNew = pendingSessions.get(sessionKey) === session;
  if (seedNew) pendingSessions.delete(sessionKey); // consumed before spawn
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
      // unused id: seed a new session with --session-id;
      // executed id: continue it with --resume
      seedNew ? "--session-id" : "--resume",
      session.sessionId,
    ];
    // prompt goes via stdin: shell:true (needed for claude.cmd on Windows)
    // makes passing arbitrary chat text as argv unsafe
    const child = spawn("claude", args, { cwd: CLAUDE_DIR, shell: true });
    let stderr = "";
    let buffer = "";
    let sawContent = false;
    let resultStats = null;
    const handleLine = (line) => {
      if (!line.trim()) return;
      //   console.log(line);
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      // final result event carries model / token usage / duration
      if (evt.type === "result") {
        resultStats = {
          model:
            Object.keys(evt.modelUsage ?? {})[0] ?? evt.model ?? "unknown",
          inputTokens: evt.usage?.input_tokens ?? 0,
          outputTokens: evt.usage?.output_tokens ?? 0,
          durationMs: evt.duration_ms ?? 0,
        };
        return;
      }
      // --include-partial-messages emits Anthropic-style stream_event
      if (evt.type !== "stream_event") return;
      const ev = evt.event;
      if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") {
          sawContent = true;
          ctl.text(ev.delta.text);
        } else if (ev.delta?.type === "thinking_delta") {
          sawContent = true;
          ctl.thinking(ev.delta.thinking);
        }
      }
    };
    child.stdout.on("data", (d) => {
      buffer += d;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      persistSession(sessionKey, session);
      if (code !== 0) {
        return reject(
          new Error(stderr.trim() || `claude exited with code ${code}`),
        );
      }
      if (!sawContent) return reject(new Error("claude returned no text"));
      resolve(resultStats);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function downloadMsgResourceToFile(msg) {
  let filePaths = [];
  if (msg.resources) {
    for (let resource of msg.resources) {
      let resourceFilePath = path.join(FILES_DIR, resource.fileKey);
      filePaths.push(resourceFilePath);
      if (!fs.existsSync(resourceFilePath)) {
        let recourceFile = await channel.downloadResourceToFile(
          msg.messageId,
          resource.fileKey,
          resource.type,
          resourceFilePath,
        );
        console.log("download recourceFile:", recourceFile);
      }
    }
  }
  return filePaths;
}

channel.on("message", async (msg) => {
  console.log("received:", msg);
  const sessionKey = msg.chatId + "+" + msg.senderId;

  if (msg.content.trim() === "/session-new") {
    const entry = newSession(sessionKey);
    await channel.reply(msg, {
      markdown: `✅ 已创建新会话 \`${entry.sessionId}\`，下一条消息生效`,
    });
    return;
  }

  let receivedMsgContent = msg.content;
  if (msg.rawContentType === "interactive") {
    let rawMessage = await channel.fetchRawMessage(msg.messageId);
    console.log("interactiveRawMessage:", rawMessage);
    receivedMsgContent = rawMessage[0].body?.content;
  }
  let resourceFilePaths = await downloadMsgResourceToFile(msg);

  if (msg.replyToMessageId) {
    let replyToMessage = await channel.fetchMessage(msg.replyToMessageId);
    console.log("replyToMessage:", replyToMessage);
    resourceFilePaths.push(
      ...(await downloadMsgResourceToFile(replyToMessage)),
    );
    if (replyToMessage.rawContentType === "interactive") {
      let replyToRawMessage = await channel.fetchRawMessage(
        msg.replyToMessageId,
      );
      console.log("replyToInteractiveRawMessage:", replyToRawMessage);
      let replyToRawContent = replyToRawMessage[0].body?.content;
      receivedMsgContent =
        "```\n" + replyToRawContent + "\n```\n\n---\n\n" + msg.content;
    } else {
      receivedMsgContent = replyToMessage.content + "\n\n---\n\n" + msg.content;
    }
  }

  console.log("resourceFilePaths:", resourceFilePaths);

  // queue non-empty (preserve FIFO), no free slot, or session busy -> queue
  // with an immediate notice; otherwise run right away
  const task = {
    sessionKey,
    run: () =>
      processMessage(msg, sessionKey, receivedMsgContent, resourceFilePaths),
  };
  if (
    taskQueue.length > 0 ||
    runningCount >= MAX_CONCURRENT ||
    runningSessions.has(sessionKey)
  ) {
    taskQueue.push(task);
    await channel.reply(msg, {
      markdown: `⏳ 已加入队列（前面还有 ${taskQueue.length - 1} 个）…`,
    });
    return;
  }
  runningSessions.add(sessionKey);
  runningCount++;
  task.run();
});

async function processMessage(msg, sessionKey, receivedMsgContent, resourceFilePaths) {
  try {
    await channel.stream(
      msg.chatId,
      {
        markdown: async (c) => {
        // card content model: answer + (optional) live thinking appended.
        // thinking stays visible until the first non-thinking output,
        // then gets wiped and replaced by the answer.
        let answer = "";
        let thinking = "";
        let showingThinking = false;
        const push = (p) =>
          // fire-and-forget: catch so a failed card update can't become
          // an unhandled rejection and kill the process
          p.catch((e) => console.error("update failed:", e));
        const ctl = {
          text(t) {
            answer += t;
            if (showingThinking) {
              // first real output: wipe thinking, answer takes its place
              showingThinking = false;
              thinking = "";
              return push(c.setContent(answer));
            }
            return push(c.append(t));
          },
          thinking(t) {
            thinking += t;
            showingThinking = true;
            // re-render the full thinking buffer as a quote block each time
            // (deltas can split anywhere, per-line prefixing needs the whole text)
            const quoted = thinking
              .split("\n")
              .map((l) => "> " + l)
              .join("\n");
            return push(c.setContent((answer ? answer + "\n\n" : "") + quoted));
          },
        };
        try {
          const stats = await runClaudeStream(
            receivedMsgContent +
              (resourceFilePaths?.length > 0
                ? "\n相关文件地址：" + resourceFilePaths
                : ""),
            sessionKey,
            ctl,
          );
          if (stats) {
            const dur =
              stats.durationMs >= 1000
                ? (stats.durationMs / 1000).toFixed(1) + "s"
                : stats.durationMs + "ms";
            push(
              c.setContent(
                answer +
                  `\n\n---\n\n\`${stats.model}\` · 输入 ${stats.inputTokens} · 输出 ${stats.outputTokens} · 耗时 ${dur}`,
              ),
            );
          }
          //   c.append(`\n\n---\n\n<at id=${msg.senderId}></at>`);
        } catch (err) {
          console.error("claude failed:", err);
          await c.append(
            "\n\n⚠️ claude 调用失败:\n\n```\n" +
              String(err.message || err).slice(0, 1000) +
              "\n```",
          );
        }
      },
      },
      {
        replyTo: msg.messageId,
        resolveMentionsInText: true,
      },
    );
  } catch (err) {
    console.error("stream failed:", err);
  } finally {
    completeTask(sessionKey);
  }
}

await channel.connect();
