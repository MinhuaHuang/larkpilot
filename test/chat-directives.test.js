import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import fs from "fs";

// must land before common.js is loaded — getDb() reads it at first call, but
// ESM hoists static imports, so the env assignment has to precede a dynamic
// import of the module under test
process.env.LARKPILOT_DB = path.join(
  os.tmpdir(),
  `larkpilot-test-${process.pid}-${Date.now()}.db`,
);
const {
  setConfig,
  getChatDirectives,
  setChatModel,
  setChatStreamEndAt,
  getMaxConcurrent,
  getDb,
  loadConfig,
} = await import("../common.js");

test("getChatDirectives: chat enabled with no prompt when nothing configured", () => {
  const d = getChatDirectives("oc_none");
  assert.equal(d.disabled, false);
  assert.equal(d.chatPrompt, null);
  assert.equal(d.chatModel, null);
  assert.equal(d.streamEndAt, true);
});

test("getChatDirectives: chat_<chatId> disabled applies only to that chat", () => {
  setConfig("chat_oc_a", JSON.stringify({ prompt: "", disabled: true }));
  setConfig("chat_oc_b", JSON.stringify({ prompt: "", disabled: true }));
  assert.equal(getChatDirectives("oc_a").disabled, true);
  assert.equal(getChatDirectives("oc_b").disabled, true);
  assert.equal(getChatDirectives("oc_c").disabled, false);
});

test("getChatDirectives: malformed chat_<chatId> value fails open", () => {
  setConfig("chat_oc_bad", "not json");
  assert.equal(getChatDirectives("oc_bad").disabled, false);
  assert.equal(getChatDirectives("oc_bad").chatPrompt, null);
  assert.equal(getChatDirectives("oc_bad").streamEndAt, true);
});

test("getChatDirectives: stream_end_at defaults to true, explicit false wins", () => {
  setConfig(
    "chat_oc_se",
    JSON.stringify({ prompt: "", disabled: false, stream_end_at: false }),
  );
  assert.equal(getChatDirectives("oc_se").streamEndAt, false);
  setConfig("chat_oc_se", JSON.stringify({ prompt: "", disabled: false }));
  assert.equal(getChatDirectives("oc_se").streamEndAt, true);
});

test("getChatDirectives: prompt applies only to that chat", () => {
  setConfig(
    "chat_oc_c",
    JSON.stringify({ prompt: "你是测试群的技术助手", disabled: false }),
  );
  assert.equal(getChatDirectives("oc_c").chatPrompt, "你是测试群的技术助手");
  assert.equal(getChatDirectives("oc_a").chatPrompt, null);
});

test("getChatDirectives: empty prompt counts as unset", () => {
  setConfig("chat_oc_empty", JSON.stringify({ prompt: "", disabled: false }));
  assert.equal(getChatDirectives("oc_empty").chatPrompt, null);
});

test("getChatDirectives: model returns the per-chat override, null when empty", () => {
  setConfig(
    "chat_oc_m",
    JSON.stringify({ prompt: "", disabled: false, model: "sonnet" }),
  );
  assert.equal(getChatDirectives("oc_m").chatModel, "sonnet");
  setConfig(
    "chat_oc_m",
    JSON.stringify({ prompt: "", disabled: false, model: "" }),
  );
  assert.equal(getChatDirectives("oc_m").chatModel, null);
});

test("setChatModel: creates the chat key when absent", () => {
  setChatModel("oc_new", "sonnet");
  assert.deepEqual(JSON.parse(loadConfig().chat_oc_new), { model: "sonnet" });
  assert.equal(getChatDirectives("oc_new").chatModel, "sonnet");
});

test("setChatModel: keeps existing prompt/disabled, replaces old model", () => {
  setConfig(
    "chat_oc_keep",
    JSON.stringify({ prompt: "群指令", disabled: false, model: "haiku" }),
  );
  setChatModel("oc_keep", "sonnet");
  assert.deepEqual(JSON.parse(loadConfig().chat_oc_keep), {
    prompt: "群指令",
    disabled: false,
    model: "sonnet",
  });
});

test("setChatModel: overwrites an unparseable existing value", () => {
  setConfig("chat_oc_broken", "not json");
  setChatModel("oc_broken", "sonnet");
  assert.deepEqual(JSON.parse(loadConfig().chat_oc_broken), { model: "sonnet" });
});

test("setChatStreamEndAt: creates the chat key when absent", () => {
  setChatStreamEndAt("oc_se_new", false);
  assert.deepEqual(JSON.parse(loadConfig().chat_oc_se_new), {
    stream_end_at: false,
  });
  assert.equal(getChatDirectives("oc_se_new").streamEndAt, false);
});

test("setChatStreamEndAt: keeps existing fields, replaces old value", () => {
  setConfig(
    "chat_oc_se_keep",
    JSON.stringify({
      prompt: "群指令",
      disabled: false,
      model: "sonnet",
      stream_end_at: true,
    }),
  );
  setChatStreamEndAt("oc_se_keep", false);
  assert.deepEqual(JSON.parse(loadConfig().chat_oc_se_keep), {
    prompt: "群指令",
    disabled: false,
    model: "sonnet",
    stream_end_at: false,
  });
});

test("setChatStreamEndAt: overwrites an unparseable existing value", () => {
  setConfig("chat_oc_se_broken", "not json");
  setChatStreamEndAt("oc_se_broken", false);
  assert.deepEqual(JSON.parse(loadConfig().chat_oc_se_broken), {
    stream_end_at: false,
  });
});

test("getMaxConcurrent: defaults to 2, config max_concurrent wins, invalid falls back", () => {
  assert.equal(getMaxConcurrent(), 2);
  setConfig("max_concurrent", "4");
  assert.equal(getMaxConcurrent(), 4);
  setConfig("max_concurrent", "abc");
  assert.equal(getMaxConcurrent(), 2);
  setConfig("max_concurrent", "0");
  assert.equal(getMaxConcurrent(), 2);
  setConfig("max_concurrent", "2.5");
  assert.equal(getMaxConcurrent(), 2);
  // restore so later tests see the default
  getDb().prepare("DELETE FROM config WHERE key = ?").run("max_concurrent");
  assert.equal(getMaxConcurrent(), 2);
});

// cleanup the temp db so tmpdir doesn't accumulate wal/shm side files
test.after?.(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(process.env.LARKPILOT_DB + suffix);
    } catch {}
  }
});
