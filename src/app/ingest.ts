import type { InboundMessage } from "../adapters/qq/types.js";
import { unwrapQqText } from "../adapters/qq/normalize.js";
import type { MessageContent } from "../db/schema.js";
import { buildQuotedMeta } from "../chat/quoted.js";
import { logger } from "./logger.js";
import {
  addPersonAlias,
  getConversationMemberPersonId,
  insertMessage,
  rememberMentionedMember,
  touchConversation,
  upsertConversation,
  upsertMember,
  upsertPerson,
  type ConversationRow,
  type MessageRow,
  type PersonRow,
} from "../db/repository.js";

export type IngestResult = {
  person: PersonRow;
  conversation: ConversationRow;
  message: MessageRow;
};

export async function ingestInbound(inbound: InboundMessage): Promise<IngestResult> {
  const person = await upsertPerson({
    personKey: inbound.sender.personKey,
    displayName: inbound.sender.name,
  });

  const conversation = await upsertConversation({
    platform: "qq",
    externalId: inbound.conversation.externalId,
    kind: inbound.conversation.kind,
    ...(inbound.conversation.title ? { title: inbound.conversation.title } : {}),
  });

  await upsertMember({
    conversationId: conversation.id,
    externalId: inbound.sender.externalId,
    personId: person.id,
    ...(inbound.sender.role ? { role: inbound.sender.role } : {}),
    nickname: person.displayName,
  });

  for (const mention of inbound.mentions ?? []) {
    if (mention.bot || mention.externalId === inbound.sender.externalId) continue;
    const existingPersonId = await getConversationMemberPersonId(
      conversation.id,
      mention.externalId,
    );
    if (existingPersonId) {
      await addPersonAlias(existingPersonId, mention.name);
      continue;
    }
    const mentioned = await upsertPerson({
      personKey: mention.personKey,
      displayName: mention.name,
      updateDisplay: false,
      touchSeen: false,
    });
    await addPersonAlias(mentioned.id, mention.name);
    await rememberMentionedMember({
      conversationId: conversation.id,
      externalId: mention.externalId,
      personId: mentioned.id,
      name: mention.name,
    });
  }

  const text = unwrapQqText(inbound.text).trim();
  if (text.includes('"text"')) {
    logger.info("normalized qq text", JSON.stringify(text), Buffer.from(text).toString("hex").slice(0, 240));
  }

  const parts: MessageContent["parts"] = [];
  const inboundParts = inbound.parts ?? (text ? [{ type: "text" as const, text }] : []);
  for (const part of inboundParts) {
    if (part.type === "text") {
      const value = part.text.trim();
      if (value) parts.push({ type: "text", text: value });
    } else {
      parts.push({ type: part.type, description: part.description });
    }
  }
  for (const attachment of inbound.attachments) {
    if (attachment.contentType.startsWith("image/")) {
      parts.push({
        type: "image",
        mime: attachment.contentType,
        ...(attachment.filename ? { name: attachment.filename } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      });
    } else {
      parts.push({
        type: "file",
        mime: attachment.contentType,
        ...(attachment.filename ? { name: attachment.filename } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      });
    }
  }

  const quoted = buildQuotedMeta(inbound.quoted, inbound.messageId);
  const message = await insertMessage({
    conversationId: conversation.id,
    personId: person.id,
    role: "user",
    content: { parts },
    platformMsgId: inbound.messageId,
    metadata: {
      platform: inbound.platform,
      attachmentCount: inbound.attachments.length,
      speaker: { id: inbound.sender.personKey, name: inbound.sender.name },
      ...(quoted ? { quoted } : {}),
    },
  });

  if (!message) {
    throw new Error(`重复消息或写入失败: ${inbound.messageId}`);
  }

  await touchConversation(conversation.id);

  return { person, conversation, message };
}
