import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { InboundMessage } from "../../src/adapters/qq/types.js";
import { Bot } from "../../src/app/bot.js";
import { markdownImageSize } from "../../src/media/display.js";
import { closeDb, db } from "../../src/db/client.js";
import { conversationMembers, conversations, persons } from "../../src/db/schema.js";
import { upsertConversation, upsertPerson } from "../../src/db/repository.js";
import type { ModelProvider } from "../../src/ports/model.js";

assert.equal(markdownImageSize(null, null), "");
assert.equal(markdownImageSize(300, 300), " #200px #200px");
assert.equal(markdownImageSize(240, 354), " #136px #200px");
assert.equal(markdownImageSize(480, 320), " #200px #133px");
assert.equal(markdownImageSize(100, 100), " #100px #100px", "小图不放大");

try {
  const person = await upsertPerson({ personKey: "smoke:media", displayName: "小明" });
  const conversation = await upsertConversation({
    platform: "qq",
    externalId: "group:media",
    kind: "group",
    title: "Media 冒烟群",
  });

  const markdown: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    capabilities: { vision: false, tools: true, json: true, cache: false },
    chat: async () => ({ text: '{"messages":[{"plainText":"看这个","stickers":[12]}]}' }),
  };
  const bot = new Bot({
    provider,
    send: async () => undefined,
    sendMarkdown: async (input) => {
      markdown.push(input.content);
    },
    resolveImage: async () => ({
      url: "qqbot-media://image/v1/test",
      width: 300,
      height: 300,
      mime: "image/webp",
    }),
  });

  const inbound: InboundMessage = {
    platform: "qq",
    messageId: `smoke-media-${Date.now()}`,
    conversation: { externalId: "group:media", kind: "group" },
    sender: { externalId: "u1", personKey: "smoke:media", name: "小明" },
    text: "来个表情包",
    attachments: [],
    isMention: true,
    receivedAt: new Date(),
    raw: {},
  };

  await bot.handle(inbound);
  assert.equal(markdown.length, 1, "应发一条 Markdown");
  assert.ok(markdown[0]?.includes("看这个"), "应带文字");
  assert.ok(
    markdown[0]?.includes("![图片 #200px #200px](qqbot-media://image/v1/test)"),
    "应带图片",
  );
  console.log("MEDIA MARKDOWN:", markdown[0]);

  const textMarkdown: string[] = [];
  const textBot = new Bot({
    provider: {
      id: "fake",
      capabilities: { vision: false, tools: true, json: true, cache: false },
      chat: async () => ({ text: '{"messages":[{"plainText":"只有文字"}]}' }),
    },
    send: async () => undefined,
    sendMarkdown: async (input) => {
      textMarkdown.push(input.content);
    },
  });
  await textBot.handle({ ...inbound, messageId: `smoke-media-text-${Date.now()}` });
  assert.deepEqual(textMarkdown, ["只有文字"]);

  const emptyMarkdown: string[] = [];
  const emptyBot = new Bot({
    provider: {
      id: "fake",
      capabilities: { vision: false, tools: true, json: true, cache: false },
      chat: async () => ({ text: '{"messages":[]}' }),
    },
    send: async () => undefined,
    sendMarkdown: async (input) => {
      emptyMarkdown.push(input.content);
    },
  });
  await emptyBot.handle({ ...inbound, messageId: `smoke-media-empty-${Date.now()}` });
  assert.equal(emptyMarkdown.length, 0, "空 messages 不应发送");

  const shardMarkdown: string[] = [];
  const shardBot = new Bot({
    provider: {
      id: "fake",
      capabilities: { vision: false, tools: true, json: true, cache: false },
      chat: async () => ({
        text: '{"messages":[{"plainText":"第一句"},{"plainText":"第二句"}]}',
      }),
    },
    send: async () => undefined,
    sendMarkdown: async (input) => {
      shardMarkdown.push(input.content);
    },
  });
  await shardBot.handle({ ...inbound, messageId: `smoke-media-shards-${Date.now()}` });
  assert.deepEqual(shardMarkdown, ["第一句", "第二句"]);

  console.log("MEDIA OK");

  await db.delete(conversationMembers).where(eq(conversationMembers.personId, person.id));
  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  await db.delete(persons).where(eq(persons.id, person.id));
} finally {
  await closeDb();
}

