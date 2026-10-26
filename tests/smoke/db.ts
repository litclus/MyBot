import { eq, sql } from "drizzle-orm";
import { closeDb, db } from "../../src/db/client.js";
import {
  conversationMembers,
  conversations,
  memories,
  messages,
  persons,
} from "../../src/db/schema.js";

try {
  const personRows = await db
    .insert(persons)
    .values({ personKey: "smoke:user", displayName: "测试用户", aliases: [] })
    .onConflictDoUpdate({
      target: persons.personKey,
      set: { lastSeenAt: new Date(), updatedAt: new Date() },
    })
    .returning();
  const person = personRows[0];
  if (!person) throw new Error("person insert returned nothing");

  const conversationRows = await db
    .insert(conversations)
    .values({
      platform: "smoke",
      externalId: "group:1",
      kind: "group",
      title: "冒烟测试群",
    })
    .onConflictDoUpdate({
      target: [conversations.platform, conversations.externalId],
      set: { updatedAt: new Date() },
    })
    .returning();
  const conversation = conversationRows[0];
  if (!conversation) throw new Error("conversation insert returned nothing");

  await db
    .insert(conversationMembers)
    .values({
      conversationId: conversation.id,
      externalId: "member:1",
      personId: person.id,
      role: "member",
      nickname: person.displayName,
    })
    .onConflictDoUpdate({
      target: [conversationMembers.conversationId, conversationMembers.externalId],
      set: { lastSeenAt: new Date() },
    });

  await db.insert(messages).values({
    conversationId: conversation.id,
    personId: person.id,
    role: "user",
    content: { parts: [{ type: "text", text: "这是一条数据库冒烟消息" }] },
    platformMsgId: `smoke-${Date.now()}`,
    importance: 2,
    tags: [],
  });

  const embedding = Array.from({ length: 512 }, (_, index) => (index === 0 ? 1 : 0));
  await db.insert(memories).values({
    conversationId: conversation.id,
    personId: person.id,
    scope: "member",
    kind: "fact",
    subject: person.displayName,
    predicate: "测试",
    object: "数据库",
    content: "测试用户正在测试数据库",
    tags: ["smoke"],
    importance: 3,
    sourceMsgIds: ["smoke-message"],
    embedding,
  });

  const messageCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversation.id));
  const memoryCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(eq(memories.conversationId, conversation.id));

  const nearest = await db.execute(sql`
    SELECT content, embedding <=> ${sql.raw(`'[${embedding.join(",")}]'::vector`)} AS distance
    FROM memories
    WHERE conversation_id = ${conversation.id}
    ORDER BY distance
    LIMIT 1
  `);

  console.log("person:", person.displayName);
  console.log("conversation:", conversation.id);
  console.log("messages:", messageCount[0]?.count ?? 0);
  console.log("memories:", memoryCount[0]?.count ?? 0);
  console.log("nearest:", nearest.rows[0]);

  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  console.log("cleanup: cascaded");
} finally {
  await closeDb();
}
