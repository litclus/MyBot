import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories, persons } from "../db/schema.js";
import { cosineSimilarity, embedText } from "./embedding.js";
import type { MemoryRow } from "./types.js";

export async function searchMemories(input: {
  conversationId: string;
  personId: string;
  query?: string;
  limit?: number;
}): Promise<MemoryRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 12);
  const now = new Date();
  const query = input.query?.trim().slice(0, 80) ?? "";

  const base = and(
    eq(memories.conversationId, input.conversationId),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, now))!,
    isNull(memories.supersededBy),
    gte(memories.importance, 2),
    or(eq(memories.scope, "group"), eq(memories.personId, input.personId))!,
  )!;

  const queryVector = query ? await embedText(query) : null;
  const terms = query
    ? query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(Boolean)
    : [];

  let candidates: MemoryRow[];

  if (!query) {
    candidates = await db
      .select()
      .from(memories)
      .where(base)
      .orderBy(desc(memories.importance), desc(memories.createdAt))
      .limit(200);
  } else {
    const vectorRows =
      queryVector === null
        ? []
        : await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
            await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`);
            return tx
              .select()
              .from(memories)
              .where(and(base, isNotNull(memories.embedding)))
              .orderBy(
                sql`${memories.embedding} <=> ${`[${queryVector.join(",")}]`}::vector`,
              )
              .limit(50);
          });

    const keywordConditions = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`;
      return [
        ilike(memories.content, pattern),
        ilike(memories.subject, pattern),
        ilike(memories.object, pattern),
        sql`array_to_string(${memories.tags}, ' ') ILIKE ${pattern}`,
      ];
    });

    const keywordRows =
      keywordConditions.length > 0
        ? await db
            .select()
            .from(memories)
            .where(and(base, or(...keywordConditions)!))
            .orderBy(desc(memories.importance), desc(memories.createdAt))
            .limit(50)
        : [];

    const merged = new Map<number, MemoryRow>();
    for (const row of vectorRows) merged.set(row.id, row);
    for (const row of keywordRows) merged.set(row.id, row);
    candidates = [...merged.values()];
  }

  const scored = candidates.map((row) => {
    const haystack =
      `${row.content} ${row.subject ?? ""} ${row.object ?? ""} ${row.tags.join(" ")}`.toLowerCase();
    const keyword = terms.some((term) => haystack.includes(term)) ? 1 : 0;
    const similarity =
      queryVector && row.embedding ? cosineSimilarity(queryVector, row.embedding) : 0;
    const ageDays = Math.max(0, (Date.now() - row.createdAt.getTime()) / 86_400_000);
    const recency = Math.exp((-Math.LN2 * ageDays) / 14);
    const importance = row.importance / 5;
    const score = query
      ? 0.5 * similarity + 0.2 * keyword + 0.2 * importance + 0.1 * recency
      : 0.6 * keyword + 0.25 * importance + 0.15 * recency;
    return { row, score, similarity, keyword };
  });

  const filtered = query
    ? scored.filter(
        (item) => item.keyword > 0 || (queryVector !== null && item.similarity >= 0.35),
      )
    : scored;

  const selected = filtered
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.row);

  if (selected.length > 0) {
    await db
      .update(memories)
      .set({ accessCount: sql`${memories.accessCount} + 1`, lastUsedAt: now })
      .where(inArray(memories.id, selected.map((row) => row.id)));
  }

  return selected;
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}


export async function getProfile(personId: string): Promise<{
  displayName: string;
  aliases: string[];
  profile: Record<string, unknown>;
} | null> {
  const rows = await db
    .select({
      displayName: persons.displayName,
      aliases: persons.aliases,
      profile: persons.profile,
    })
    .from(persons)
    .where(eq(persons.id, personId))
    .limit(1);
  return rows[0] ?? null;
}

export async function saveMemory(input: {
  conversationId: string;
  personId?: string;
  scope?: "group" | "member";
  kind: string;
  content: string;
  subject?: string;
  predicate?: string;
  object?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  sourceMsgIds?: string[];
  expiresAt?: Date;
  embedding?: number[];
}): Promise<MemoryRow> {
  const rows = await db
    .insert(memories)
    .values({
      conversationId: input.conversationId,
      ...(input.personId ? { personId: input.personId } : {}),
      scope: input.scope ?? "group",
      kind: input.kind,
      content: input.content,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.predicate ? { predicate: input.predicate } : {}),
      ...(input.object ? { object: input.object } : {}),
      tags: input.tags ?? [],
      importance: input.importance ?? 3,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      sourceMsgIds: input.sourceMsgIds ?? [],
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.embedding ? { embedding: input.embedding } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("saveMemory returned no row");
  return row;
}

export function formatMemory(row: MemoryRow): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).format(row.createdAt);
  const expiry = row.expiresAt
    ? `，至${new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(row.expiresAt)}`
    : "";
  const tags = row.tags.length > 0 ? ` [${row.tags.join(",")}]` : "";
  return `- [${date}] (重要${row.importance}/${row.kind}) ${row.content}${tags}${expiry}`;
}

export type { MemoryRow };
