import assert from "node:assert/strict";
import test from "node:test";
import { trimHistory } from "../../../src/chat/history.js";
import type { RecentMessage } from "../../../src/db/repository.js";

function row(
  id: string,
  role: RecentMessage["role"],
  metadata: Record<string, unknown> = {},
  text = "",
): RecentMessage {
  return {
    id,
    conversationId: "c1",
    personId: null,
    role,
    content: { parts: text ? [{ type: "text", text }] : [] },
    platformMsgId: null,
    replyTo: null,
    createdAt: new Date(),
    expiresAt: null,
    importance: null,
    tags: [],
    metadata,
    personName: null,
    personKey: null,
  } as RecentMessage;
}

test("工具消息不进入下一轮历史", () => {
  const rows = [
    row("u1", "user"),
    row("t1", "tool", { toolCallId: "call-1" }),
    row("a1", "assistant", { toolCalls: [{}] }),
    row("a2", "assistant"),
    row("u2", "user"),
  ];

  assert.deepEqual(
    trimHistory(rows).map((item) => item.id),
    ["u1", "a2", "u2"],
  );
});

test("超出 token 预算从最早开始丢", () => {
  const rows = Array.from({ length: 3 }, (_, index) =>
    row(`m${index}`, index % 2 === 0 ? "user" : "assistant", {}, "聊".repeat(400)),
  );

  const trimmed = trimHistory(rows, { maxTokens: 900, minMessages: 1 });
  assert.deepEqual(
    trimmed.map((item) => item.id),
    ["m1", "m2"],
  );
});

test("预算不够时至少保留最少消息数", () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    row(`m${index}`, index % 2 === 0 ? "user" : "assistant", {}, "聊".repeat(400)),
  );

  const trimmed = trimHistory(rows, { maxTokens: 100, minMessages: 3 });
  assert.deepEqual(
    trimmed.map((item) => item.id),
    ["m2", "m3", "m4"],
  );
});
