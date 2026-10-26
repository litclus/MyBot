import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { InboundMessage } from "../../src/adapters/qq/types.js";
import { Bot } from "../../src/app/bot.js";
import { resolveMentions } from "../../src/chat/mentions.js";
import { closeDb, db } from "../../src/db/client.js";
import { conversationMembers, conversations, persons } from "../../src/db/schema.js";
import { getMentionCandidates, upsertConversation, upsertMember, upsertPerson } from "../../src/db/repository.js";
import type { ModelProvider } from "../../src/ports/model.js";

const candidates = [
  { token: "u123abc", openid: "OPENID-123", name: "张三", role: "member" },
];

const group = resolveMentions("你好 [[mention:u123abc]] 看下", candidates, "group");
assert.ok(group.content.includes('<qqbot-at-user id="OPENID-123" />'));
assert.ok(group.display.includes("@张三"));
assert.ok(!group.content.includes("[[mention:"));

const dm = resolveMentions("[[mention:u123abc]] 在吗", candidates, "dm");
assert.ok(dm.content.includes("@张三"));
assert.ok(!dm.content.includes("qqbot-at-user"));

const unknown = resolveMentions("[[mention:nope]] hi", candidates, "group");
assert.ok(!unknown.content.includes("[[mention:"));
assert.equal(unknown.content, "hi");
console.log("RESOLVE OK");

try {
  const person = await upsertPerson({ personKey: "smoke:mention", displayName: "张三" });
  const conversation = await upsertConversation({
    platform: "qq",
    externalId: "group:mention",
    kind: "group",
    title: "Mention 冒烟群",
  });
  await upsertMember({
    conversationId: conversation.id,
    externalId: "OPENID-123",
    personId: person.id,
    nickname: "张三",
    role: "member",
  });

  const mentionCandidates = await getMentionCandidates(conversation.id);
  const token = mentionCandidates[0]?.token;
  assert.ok(token, "应该有 mention token");

  const replies: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    capabilities: { vision: false, tools: true, json: true, cache: false },
    chat: async () => ({
      text: `{"messages":[{"plainText":"[[mention:${token}]] 你看下"}]}`,
    }),
  };
  const bot = new Bot({
    provider,
    send: async (input) => {
      replies.push(input.text);
    },
  });

  const base: InboundMessage = {
    platform: "qq",
    messageId: `smoke-mention-${Date.now()}`,
    conversation: { externalId: "group:mention", kind: "group" },
    sender: { externalId: "OPENID-123", personKey: "smoke:mention", name: "张三" },
    text: "测试 @",
    attachments: [],
    isMention: true,
    receivedAt: new Date(),
    raw: {},
  };

  await bot.handle(base);
  assert.equal(replies.length, 1);
  assert.ok(replies[0]?.includes('<qqbot-at-user id="OPENID-123" />'), "应渲染成 QQ @ 标签");
  assert.ok(!replies[0]?.includes("[[mention:"));
  console.log("BOT @ OK");

  const noMentionReplies: string[] = [];
  const plainProvider: ModelProvider = {
    id: "fake",
    capabilities: { vision: false, tools: true, json: true, cache: false },
    chat: async () => ({ text: '{"messages":[{"plainText":"普通回复，不@人"}]}' }),
  };
  const plainBot = new Bot({
    provider: plainProvider,
    send: async (input) => {
      noMentionReplies.push(input.text);
    },
  });
  await plainBot.handle({
    ...base,
    messageId: `smoke-plain-${Date.now()}`,
  });
  assert.ok(!noMentionReplies[0]?.includes("qqbot-at-user"), "不应自动 @ 提问者");
  console.log("NO AUTO @ OK");

  console.log("MENTION OK");

  await db.delete(conversationMembers).where(eq(conversationMembers.personId, person.id));
  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  await db.delete(persons).where(eq(persons.id, person.id));
} finally {
  await closeDb();
}

