import assert from "node:assert/strict";
import test from "node:test";
import { shouldCancelPrevious } from "../../../src/chat/queue.js";

const base = {
  state: "thinking" as const,
  conversationKind: "group" as const,
  isMention: false,
  gapMs: 10_000,
  cancelWindowMs: 3_000,
};

test("群里 @ 不受 3 秒窗口限制", () => {
  assert.equal(shouldCancelPrevious({ ...base, isMention: true }), true);
});

test("群里普通消息仍然看 3 秒窗口", () => {
  assert.equal(shouldCancelPrevious({ ...base, gapMs: 2_999 }), true);
  assert.equal(shouldCancelPrevious({ ...base, gapMs: 3_000 }), false);
});

test("发送阶段不取消", () => {
  assert.equal(shouldCancelPrevious({ ...base, state: "sending", isMention: true }), false);
});

test("私聊不因为 isMention=true 就取消", () => {
  assert.equal(
    shouldCancelPrevious({ ...base, conversationKind: "dm", isMention: true, gapMs: 3_000 }),
    false,
  );
});
