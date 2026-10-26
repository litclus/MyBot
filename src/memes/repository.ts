import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { memeSources, memes } from "../db/schema.js";
import { cosineSimilarity, embedText } from "../memory/embedding.js";

export type MemeRow = typeof memes.$inferSelect;
export type MemeSourceRow = typeof memeSources.$inferSelect;

export type MemeSearchResult = {
  meme: MemeRow;
  score: number;
  sources: MemeSourceRow[];
};

export async function searchMemes(input: {
  query?: string;
  limit?: number;
  includeOutdated?: boolean;
}): Promise<MemeSearchResult[]> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const query = input.query?.trim().slice(0, 60) ?? "";
  const base = input.includeOutdated ? undefined : eq(memes.status, "active");

  const queryVector = query ? await embedText(query) : null;
  const terms = query
    ? query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(Boolean)
    : [];

  let candidates: MemeRow[];

  if (!query) {
    candidates = await db
      .select()
      .from(memes)
      .where(base)
      .orderBy(desc(memes.heat), desc(memes.updatedAt))
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
              .from(memes)
              .where(and(base, isNotNull(memes.embedding)))
              .orderBy(
                sql`${memes.embedding} <=> ${`[${queryVector.join(",")}]`}::vector`,
              )
              .limit(50);
          });

    const keywordConditions = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`;
      return [
        ilike(memes.keyword, pattern),
        ilike(memes.title, pattern),
        ilike(memes.meaning, pattern),
        ilike(memes.replyGuide, pattern),
        sql`array_to_string(${memes.aliases}, ' ') ILIKE ${pattern}`,
        sql`array_to_string(${memes.tags}, ' ') ILIKE ${pattern}`,
      ];
    });

    const keywordRows =
      keywordConditions.length > 0
        ? await db
            .select()
            .from(memes)
            .where(and(base, or(...keywordConditions)!))
            .orderBy(desc(memes.heat), desc(memes.updatedAt))
            .limit(50)
        : [];

    const merged = new Map<number, MemeRow>();
    for (const row of vectorRows) merged.set(row.id, row);
    for (const row of keywordRows) merged.set(row.id, row);
    candidates = [...merged.values()];
  }

  const scored = candidates.map((meme) => {
    const haystack =
      `${meme.keyword} ${meme.aliases.join(" ")} ${meme.title} ${meme.meaning} ${meme.replyGuide} ${meme.tags.join(" ")}`.toLowerCase();
    const keyword = terms.some((term) => haystack.includes(term)) ? 1 : 0;
    const similarity =
      queryVector && meme.embedding ? cosineSimilarity(queryVector, meme.embedding) : 0;
    const ageDays = Math.max(0, (Date.now() - meme.updatedAt.getTime()) / 86_400_000);
    const recency = Math.exp((-Math.LN2 * ageDays) / 30);
    const heat = meme.heat / 5;
    const usage = Math.min(1, Math.log1p(meme.useCount) / 5);
    const score = query
      ? 0.45 * similarity + 0.2 * keyword + 0.15 * heat + 0.1 * recency + 0.1 * usage
      : 0.6 * heat + 0.25 * recency + 0.15 * usage;
    return { meme, score, similarity, keyword };
  });

  const filtered = query
    ? scored.filter(
        (item) => item.keyword > 0 || (queryVector !== null && item.similarity >= 0.35),
      )
    : scored;

  const selected = filtered.sort((left, right) => right.score - left.score).slice(0, limit);

  const sources =
    selected.length > 0
      ? await db
          .select()
          .from(memeSources)
          .where(inArray(memeSources.memeId, selected.map((item) => item.meme.id)))
      : [];
  const sourcesByMeme = new Map<number, MemeSourceRow[]>();
  for (const source of sources) {
    const list = sourcesByMeme.get(source.memeId) ?? [];
    list.push(source);
    sourcesByMeme.set(source.memeId, list);
  }

  return selected.map((item) => ({
    meme: item.meme,
    score: item.score,
    sources: sourcesByMeme.get(item.meme.id) ?? [],
  }));
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

export async function getMeme(keyword: string): Promise<MemeRow | null> {
  const rows = await db.select().from(memes).where(eq(memes.keyword, keyword)).limit(1);
  return rows[0] ?? null;
}

export type UpsertMemeInput = {
  keyword: string;
  title: string;
  meaning: string;
  replyGuide: string;
  aliases?: string[];
  examples?: Array<{ input: string; reply: string }>;
  tags?: string[];
  heat?: number;
  status?: "active" | "outdated";
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceSite?: string | null;
  sourceSummary?: string | null;
  sourceFetchedAt?: Date | null;
  sourceAuthority?: number | null;
  sourceHash?: string | null;
};

export async function upsertMeme(input: UpsertMemeInput): Promise<MemeRow> {
  const existing = await getMeme(input.keyword);
  const heat = Math.min(Math.max(input.heat ?? existing?.heat ?? 3, 1), 5);
  const aliases = input.aliases ?? existing?.aliases ?? [];
  const tags = input.tags ?? existing?.tags ?? [];
  const embedding = await embedText(
    `${input.keyword} ${aliases.join(" ")} ${input.title} ${input.meaning} ${input.replyGuide}`,
  );

  const rows = await db
    .insert(memes)
    .values({
      keyword: input.keyword,
      title: input.title,
      meaning: input.meaning,
      replyGuide: input.replyGuide,
      aliases,
      tags,
      heat,
      status: input.status ?? existing?.status ?? "active",
      examples: input.examples ?? existing?.examples ?? [],
      ...(embedding ? { embedding } : {}),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: memes.keyword,
      set: {
        title: input.title,
        meaning: input.meaning,
        replyGuide: input.replyGuide,
        aliases,
        tags,
        heat,
        status: input.status ?? existing?.status ?? "active",
        examples: input.examples ?? existing?.examples ?? [],
        ...(embedding ? { embedding } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error("upsertMeme returned no row");

  if (input.sourceUrl) {
    await db
      .insert(memeSources)
      .values({
        memeId: row.id,
        url: input.sourceUrl,
        title: input.sourceTitle ?? null,
        site: input.sourceSite ?? null,
        summary: input.sourceSummary ?? null,
        fetchedAt: input.sourceFetchedAt ?? new Date(),
        authority: input.sourceAuthority ?? null,
        contentHash: input.sourceHash ?? null,
      })
      .onConflictDoUpdate({
        target: [memeSources.memeId, memeSources.url],
        set: {
          title: input.sourceTitle ?? null,
          site: input.sourceSite ?? null,
          summary: input.sourceSummary ?? null,
          fetchedAt: input.sourceFetchedAt ?? new Date(),
          authority: input.sourceAuthority ?? null,
          contentHash: input.sourceHash ?? null,
        },
      });
  }

  return row;
}

/** 梗真的被用进回复后调用：use_count + 1 */
export async function markMemeUsed(keyword: string): Promise<boolean> {
  const rows = await db
    .update(memes)
    .set({ useCount: sql`${memes.useCount} + 1`, lastUsedAt: new Date() })
    .where(eq(memes.keyword, keyword))
    .returning({ id: memes.id });
  return rows.length > 0;
}

export async function deleteMeme(keyword: string): Promise<boolean> {
  const rows = await db.delete(memes).where(eq(memes.keyword, keyword)).returning({ id: memes.id });
  return rows.length > 0;
}

export async function setMemeStatus(
  keyword: string,
  status: "active" | "outdated",
): Promise<MemeRow | null> {
  const rows = await db
    .update(memes)
    .set({ status, updatedAt: new Date() })
    .where(eq(memes.keyword, keyword))
    .returning();
  return rows[0] ?? null;
}

export async function setMemeHeat(keyword: string, heat: number): Promise<MemeRow | null> {
  const value = Math.min(Math.max(Math.round(heat), 1), 5);
  const rows = await db
    .update(memes)
    .set({ heat: value, updatedAt: new Date() })
    .where(eq(memes.keyword, keyword))
    .returning();
  return rows[0] ?? null;
}

export function formatMeme(result: MemeSearchResult): string {
  const { meme } = result;
  const aliases = meme.aliases.length > 0 ? `（别名：${meme.aliases.join("、")}）` : "";
  const lines = [
    `- 关键词：${meme.keyword}${aliases}｜热度 ${meme.heat}/5｜${meme.status}`,
    `  含义：${meme.meaning}`,
    `  回复：${meme.replyGuide}`,
  ];
  for (const example of meme.examples.slice(0, 2)) {
    lines.push(`  示例：${example.input} → ${example.reply}`);
  }
  for (const source of result.sources.slice(0, 3)) {
    lines.push(`  来源：${source.title ?? source.site ?? source.url} ${source.url}`);
  }
  return lines.join("\n");
}
