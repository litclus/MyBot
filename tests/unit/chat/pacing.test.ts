import assert from "node:assert/strict";
import test from "node:test";
import { gapMsFor } from "../../../src/chat/pacing.js";

test("gapMsFor 用模型给的秒数", () => {
  assert.equal(
    gapMsFor(
      { plainText: "a", voiceText: "", images: [], stickers: [], gapSeconds: 1.5 },
      "上一条",
    ),
    1500,
  );
  assert.equal(
    gapMsFor(
      { plainText: "a", voiceText: "", images: [], stickers: [], gapSeconds: 0 },
      "上一条",
    ),
    0,
  );
});

test("gapMsFor 没给 gap 就按文本长度估", () => {
  const short = gapMsFor({ plainText: "a", voiceText: "", images: [], stickers: [] }, "短");
  const long = gapMsFor(
    { plainText: "a", voiceText: "", images: [], stickers: [] },
    "长".repeat(200),
  );
  for (const ms of [short, long]) assert.ok(ms >= 300 && ms <= 2500, `越界: ${ms}`);
  assert.ok(long >= short, "长文本应该等更久");
});
