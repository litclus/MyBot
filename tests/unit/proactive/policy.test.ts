import assert from "node:assert/strict";
import test from "node:test";
import { canProactivelyReply } from "../../../src/proactive/policy.js";

test("canProactivelyReply 只接受最近用户消息", () => {
  const now = Date.now();
  assert.equal(
    canProactivelyReply({ role: "user", createdAt: new Date(now - 60_000) }, now, 5 * 60_000),
    true,
  );
  assert.equal(
    canProactivelyReply({ role: "assistant", createdAt: new Date(now - 60_000) }, now, 5 * 60_000),
    false,
  );
  assert.equal(
    canProactivelyReply({ role: "user", createdAt: new Date(now - 6 * 60_000) }, now, 5 * 60_000),
    false,
  );
  assert.equal(canProactivelyReply(undefined, now), false);
});

test("canProactivelyReply 拒绝未来时间", () => {
  const now = Date.now();
  assert.equal(
    canProactivelyReply({ role: "user", createdAt: new Date(now + 60_000) }, now),
    false,
  );
});
