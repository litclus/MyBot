import { eq } from "drizzle-orm";
import { logger } from "../../src/app/logger.js";
import { createModelProvider } from "../../src/adapters/models/index.js";
import { closeDb, db } from "../../src/db/client.js";
import { conversationMembers, conversations, memories, persons } from "../../src/db/schema.js";
import { insertMessage, upsertConversation, upsertPerson } from "../../src/db/repository.js";
import { MemoryEnricher } from "../../src/memory/enrich.js";

try {
  const person = await upsertPerson({
    personKey: "smoke:enrich-user",
    displayName: "小明",
  });
  const conversation = await upsertConversation({
    platform: "qq",
    externalId: "group:enrich",
    kind: "group",
    title: "Enrich 冒烟群",
  });

  await insertMessage({
    conversationId: conversation.id,
    personId: person.id,
    role: "user",
    content: {
      parts: [{ type: "text", text: "我对花生严重过敏，以后别给我推荐花生" }],
    },
    platformMsgId: `smoke-enrich-${Date.now()}`,
  });

  const enricher = new MemoryEnricher(createModelProvider(), logger);
  const processed = await enricher.runOnce();
  console.log("PROCESSED:", processed);

  const rows = await db
    .select()
    .from(memories)
    .where(eq(memories.conversationId, conversation.id));
  console.log("MEMORIES:", rows.length);
  for (const row of rows) {
    console.log("-", row.kind, row.importance, row.scope, row.content, row.tags);
  }
  if (rows.length === 0) throw new Error("没有生成记忆");

  await db
    .delete(conversationMembers)
    .where(eq(conversationMembers.personId, person.id));
  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  await db.delete(persons).where(eq(persons.id, person.id));
  console.log("ENRICH OK");
} finally {
  await closeDb();
}
