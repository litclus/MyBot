import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../../src/db/client.js";
import { conversationMembers, conversations, persons } from "../../src/db/schema.js";
import { upsertConversation, upsertPerson } from "../../src/db/repository.js";
import { embedText } from "../../src/memory/embedding.js";
import { saveMemory, searchMemories } from "../../src/memory/repository.js";

try {
  const person = await upsertPerson({ personKey: "smoke:search", displayName: "小明" });
  const conversation = await upsertConversation({
    platform: "qq",
    externalId: "group:search",
    kind: "group",
    title: "Search 冒烟群",
  });

  const coffee = await embedText("小明喜欢喝美式咖啡");
  const allergy = await embedText("小明对花生严重过敏，不能吃花生");
  assert.ok(coffee && allergy);

  await saveMemory({
    conversationId: conversation.id,
    personId: person.id,
    scope: "member",
    kind: "preference",
    content: "小明喜欢喝美式咖啡",
    importance: 4,
    tags: ["饮食"],
    embedding: coffee,
  });
  await saveMemory({
    conversationId: conversation.id,
    personId: person.id,
    scope: "member",
    kind: "fact",
    content: "小明对花生严重过敏，不能吃花生",
    importance: 5,
    tags: ["健康"],
    embedding: allergy,
  });

  const drink = await searchMemories({
    conversationId: conversation.id,
    personId: person.id,
    query: "我平时喜欢喝什么",
  });
  console.log("drink:", drink.map((row) => row.content));
  assert.ok(drink.some((row) => row.content.includes("咖啡")), "没有语义召回咖啡");

  const taboo = await searchMemories({
    conversationId: conversation.id,
    personId: person.id,
    query: "我有什么不能吃的",
  });
  console.log("taboo:", taboo.map((row) => row.content));
  assert.ok(taboo.some((row) => row.content.includes("花生")), "没有语义召回花生过敏");

  console.log("SEARCH OK");
  await db.delete(conversationMembers).where(eq(conversationMembers.personId, person.id));
  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  await db.delete(persons).where(eq(persons.id, person.id));
} finally {
  await closeDb();
}
