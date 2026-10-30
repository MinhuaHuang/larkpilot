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
const { getDb, recordChatBotMsgSession, getSessionIdByMsgId } = await import("../common.js");

test("recordChatBotMsgSession inserts a message->session row with created_at", () => {
  const before = Date.now();
  recordChatBotMsgSession("om_test_msg_1", "sess-abc-123");
  const after = Date.now();

  const row = getDb()
    .prepare(
      "SELECT message_id, session_id, created_at FROM chat_bot_msg_session WHERE message_id = ?",
    )
    .get("om_test_msg_1");

  assert.ok(row, "row should exist");
  assert.equal(row.session_id, "sess-abc-123");
  // created_at: ISO timestamp captured between the two Date.now() samples
  const createdMs = Date.parse(row.created_at);
  assert.equal(isNaN(createdMs), false, `created_at should be ISO, got ${row.created_at}`);
  assert.ok(
    createdMs >= before && createdMs <= after,
    `created_at ${row.created_at} should fall within [${before}, ${after}]`,
  );
});

test("recordChatBotMsgSession swallows db errors without throwing", () => {
  // undefined session_id fails binding NOT NULL — the write must not
  // escape into the caller (the card stream's producer)
  assert.doesNotThrow(() => recordChatBotMsgSession("om_bad", undefined));
  const row = getDb()
    .prepare("SELECT * FROM chat_bot_msg_session WHERE message_id = ?")
    .get("om_bad");
  assert.equal(row, undefined);
});

test("getSessionIdByMsgId returns the mapped session, null when absent", () => {
  recordChatBotMsgSession("om_test_msg_2", "sess-def-456");
  assert.equal(getSessionIdByMsgId("om_test_msg_2"), "sess-def-456");
  assert.equal(getSessionIdByMsgId("om_no_such_msg"), null);
});

// cleanup the temp db so tmpdir doesn't accumulate wal/shm side files
test.after?.(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(process.env.LARKPILOT_DB + suffix);
    } catch {}
  }
});
