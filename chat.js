import { createLarkChannel } from "@larksuite/channel";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import {
  DATA_DIR,
  CHAT_CWD,
  loadConfig,
  createTaskLogger,
  resolveClaudeCmd,
  decodeChildText,
  recordChatBotMsgSession,
  getSessionIdByMsgId,
  getChatDirectives,
} from "./common.js";

const appLog = createTaskLogger("app");

const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

const config = loadConfig();
if (!config.appId || !config.appSecret) {
  appLog.error(
    "缺少飞书应用配置，请先执行: larkpilot config set appId <appId> appSecret <appSecret>",
  );
  process.exit(1);
}

const channel = createLarkChannel({
  appId: config.appId,
  appSecret: config.appSecret,
  // SDK swallows stream/API failures internally (e.g. "[stream] update
  // failed" after feishu closes a 10min-old card) and only reports them
  // here — route them into our log file so they leave a trace
  logger: {
    error: (...args) => appLog.error("lark:", ...args),
    warn: (...args) => appLog.log("lark warn:", ...args),
    info: (...args) => appLog.log("lark info:", ...args),
    debug: (...args) => appLog.log("lark debug:", ...args),
    trace: (...args) => appLog.log("lark trace:", ...args),
  },
  // default per-chat pipeline serializes handlers (next message waits for
  // the previous one); disable it — concurrency is governed by our own
  // session lock + global slot instead
  chatQueue: { enabled: false },
  // watchdog above the SDK's internal ping: probes the connection, forces a
  // reconnect when it looks stuck; when even that fails, hand recovery to
  // `larkpilot chat restart` — its stop kills this very process (pid file)
  // and its start brings up a fresh one. run via node + index.js directly:
  // the daemon's PATH does not reliably reach the npm bin dir
  keepalive: {
    enabled: true,
    onUnrecoverable: (err) => {
      appLog.error("keepalive unrecoverable, restarting bot:", err);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./index.js", import.meta.url)),
          "chat",
          "restart",
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
    },
  },
});

