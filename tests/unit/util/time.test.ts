import assert from "node:assert/strict";
import test from "node:test";
import { msUntilShanghaiMidnight } from "../../../src/util/time.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

test("上海时间 23:59 时距离 0 点还有一分钟", () => {
  const now = Date.UTC(2026, 9, 24, 15, 59, 0);
  assert.equal(msUntilShanghaiMidnight(now), MINUTE);
});

test("上海时间正好 0 点时返回一整天", () => {
  const now = Date.UTC(2026, 9, 24, 16, 0, 0);
  assert.equal(msUntilShanghaiMidnight(now), DAY);
});

test("上海时间中午距离 0 点还有十二小时", () => {
  const now = Date.UTC(2026, 9, 24, 4, 0, 0);
  assert.equal(msUntilShanghaiMidnight(now), 12 * 60 * MINUTE);
});
