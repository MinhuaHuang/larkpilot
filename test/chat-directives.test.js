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
const { setConfig, getChatDirectives } = await import("../common.js");

test("getChatDirectives: chat enabled with no prompt when nothing configured", () => {
  const d = getChatDirectives("oc_none");
  assert.equal(d.disabled, false);
  assert.equal(d.chatPrompt, null);
});

test("getChatDirectives: disable_chat_ids disables only listed chats", () => {
  setConfig("disable_chat_ids", '["oc_a","oc_b"]');
  assert.equal(getChatDirectives("oc_a").disabled, true);
  assert.equal(getChatDirectives("oc_b").disabled, true);
  assert.equal(getChatDirectives("oc_c").disabled, false);
});

test("getChatDirectives: malformed disable_chat_ids fails open", () => {
  setConfig("disable_chat_ids", "oc_a");
  assert.equal(getChatDirectives("oc_a").disabled, false);
});

test("getChatDirectives: empty-string entries never match a real chat id", () => {
  setConfig("disable_chat_ids", '[""]');
  assert.equal(getChatDirectives("oc_a").disabled, false);
});

test("getChatDirectives: chat_prompt_<chatId> applies only to that chat", () => {
  setConfig("chat_prompt_oc_c", "你是测试群的技术助手");
  assert.equal(getChatDirectives("oc_c").chatPrompt, "你是测试群的技术助手");
  assert.equal(getChatDirectives("oc_a").chatPrompt, null);
});

test("getChatDirectives: empty chat_prompt value counts as unset", () => {
  setConfig("chat_prompt_oc_empty", "");
  assert.equal(getChatDirectives("oc_empty").chatPrompt, null);
});

// cleanup the temp db so tmpdir doesn't accumulate wal/shm side files
test.after?.(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(process.env.LARKPILOT_DB + suffix);
    } catch {}
  }
});
