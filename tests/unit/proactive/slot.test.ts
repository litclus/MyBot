import assert from "node:assert/strict";
import test from "node:test";
import { proactiveSlotAt } from "../../../src/proactive/slot.js";

const shanghai = (hour: number, minute = 0) => {
  // 上海 = UTC+8，用 UTC 时间反推
  const utcHour = (hour + 24 - 8) % 24;
  const day = hour < 8 ? 25 : 24;
  return new Date(Date.UTC(2026, 9, day, utcHour, minute));
};

test("时段按上海时间划分", () => {
  assert.equal(proactiveSlotAt(shanghai(0)).key, "late_night");
  assert.equal(proactiveSlotAt(shanghai(4, 59)).key, "late_night");
  assert.equal(proactiveSlotAt(shanghai(5)).key, "early_morning");
  assert.equal(proactiveSlotAt(shanghai(8, 59)).key, "early_morning");
  assert.equal(proactiveSlotAt(shanghai(9)).key, "morning");
  assert.equal(proactiveSlotAt(shanghai(11, 59)).key, "morning");
  assert.equal(proactiveSlotAt(shanghai(12)).key, "noon");
  assert.equal(proactiveSlotAt(shanghai(13, 59)).key, "noon");
  assert.equal(proactiveSlotAt(shanghai(14)).key, "afternoon");
  assert.equal(proactiveSlotAt(shanghai(17, 59)).key, "afternoon");
  assert.equal(proactiveSlotAt(shanghai(18)).key, "evening");
  assert.equal(proactiveSlotAt(shanghai(21, 59)).key, "evening");
  assert.equal(proactiveSlotAt(shanghai(22)).key, "night");
  assert.equal(proactiveSlotAt(shanghai(23, 59)).key, "night");
});