// ---- sessions ----
// json (chat-session.json) holds only EXECUTED session ids: { [chatId+senderId]: [{ sessionId, expiresAt }] }
// fresh unused ids live in memory (pendingSessions), one per key max,
// get consumed before spawn and land in json when claude closes
const SESSION_FILE = path.join(DATA_DIR, "chat-session.json");
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
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
// onlyExisting: renew only a session already under this key — never adopt a
// foreign one (reply-pinned run keeps the session owned by its original key)
function persistSession(key, entry, onlyExisting = false) {
  const list = sessionStore[key] ?? [];
  const known = list.some((e) => e.sessionId === entry.sessionId);
  if (onlyExisting && !known) return;
  entry.expiresAt = Date.now() + SESSION_TTL_MS;
  if (!known) list.push(entry);
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

// ---- CrossMark abort: messageId -> live task entry ----
// entry: { cancelled: boolean, child: ChildProcess | null, task: queue task, msg }
// registered when a message becomes a task (queued or running), removed in
// processMessage's finally (or by the reaction handler for queued cancels)
const activeTasks = new Map();

// shell:true makes `child` a cmd.exe wrapper — child.kill() only kills the
// shell and leaves claude orphaned; /T takes the whole tree (cmd + claude
// node + its children), /F forces termination
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

// register a task on the activeTasks map and route it through the queue:
// run right away when a slot is free and the session is idle; queue with an
// immediate notice otherwise
async function submitTask(msg, sessionKey, run) {
  // per-chat switches: disabled chats get an immediate offline notice and
  // never queue; a configured chat_prompt_<chatId> rides on msg into the
  // claude prompt (appended at the end — the head must stay free for the
  // /effort-<level> prefix)
  const { disabled, chatPrompt } = getChatDirectives(msg.chatId);
  if (disabled) {
    await channel.reply(msg, { markdown: "助手已下线..." });
    return;
  }
  if (chatPrompt) msg.chatPrompt = chatPrompt;
  const task = { sessionKey, run };
  activeTasks.set(msg.messageId, { cancelled: false, child: null, task, msg });
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
}

// /effort-<level> prefix on a prompt maps to the --effort flag
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function runClaudeStream(prompt, sessionKey, session, ctl, log, task = null, forced = false) {
  log.log("claude prompt:", prompt);
  // parse before any session bookkeeping: an invalid level aborts the run
  // without touching session state; the rejected promise rides the caller's
  // existing error path (card flushes the message, task completes)
  // default effort when the prompt carries no /effort-<level> prefix
  let effort = "medium";
  const effortMatch = prompt.match(/^\/effort-(\S+)\s/);
  if (effortMatch) {
    effort = effortMatch[1];
    if (!EFFORT_LEVELS.includes(effort)) {
      return Promise.reject(
        new Error(
          `无效的 effort 级别 ${effort}，可选值：${EFFORT_LEVELS.join(" | ")}`,
        ),
      );
    }
    // strip the prefix: it's a command for us, not content for claude
    prompt = prompt.slice(effortMatch[0].length);
  }
  // session is resolved once by the caller (processMessage) — the same
  // object flows into the prompt, the db mapping, and this run
  const seedNew = pendingSessions.get(sessionKey) === session;
  if (seedNew) pendingSessions.delete(sessionKey); // consumed before spawn
  // renew expiry before the run: a mid-run crash/restart must not let the
  // session lapse; the close-time persist below still lands the final renewal.
  // forced passes onlyExisting so a borrowed session is renewed only under
  // its owning key, never adopted into this one
  else persistSession(sessionKey, session, forced);
  return new Promise((resolve, reject) => {
    // single command string (no args array + shell:true) to avoid Node's
    // DEP0190 warning; every part is a static flag, a uuid, or a whitelisted
    // effort level — the prompt still goes via stdin
    const cmd =
      `"${resolveClaudeCmd()}" --print --output-format stream-json --verbose ` +
      "--include-partial-messages --permission-mode bypassPermissions " +
      `--effort ${effort} ` +
      // unused id: seed a new session with --session-id;
      // executed id: continue it with --resume
      (seedNew ? "--session-id " : "--resume ") +
      session.sessionId;
    const child = spawn(cmd, {
      cwd: CHAT_CWD,
      shell: true,
      // no console window flash on Windows
      windowsHide: true,
    });
    if (task) {
      task.child = child;
      // CrossMark may have landed inside the dispatch call stack (before
      // this line ran); honor a cancellation that arrived that early
      if (task.cancelled) killTree(child);
    }
    const stderrChunks = [];
    let buffer = "";
    let sawContent = false;
    let resultStats = null;
    const handleLine = (line) => {
      if (!line.trim()) return;
      // console.log(line);
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      // final result event, kept raw for the caller to process
      if (evt.type === "result") {
        resultStats = evt;
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
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      persistSession(sessionKey, session, forced);
      if (code !== 0) {
        // killed via CrossMark: report abort, skip dead-session cleanup —
        // the session itself stays valid for the next --resume
        if (task?.cancelled) return reject(new Error("已中止"));
        const stderr = decodeChildText(Buffer.concat(stderrChunks)).trim();
        // resume hit a session id whose claude-side transcript is gone:
        // drop it from the file so the next message seeds a fresh session
        // instead of retrying the same dead id until TTL
        if (stderr.includes("No conversation found with session ID")) {
          sessionStore[sessionKey] = (sessionStore[sessionKey] ?? []).filter(
            (e) => e.sessionId !== session.sessionId,
          );
          saveSessions();
          log.log("removed dead session:", session.sessionId);
        }
        return reject(new Error(stderr || `claude exited with code ${code}`));
      }
      if (!sawContent) return reject(new Error("claude returned no text"));
      resolve(resultStats);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function downloadMsgResourceToFile(msg, log) {
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
        log.log("download recourceFile:", recourceFile);
      }
    }
  }
  return filePaths;
}

channel.on('cardAction', async (evt) => {
  const log = createTaskLogger(`cardAction|${evt.messageId}`);
  log.log(evt);
  // a row already in chat_bot_msg_session means this card was submitted
  // before — refuse to run it twice
  if (getSessionIdByMsgId(evt.messageId)) {
    return { toast: { type: 'warning', content: '重复提交' } };
  }
  let cardMsg = await channel.fetchRawMessage(evt.messageId);
  let cardContent = cardMsg[0].body?.content;
  // a card that @-mentions a user is locked to that user — anyone else
  // clicking it is rejected
  const atIds = cardContent
    ? [...cardContent.matchAll(/<at id=(ou_[^>]*)><\/at>/g)].map((m) => m[1])
    : [];
  if (atIds.length && !atIds.includes(evt.operator.openId)) {
    return { toast: { type: 'warning', content: '操作无效' } };
  }
  let evtContent = `cardContent: ${cardContent}\ncardAction: ${JSON.stringify(evt.action)}`;
  // hand evtContent to claude on the clicking user's own session in this
  // chat; same queue / concurrency / abort machinery as a normal message
  const sessionKey = evt.chatId + "+" + evt.operator.openId;
  const msg = {
    messageId: evt.messageId,
    chatId: evt.chatId,
    senderId: evt.operator.openId,
    content: evtContent,
  };
  await submitTask(
    msg,
    sessionKey,
    () => processMessage(msg, sessionKey, evtContent, [], Date.now(), log),
  );
  // mark this card as submitted; session_id "-" is a placeholder — this row
  // only flags the cardAction as seen, it maps to no claude session
  recordChatBotMsgSession(evt.messageId, "-");
  return { toast: { type: 'success', content: '已提交' } };
});

channel.on("reaction", async (evt) => {
  const log = createTaskLogger(`reaction|${evt.messageId}`);
  log.log(evt);
  if (evt.action !== "added" || evt.emojiType !== "CrossMark") return;
  const entry = activeTasks.get(evt.messageId);
  if (!entry) return; // task finished or never existed
  if (entry.child) {
    // running: mark first so the close handler reports abort, then kill the
    // process tree — the card footer and session persistence ride the
    // existing close path
    entry.cancelled = true;
    killTree(entry.child);
    log.log(`aborting task, pid=${entry.child.pid}`);
    // await channel.reply(entry.msg, { markdown: "⏹ 已停止任务" });
  } else {
    // queued: remove from the queue before it spawns; idx === -1 means it
    // was just dispatched (child not yet set) — the spawn-time cancelled
    // check in runClaudeStream covers that race
    const idx = taskQueue.indexOf(entry.task);
    if (idx === -1) return;
    taskQueue.splice(idx, 1);
    activeTasks.delete(evt.messageId);
    log.log("cancelled queued task");
    await channel.reply(entry.msg, { markdown: "⏹ 已取消排队" });
  }
});

channel.on("message", async (msg) => {
  // task-scoped logger: every line prefixed `time|messageId| `
  const log = createTaskLogger(`chat|${msg.messageId}`);
  const receivedAt = Date.now();
  log.log("received:", msg);
  const sessionKey = msg.chatId + "+" + msg.senderId;

  // "/session-new" alone arms a fresh session for the next message;
  // "/session-new <question>" arms one and runs the question on it right
  // away — strip the command and fall through to the normal message path.
  // the flag keeps the explicit command winning over a reply-pinned session
  let armedPending = false;
  const sessionNewMatch = msg.content
    .trim()
    .match(/^\/session-new(?:\s+([\s\S]*\S))?\s*$/);
  if (sessionNewMatch) {
    const entry = newSession(sessionKey);
    if (!sessionNewMatch[1]) {
      await channel.reply(msg, {
        markdown: `✅ 已创建新会话 \`${entry.sessionId}\`，下一条消息生效`,
      });
      return;
    }
    msg.content = sessionNewMatch[1];
    armedPending = true;
  }

  let receivedMsgContent = msg.content;
  if (msg.rawContentType === "interactive") {
    let rawMessage = await channel.fetchRawMessage(msg.messageId);
    log.log("interactiveRawMessage:", rawMessage);
    receivedMsgContent = rawMessage[0].body?.content;
  }
  let resourceFilePaths = await downloadMsgResourceToFile(msg, log);

  // a reply to a bot card means "continue that card's conversation": pin
  // the run to the mapped session and skip quoting the card text. the
  // session is looked up across all users — a group member may reply to a
  // card the bot sent to someone else. the pin is one-shot: an armed
  // pending session stays armed, so later messages still open the new one.
  // anything else — no mapping, session unknown/expired/still running, or
  // an armed /session-new — falls back to quoting the replied-to content
  let replySession = null;
  if (msg.replyToMessageId && !armedPending) {
    const replySessionId = getSessionIdByMsgId(msg.replyToMessageId);
    replySession =
      Object.values(sessionStore)
        .flat()
        .find(
          (e) => e.sessionId === replySessionId && e.expiresAt > Date.now(),
        ) ?? null;
  }
  if (msg.replyToMessageId && !replySession) {
    let replyToMessage = await channel.fetchMessage(msg.replyToMessageId);
    log.log("replyToMessage:", replyToMessage);
    resourceFilePaths.push(...(await downloadMsgResourceToFile(replyToMessage, log)));
    if (replyToMessage.rawContentType === "interactive") {
      let replyToRawMessage = await channel.fetchRawMessage(
        msg.replyToMessageId,
      );
      log.log("replyToInteractiveRawMessage:", replyToRawMessage);
      let replyToRawContent = replyToRawMessage[0].body?.content;
      receivedMsgContent =
        "```\n" + replyToRawContent + "\n```\n\n---\n\n" + msg.content;
    } else {
      receivedMsgContent = replyToMessage.content + "\n\n---\n\n" + msg.content;
    }
  }

  // log.log("resourceFilePaths:", resourceFilePaths);

  // queue non-empty (preserve FIFO), no free slot, or session busy -> queue
  // with an immediate notice; otherwise run right away
  await submitTask(
    msg,
    sessionKey,
    () =>
      processMessage(msg, sessionKey, receivedMsgContent, resourceFilePaths, receivedAt, log, replySession),
  );
});

async function processMessage(msg, sessionKey, receivedMsgContent, resourceFilePaths, receivedAt, log, forcedSession = null) {
  try {
    // the activeTasks entry registered by the message handler; null for
    // direct runClaudeStream callers (none today) — abort is simply inert
    const task = activeTasks.get(msg.messageId) ?? null;
    // resolve the session once up front: it feeds the prompt, the db
    // message->session mapping, and the claude run itself. a reply-pinned
    // session (bot card) wins; everything else resolves pending/store
    const session = forcedSession ?? getOrCreateSession(sessionKey);
    // feishu closes a streaming card 10min after creation; roll over to a
    // fresh card every 9min30s. The switch is timer-driven, not output-driven
    // — claude can run silent for a long stretch, and a delta-triggered check
    // would fire too late and write to an already-closed card.
    const CARD_TTL_MS = 9 * 60 * 1000 + 30 * 1000;
    // roll a card over early at 29000 chars — safely below the SDK's own
    // 30000-element split, so our rollover always fires first
    const CARD_MAX_CHARS = 29000;

    // per-card content: answer + thinking both reset at rollover — a fresh
    // card carries only content not yet shown, never a replay of the old one
    let answer = "";
    let live = null; // active card renderer; deltas route here, null = no card
    let closeCard = null; // current card's rollover trigger, set by its producer
    let done = false; // footer flushed, stream finished

    const ctl = {
      text(t) {
        answer += t;
        // card full: finalize it with everything so far (this delta rides
        // along in the flush) and let the next delta open a fresh card
        if (answer.length > CARD_MAX_CHARS) {
          closeCard?.("rollover");
          return;
        }
        needCard();
        live?.onText();
      },
      thinking(t) {
        needCard();
        live?.onThinking(t);
      },
    };

    // claude runs once across all cards; result is normalized so it never
    // rejects. started right away — deltas arriving before a card is live
    // just buffer in `answer` until the producer picks them up
    let settled = null;
    const startClaude = () =>
      (settled ??= runClaudeStream(
        receivedMsgContent +
          (resourceFilePaths?.length > 0 ? "\n相关文件地址：" + resourceFilePaths: "") +
          (msg.chatPrompt ? `\n${msg.chatPrompt}` : "") +
          "\n**禁止使用 subagent 子进程中处理逻辑，所有逻辑都在当前进程中完成**" +
          `\n来自群聊(id:${msg.chatId})中的用户(id:${msg.senderId})，当前会话(id:${session.sessionId})`,
        sessionKey,
        session,
        ctl,
        log,
        task,
        forcedSession != null,
      ).then(
        (stats) => ({ ok: true, stats }),
        (err) => ({ ok: false, err }),
      ));

    // cards open lazily: the head card anchors the reply, later ones only
    // when something actually needs to render — the first delta after a
    // rollover, or the footer when claude finishes cardless. `live`/`opening`
    // keep it idempotent: at most one card being opened or active at a time
    let opening = false;
    function needCard() {
      if (live || opening) return;
      opening = true;
      runCard()
        .catch((e) => log.error("card stream failed:", e))
        .finally(() => (opening = false));
    }

    async function runCard() {
      await channel.stream(
        msg.chatId,
        {
          markdown: async (c) => {
            // map this card's message to the run's session, so a reply to
            // any card (rollover included) can find back its conversation
            recordChatBotMsgSession(c.messageId, session.sessionId);
            // card content model: answer + (optional) live thinking appended.
            // thinking stays visible until the first non-thinking output,
            // then gets wiped and replaced by the answer.
            let thinking = "";
            let showingThinking = false;
            const push = (p) =>
              // fire-and-forget: catch so a failed card update can't become
              // an unhandled rejection and kill the process
              p.catch((e) => log.error("update failed:", e));
            // throttle: at most one card update per 200ms; content arriving inside
            // the window replaces the pending one and is sent when it reopens.
            // send() never awaits — handleLine stays fully synchronous
            let lastSentAt = 0;
            let pendingContent = null;
            let trailingTimer = null;
            const send = (content) => {
              if (trailingTimer) {
                pendingContent = content;
                return;
              }
              const wait = 200 - (Date.now() - lastSentAt);
              if (wait <= 0) {
                lastSentAt = Date.now();
                push(c.setContent(content));
              } else {
                pendingContent = content;
                trailingTimer = setTimeout(() => {
                  trailingTimer = null;
                  lastSentAt = Date.now();
                  push(c.setContent(pendingContent));
                  pendingContent = null;
                }, wait);
              }
            };
            // final update: cancel any pending throttle timer so a stale
            // thinking snapshot can't land after the closing content
            const flush = (content) => {
              if (trailingTimer) {
                clearTimeout(trailingTimer);
                trailingTimer = null;
                pendingContent = null;
              }
              lastSentAt = Date.now();
              push(c.setContent(content));
            };
            live = {
              onText() {
                if (showingThinking) {
                  // first real output: wipe thinking, answer takes its place
                  showingThinking = false;
                  thinking = "";
                }
                send(answer);
              },
              onThinking(t) {
                thinking += t;
                // keep only the tail — card content has practical length limits
                if (thinking.length > 1000) thinking = thinking.slice(-1000);
                showingThinking = true;
                // re-render the full thinking buffer as a quote block each time
                // (deltas can split anywhere, per-line prefixing needs the whole text)
                const quoted = thinking
                  .split("\n")
                  .map((l) => "> " + l)
                  .join("\n");
                send((answer ? answer + "\n\n" : "") + quoted);
              },
            };
            // render whatever piled up while the card was being opened
            if (answer) send(answer);
            // card lifetime: rollover (TTL timer or content overflow) vs
            // claude result, whichever first
            let rollover;
            const expired = new Promise((r) => (rollover = r));
            closeCard = rollover; // ctl.text requests closure on overflow
            const timer = setTimeout(() => rollover("rollover"), CARD_TTL_MS);
            const result = await Promise.race([startClaude(), expired]);
            clearTimeout(timer);
            closeCard = null;
            live = null;
            if (result === "rollover") {
              // finalize this card with its plain answer; the next card
              // starts empty — content already shown is never replayed
              flush(answer);
              // odd ``` count = claude is mid-code-block: the next card
              // reopens the fence so the rest of the code still renders
              // as code instead of leaking out into markdown
              answer =
                (answer.match(/```/g) ?? []).length % 2 ? "```\n" : "";
              return;
            }
            if (result.ok) {
              const stats = result.stats;
              log.log(`claude result : ${JSON.stringify(stats)}`);
              if (stats) {
                const [model, usage = {}] =
                  Object.entries(stats.modelUsage ?? {})[0] ?? ["unknown"];
                const inputTokens = usage.inputTokens ?? 0;
                const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;
                const durMs = Date.now() - receivedAt;
                const dur =
                  durMs >= 1000
                    ? (durMs / 1000).toFixed(1) + "s"
                    : durMs + "ms";
                const inTotal = inputTokens + cacheReadInputTokens;
                const cachePct =
                  inTotal > 0
                    ? ((cacheReadInputTokens / inTotal) * 100).toFixed(2) + "%"
                    : "0%";
                flush(
                  answer +
                    `\n\n---\n\n\`${model}\` · 输入 ${inTotal}（缓存率 ${cachePct}）· 输出 ${usage.outputTokens ?? 0} · 耗时 ${dur}`,
                );
              } else {
                flush(answer + "\n\n⚠️ 程序异常退出");
              }
              //   c.append(`\n\n---\n\n<at id=${msg.senderId}></at>`);
            } else if (task?.cancelled) {
              flush(answer + "\n\n⏹ 已中止");
            } else {
              log.error("claude failed:", result.err);
              flush(
                answer +
                  "\n\n⚠️ claude 调用失败:\n\n```\n" +
                  String(result.err.message || result.err).slice(0, 1000) +
                  "\n```",
              );
            }
            done = true;
          },
        },
        {
          replyTo: msg.messageId,
          resolveMentionsInText: true,
        },
      );
    }

    needCard(); // head card anchors the reply ("Thinking...")
    await startClaude();
    // claude finished with no live card (rollover gap): open the final
    // card just for the footer
    if (!done && !live) needCard();
  } catch (err) {
    log.error("stream failed:", err);
  } finally {
    activeTasks.delete(msg.messageId);
    completeTask(sessionKey);
  }
}

appLog.log("bot starting");
await channel.connect();
appLog.log("bot connected");
