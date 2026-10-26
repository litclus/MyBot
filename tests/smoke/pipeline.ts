import { eq } from "drizzle-orm";
import { createModelProvider } from "../../src/adapters/models/index.js";
import type { InboundMessage } from "../../src/adapters/qq/types.js";
import { Bot } from "../../src/app/bot.js";
import { closeDb, db } from "../../src/db/client.js";
import { conversations, persons } from "../../src/db/schema.js";
import { conversationMembers } from "../../src/db/schema.js";
import { upsertConversation, upsertPerson } from "../../src/db/repository.js";
import { saveMemory } from "../../src/memory/repository.js";

try {
  const person = await upsertPerson({
    personKey: "smoke:pipeline-user",
    displayName: "小明",
  });
  const conversation = await upsertConversation({
    platform: "qq",
    externalId: "group:pipeline",
    kind: "group",
    title: "Pipeline 冒烟群",
  });

  await saveMemory({
    conversationId: conversation.id,
    personId: person.id,
    scope: "member",
    kind: "fact",
    content: "小明对花生严重过敏，绝对不能吃花生",
    importance: 5,
    tags: ["健康", "忌口"],
  });

  const replies: string[] = [];
  const bot = new Bot({
    provider: createModelProvider(),
    send: async (input) => {
      replies.push(input.text);
      console.log("SEND", input.msgSeq, input.text);
    },
  });

  const inbound: InboundMessage = {
    platform: "qq",
    messageId: `smoke-${Date.now()}`,
    conversation: { externalId: "group:pipeline", kind: "group" },
    sender: {
      externalId: "user:1",
      personKey: "smoke:pipeline-user",
      name: "小明",
    },
    text: "我对什么东西过敏？",
    attachments: [],
    isMention: true,
    receivedAt: new Date(),
    raw: {},
  };

  await bot.handle(inbound);

  if (!replies.some((reply) => reply.includes("花生") && reply.includes("过敏"))) {
    throw new Error(`回复没有使用记忆: ${replies.join(" | ")}`);
  }
  console.log("PIPELINE OK");

  await db
    .delete(conversationMembers)
    .where(eq(conversationMembers.personId, person.id));
  await db
    .delete(conversations)
    .where(eq(conversations.externalId, "group:pipeline"));
  await db.delete(persons).where(eq(persons.id, person.id));
} finally {
  await closeDb();
}
