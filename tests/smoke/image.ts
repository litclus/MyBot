import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { InboundMessage } from "../../src/adapters/qq/types.js";
import { Bot } from "../../src/app/bot.js";
import { closeDb, db } from "../../src/db/client.js";
import { conversationMembers, conversations, persons } from "../../src/db/schema.js";
import { upsertConversation, upsertPerson } from "../../src/db/repository.js";
import type { ChatRequest, ModelProvider } from "../../src/ports/model.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
  "base64",
);

const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
  response.end(png);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;

try {
  const person = await upsertPerson({ personKey: "smoke:image", displayName: "小明" });
  const conversation = await upsertConversation({
    platform: "qq",
    externalId: "group:image",
    kind: "group",
    title: "Image 冒烟群",
  });

  let captured: ChatRequest | null = null;
  const provider: ModelProvider = {
    id: "fake",
    capabilities: { vision: true, tools: true, json: true, cache: false },
    chat: async (request) => {
      captured = request;
      return { text: '{"messages":[{"plainText":"看到了"}]}' };
    },
  };
  const sent: string[] = [];
  const bot = new Bot({
    provider,
    send: async (input) => {
      sent.push(input.text);
    },
  });

  const inbound: InboundMessage = {
    platform: "qq",
    messageId: `smoke-image-${Date.now()}`,
    conversation: { externalId: "group:image", kind: "group" },
    sender: { externalId: "u1", personKey: "smoke:image", name: "小明" },
    text: "看这个",
    attachments: [
      {
        url: `http://127.0.0.1:${port}/test.png`,
        contentType: "image/png",
        filename: "test.png",
        size: png.length,
      },
    ],
    isMention: true,
    receivedAt: new Date(),
    raw: {},
  };

  await bot.handle(inbound);
  assert.equal(sent.length, 1, "应该回复");
  assert.ok(captured, "应该调用模型");

  const last = (captured as ChatRequest).messages.at(-1);
  assert.equal(last?.role, "user");
  const imageParts = (last?.parts ?? []).filter((part) => part.type === "image");
  assert.equal(imageParts.length, 1, "当前消息应带一张图片");
  assert.equal(imageParts[0]?.mime, "image/png");
  assert.equal((imageParts[0]?.data as Uint8Array).length, png.length);

  console.log("IMAGE OK", { sent: sent[0], imageBytes: png.length });

  await db.delete(conversationMembers).where(eq(conversationMembers.personId, person.id));
  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  await db.delete(persons).where(eq(persons.id, person.id));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
}

