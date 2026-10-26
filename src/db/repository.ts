import { and, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "./client.js";
import {
  conversationMembers,
  conversations,
  messages,
  persons,
  type MessageContent,
} from "./schema.js";

export type PersonRow = typeof persons.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export async function upsertPerson(input: {
  personKey: string;
  displayName: string;
  /** @ 别人时只补人，不用对方昵称覆盖已有群名片 */
  updateDisplay?: boolean;
  /** @ 别人不算本人发言，默认不刷新最后活跃时间 */
  touchSeen?: boolean;
}): Promise<PersonRow> {
  const rows = await db
    .insert(persons)
    .values({
      personKey: input.personKey,
      displayName: input.displayName,
      aliases: [],
    })
    .onConflictDoUpdate({
      target: persons.personKey,
      set: {
        ...(input.updateDisplay === false ? {} : { displayName: input.displayName }),
        ...(input.touchSeen === false ? {} : { lastSeenAt: new Date() }),
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("upsertPerson returned no row");
  return row;
}

export async function getConversationMemberPersonId(
  conversationId: string,
  externalId: string,
): Promise<string | null> {
  const rows = await db
    .select({ personId: conversationMembers.personId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.externalId, externalId),
      ),
    )
    .limit(1);
  return rows[0]?.personId ?? null;
}

/** 记录消息里 @ 到的人；不覆盖已有群名片，也不更新最后发言时间。 */
export async function rememberMentionedMember(input: {
  conversationId: string;
  externalId: string;
  personId: string;
  name: string;
}): Promise<void> {
  await db
    .insert(conversationMembers)
    .values({
      conversationId: input.conversationId,
      externalId: input.externalId,
      personId: input.personId,
      nickname: input.name,
    })
    .onConflictDoUpdate({
      target: [conversationMembers.conversationId, conversationMembers.externalId],
      set: { personId: input.personId },
    });
}

/** 把 @ 时看到的 QQ 昵称记成别名，群名片和 QQ 昵称不一致时也能搜到。 */
export async function addPersonAlias(personId: string, alias: string): Promise<void> {
  const clean = alias.trim().slice(0, 40);
  if (!clean) return;
  const rows = await db
    .select({ aliases: persons.aliases, displayName: persons.displayName })
    .from(persons)
    .where(eq(persons.id, personId))
    .limit(1);
  const person = rows[0];
  if (!person || person.displayName === clean || person.aliases.includes(clean)) return;
  await db
    .update(persons)
    .set({ aliases: [...person.aliases, clean].slice(-10), updatedAt: new Date() })
    .where(eq(persons.id, personId));
}

export async function upsertConversation(input: {
  platform: string;
  externalId: string;
  kind: string;
  title?: string;
}): Promise<ConversationRow> {
  const rows = await db
    .insert(conversations)
    .values({
      platform: input.platform,
      externalId: input.externalId,
      kind: input.kind,
      ...(input.title ? { title: input.title } : {}),
    })
    .onConflictDoUpdate({
      target: [conversations.platform, conversations.externalId],
      set: {
        updatedAt: new Date(),
        ...(input.title ? { title: input.title } : {}),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("upsertConversation returned no row");
  return row;
}

export async function upsertMember(input: {
  conversationId: string;
  externalId: string;
  personId: string;
  role?: string;
  nickname?: string;
}): Promise<void> {
  await db
    .insert(conversationMembers)
    .values({
      conversationId: input.conversationId,
      externalId: input.externalId,
      personId: input.personId,
      ...(input.role ? { role: input.role } : {}),
      ...(input.nickname ? { nickname: input.nickname } : {}),
    })
    .onConflictDoUpdate({
      target: [conversationMembers.conversationId, conversationMembers.externalId],
      set: {
        personId: input.personId,
        ...(input.role ? { role: input.role } : {}),
        ...(input.nickname ? { nickname: input.nickname } : {}),
        lastSeenAt: new Date(),
      },
    });
}

export async function insertMessage(input: {
  conversationId: string;
  personId?: string;
  role: "user" | "assistant" | "tool";
  content: MessageContent;
  platformMsgId?: string;
  replyTo?: string;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<MessageRow | null> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      ...(input.personId ? { personId: input.personId } : {}),
      role: input.role,
      content: input.content,
      ...(input.platformMsgId ? { platformMsgId: input.platformMsgId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      tags: input.tags ?? [],
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
    .onConflictDoNothing({
      target: [messages.conversationId, messages.platformMsgId],
    })
    .returning();

  if (rows[0]) return rows[0];
  if (!input.platformMsgId) return null;

  const existing = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        eq(messages.platformMsgId, input.platformMsgId),
      ),
    )
    .limit(1);
  return existing[0] ?? null;
}

/** 消息撤回：按平台消息 id 删除本地记录 */
export async function deleteMessageByPlatformId(platformMsgId: string): Promise<boolean> {
  const rows = await db
    .delete(messages)
    .where(eq(messages.platformMsgId, platformMsgId))
    .returning({ id: messages.id });
  return rows.length > 0;
}

export type RecentMessage = MessageRow & {
  personName: string | null;
  personKey: string | null;
};

export async function getRecentMessagesWithNames(
  conversationId: string,
  limit = 12,
): Promise<RecentMessage[]> {
  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      personId: messages.personId,
      role: messages.role,
      content: messages.content,
      platformMsgId: messages.platformMsgId,
      replyTo: messages.replyTo,
      createdAt: messages.createdAt,
      expiresAt: messages.expiresAt,
      importance: messages.importance,
      tags: messages.tags,
      metadata: messages.metadata,
      personName: persons.displayName,
      personKey: persons.personKey,
    })
    .from(messages)
    .leftJoin(persons, eq(messages.personId, persons.id))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        or(isNull(messages.expiresAt), gt(messages.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export type MentionCandidate = {
  token: string;
  openid: string;
  name: string;
  role: string | null;
  /** 群名片之外的 QQ 昵称/别名，避免 @ 后再重复写一遍 */
  aliases?: string[];
};

/** 生成 @ 用的短 token；同一个群内用 used 避免碰撞。 */
export function createMentionToken(openid: string, used: Set<string>): string {
  const hash = createHash("sha256").update(openid).digest("hex");
  let length = 6;
  let token = `u${hash.slice(0, length)}`;
  while (used.has(token) && length < hash.length) {
    length += 2;
    token = `u${hash.slice(0, length)}`;
  }
  used.add(token);
  return token;
}

/** 最近活跃的群成员，给 agent 选择 @ 谁；token 是短哈希，不暴露 openid。 */
export async function getMentionCandidates(
  conversationId: string,
  limit = 10,
): Promise<MentionCandidate[]> {
  const rows = await db
    .select({
      externalId: conversationMembers.externalId,
      nickname: conversationMembers.nickname,
      role: conversationMembers.role,
      personName: persons.displayName,
      aliases: persons.aliases,
    })
    .from(conversationMembers)
    .leftJoin(persons, eq(conversationMembers.personId, persons.id))
    .where(eq(conversationMembers.conversationId, conversationId))
    .orderBy(desc(conversationMembers.lastSeenAt))
    .limit(Math.min(Math.max(limit, 1), 20));

  const used = new Set<string>();
  const result: MentionCandidate[] = [];

  for (const row of rows) {
    if (!row.externalId) continue;
    const token = createMentionToken(row.externalId, used);
    result.push({
      token,
      openid: row.externalId,
      name: row.nickname ?? row.personName ?? "成员",
      role: row.role ?? null,
      aliases: (row.aliases ?? []).filter(Boolean),
    });
  }

  return result;
}

export type KnownMember = {
  openid: string;
  name: string;
  role: string | null;
  aliases: string[];
};

/** 本地记录过的群成员，用于 QQ 群成员接口没权限时兜底。 */
export async function getKnownMembers(input: {
  conversationId: string;
  query?: string;
  limit?: number;
}): Promise<KnownMember[]> {
  const filters = [eq(conversationMembers.conversationId, input.conversationId)];
  if (input.query) {
    const pattern = `%${input.query}%`;
    filters.push(
      or(
        ilike(conversationMembers.nickname, pattern),
        ilike(persons.displayName, pattern),
        sql`array_to_string(${persons.aliases}, ' ') ILIKE ${pattern}`,
      )!,
    );
  }
  const rows = await db
    .select({
      externalId: conversationMembers.externalId,
      nickname: conversationMembers.nickname,
      role: conversationMembers.role,
      personName: persons.displayName,
      aliases: persons.aliases,
    })
    .from(conversationMembers)
    .leftJoin(persons, eq(conversationMembers.personId, persons.id))
    .where(and(...filters))
    .orderBy(desc(conversationMembers.lastSeenAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 200));

  const result: KnownMember[] = [];
  for (const row of rows) {
    if (!row.externalId) continue;
    result.push({
      openid: row.externalId,
      name: row.nickname ?? row.personName ?? "成员",
      role: row.role ?? null,
      aliases: row.aliases ?? [],
    });
  }
  return result;
}

export async function touchConversation(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}


