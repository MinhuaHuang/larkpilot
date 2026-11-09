import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

// must land before common.js is loaded — getDb() reads it at first call, but
// ESM hoists static imports, so the env assignment has to precede a dynamic
// import of the module under test
process.env.LARKPILOT_DB = path.join(
  os.tmpdir(),
  `larkpilot-test-${process.pid}-${Date.now()}.db`,
);
const { isAlive } = await import("../common.js");

// a real live process whose command line ends with SCRIPT — the same shape
// as the chat bot (node <abs script path>)
const SCRIPT = path.join(os.tmpdir(), `larkpilot-isalive-${process.pid}.js`);
fs.writeFileSync(SCRIPT, "setTimeout(() => {}, 60000);");
const child = spawn(process.execPath, [SCRIPT], { windowsHide: true });
// let the child fully appear in the process table before probing
await new Promise((r) => setTimeout(r, 500));

// the matcher shape callers pass: case-insensitive suffix check (windows
// paths), tolerating the trailing quote a spaced path gets
const endsWith = (suffix) => (cmdline) =>
  cmdline.replace(/"$/, "").toLowerCase().endsWith(suffix.toLowerCase());

test("isAlive: bare pid probe still works without a matcher", () => {
  assert.equal(isAlive(child.pid), true);
});

test("isAlive: matcher satisfied by the command line passes", () => {
  assert.equal(isAlive(child.pid, endsWith(SCRIPT)), true);
});

test("isAlive: matcher is the caller's call (case-insensitive here)", () => {
  assert.equal(isAlive(child.pid, endsWith(SCRIPT.toUpperCase())), true);
});

test("isAlive: live pid whose command line fails the matcher counts as dead", () => {
  // pid-reuse shape: some other process occupies the pid file's pid
  assert.equal(
    isAlive(child.pid, endsWith(path.join(os.tmpdir(), "other-bot.js"))),
    false,
  );
});

test("isAlive: exited pid -> false with and without matcher", async () => {
  const short = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => short.on("exit", r));
  assert.equal(isAlive(short.pid), false);
  assert.equal(isAlive(short.pid, endsWith(SCRIPT)), false);
});

test.after(() => {
  try {
    child.kill();
  } catch {}
  try {
    fs.unlinkSync(SCRIPT);
  } catch {}
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(process.env.LARKPILOT_DB + suffix);
    } catch {}
  }
});
