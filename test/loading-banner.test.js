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
const { setConfig, getLoadingBannerImg, getDb } = await import("../common.js");

const KEY = "lark_stream_loading_banner_img";
const clear = () => getDb().prepare("DELETE FROM config WHERE key = ?").run(KEY);

test("getLoadingBannerImg: no config -> banner off at any round", () => {
  clear();
  assert.equal(getLoadingBannerImg(1), null);
  assert.equal(getLoadingBannerImg(4), null);
});

test("getLoadingBannerImg: default only -> default at every round", () => {
  setConfig(KEY, JSON.stringify({ default: "img_default" }));
  assert.equal(getLoadingBannerImg(1), "img_default");
  assert.equal(getLoadingBannerImg(3), "img_default");
  assert.equal(getLoadingBannerImg(4), "img_default");
  assert.equal(getLoadingBannerImg(100), "img_default");
});

test("getLoadingBannerImg: default + heavy -> default for round 1-3, heavy from round 4 on", () => {
  setConfig(KEY, JSON.stringify({ default: "img_default", heavy: "img_heavy" }));
  assert.equal(getLoadingBannerImg(1), "img_default");
  assert.equal(getLoadingBannerImg(2), "img_default");
  assert.equal(getLoadingBannerImg(3), "img_default");
  assert.equal(getLoadingBannerImg(4), "img_heavy");
  assert.equal(getLoadingBannerImg(5), "img_heavy");
});

test("getLoadingBannerImg: heavy only -> off for round 1-3, heavy from round 4 on", () => {
  setConfig(KEY, JSON.stringify({ heavy: "img_heavy" }));
  assert.equal(getLoadingBannerImg(3), null);
  assert.equal(getLoadingBannerImg(4), "img_heavy");
});

test("getLoadingBannerImg: empty-string values count as unset", () => {
  setConfig(KEY, JSON.stringify({ default: "", heavy: "img_heavy" }));
  assert.equal(getLoadingBannerImg(1), null);
  assert.equal(getLoadingBannerImg(4), "img_heavy");
  setConfig(KEY, JSON.stringify({ default: "", heavy: "" }));
  assert.equal(getLoadingBannerImg(4), null);
});

test("getLoadingBannerImg: malformed value fails off", () => {
  setConfig(KEY, "not json");
  assert.equal(getLoadingBannerImg(1), null);
  assert.equal(getLoadingBannerImg(4), null);
});

// cleanup the temp db so tmpdir doesn't accumulate wal/shm side files
test.after?.(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(process.env.LARKPILOT_DB + suffix);
    } catch {}
  }
});
