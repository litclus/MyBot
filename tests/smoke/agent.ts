import { eq } from "drizzle-orm";
import { createModelProvider } from "../../src/adapters/models/index.js";
import { buildReplyGraph } from "../../src/agent/graph.js";
import { closeDb, db } from "../../src/db/client.js";
import { conversations } from "../../src/db/schema.js";
import { upsertConversation, upsertPerson } from "../../src/db/repository.js";
import { saveMemory } from "../../src/memory/repository.js";

try {
  const person = await upsertPerson({
    personKey: "smoke:agent-user",
    displayName: "测试用户",
  });
  const conversation = await upsertConversation({
    platform: "smoke",
    externalId: "group:agent",
    kind: "group",
    title: "Agent 冒烟群",
  });

  await saveMemory({
    conversationId: conversation.id,
    personId: person.id,
    scope: "member",
    kind: "fact",
    content: "测试用户正在测试数据库",
    importance: 4,
    tags: ["smoke"],
  });

  const graph = buildReplyGraph(createModelProvider(), {
    context: {
      conversationId: conversation.id,
      personId: person.id,
    },
  });

  const result = await graph.invoke({
    messages: [
      {
        role: "user",
        parts: [{ type: "text", text: "你还记得我在测试什么吗？" }],
      },
    ],
  });

  console.log("REPLY:", result.reply);
  console.log("STEPS:", result.steps);
  for (const message of result.messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      console.log("TOOL CALLS:", JSON.stringify(message.toolCalls));
    }
    if (message.role === "tool") {
      console.log("TOOL RESULT:", message.content);
    }
  }

  await db.delete(conversations).where(eq(conversations.id, conversation.id));
} finally {
  await closeDb();
}
