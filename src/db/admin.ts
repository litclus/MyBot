import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { deleteMeme, getMeme, upsertMeme } from "../memes/repository.js";
import { embedText } from "../memory/embedding.js";
import { compressImage } from "../media/compress.js";
import { IMAGE_TTL_MS } from "../media/store.js";
import { db } from "./client.js";
import { images, memories, memes } from "./schema.js";

const clampLimit = (limit: number) => Math.min(Math.max(Math.trunc(limit), 1), 200);

export async function listAdminImages(limit = 100) {
  return db
    .select({
      id: images.id,
      category: images.category,
      caption: images.caption,
      emotion: images.emotion,
      tags: images.tags,
      conversationId: images.conversationId,
      sourceMsgId: images.sourceMsgId,
      bytes: images.bytes,
      width: images.width,
      height: images.height,
      useCount: images.useCount,
      lastUsedAt: images.lastUsedAt,
      createdAt: images.createdAt,
      expiresAt: images.expiresAt,
    })
    .from(images)
    .orderBy(desc(images.createdAt))
    .limit(clampLimit(limit));
}

export async function listAdminMemes(limit = 100) {
  return db
    .select({
      id: memes.id,
      keyword: memes.keyword,
      title: memes.title,
      meaning: memes.meaning,
      replyGuide: memes.replyGuide,
      aliases: memes.aliases,
      examples: memes.examples,
      tags: memes.tags,
      heat: memes.heat,
      status: memes.status,
      useCount: memes.useCount,
      lastUsedAt: memes.lastUsedAt,
      updatedAt: memes.updatedAt,
    })
    .from(memes)
    .orderBy(desc(memes.updatedAt))
    .limit(clampLimit(limit));
}

export async function listAdminMemories(limit = 100) {
  return db
    .select({
      id: memories.id,
      conversationId: memories.conversationId,
      personId: memories.personId,
      scope: memories.scope,
      kind: memories.kind,
      content: memories.content,
      tags: memories.tags,
      importance: memories.importance,
      expiresAt: memories.expiresAt,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .orderBy(desc(memories.createdAt))
    .limit(clampLimit(limit));
}

export async function getAdminImageContent(id: number) {
  const rows = await db
    .select({ mime: images.mime, data: images.data })
    .from(images)
    .where(eq(images.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteAdminImage(id: number): Promise<boolean> {
  const rows = await db.delete(images).where(eq(images.id, id)).returning({ id: images.id });
  return rows.length > 0;
}

export async function updateAdminImage(
  id: number,
  input: { category?: string; caption?: string; emotion?: string; tags?: string[] },
): Promise<boolean> {
  const rows = await db.select().from(images).where(eq(images.id, id)).limit(1);
  const current = rows[0];
  if (!current) return false;

  const category =
    input.category === "image" ||
    input.category === "sticker" ||
    input.category === "meme"
      ? input.category
      : current.category;
  const permanent = category !== "image";
  if (!permanent && !current.conversationId) {
    throw new Error("普通图片必须属于某个群，不能把全局图直接改成 image");
  }

  const caption =
    input.caption !== undefined ? input.caption.trim().slice(0, 80) : current.caption;
  if (!caption) throw new Error("caption 不能为空");
  const emotion =
    input.emotion !== undefined ? input.emotion.trim().slice(0, 20) || null : current.emotion;
  const tags = input.tags ?? current.tags;
  const embedding = await embedText(
    [caption, emotion ?? "", tags.join(" ")].filter(Boolean).join(" "),
  );

  await db
    .update(images)
    .set({
      category,
      conversationId: permanent ? null : current.conversationId,
      expiresAt: permanent ? null : (current.expiresAt ?? new Date(Date.now() + IMAGE_TTL_MS)),
      caption,
      emotion,
      tags,
      ...(embedding ? { embedding } : {}),
    })
    .where(eq(images.id, id));
  return true;
}

export async function createAdminImage(input: {
  data: Buffer;
  mime: string;
  category: "sticker" | "meme";
  caption: string;
  emotion: string | null;
  tags: string[];
}): Promise<{ id: number | null; duplicate: boolean }> {
  const compressed = await compressImage(input.data, input.mime);
  const sha256 = createHash("sha256").update(compressed.data).digest("hex");

  const existing = await db
    .select({ id: images.id })
    .from(images)
    .where(
      and(eq(images.sha256, sha256), inArray(images.category, ["sticker", "meme"])),
    )
    .limit(1);
  if (existing[0]) return { id: existing[0].id, duplicate: true };

  const caption = input.caption.trim().slice(0, 80);
  if (!caption) throw new Error("caption 不能为空");
  const emotion = input.emotion?.trim().slice(0, 20) || null;
  const tags = input.tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 5);
  const embedding = await embedText(
    [caption, emotion ?? "", tags.join(" ")].filter(Boolean).join(" "),
  );

  const rows = await db
    .insert(images)
    .values({
      sha256,
      mime: compressed.mime,
      bytes: compressed.data.length,
      data: compressed.data,
      category: input.category,
      conversationId: null,
      caption,
      emotion,
      tags,
      expiresAt: null,
      ...(compressed.width ? { width: compressed.width } : {}),
      ...(compressed.height ? { height: compressed.height } : {}),
      ...(embedding ? { embedding } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: images.id });

  if (rows[0]) return { id: rows[0].id, duplicate: false };
  return { id: null, duplicate: true };
}

export async function deleteAdminMeme(keyword: string): Promise<boolean> {
  return deleteMeme(keyword);
}

export type AdminMemeUpdate = {
  title?: string;
  meaning?: string;
  replyGuide?: string;
  aliases?: string[];
  examples?: Array<{ input: string; reply: string }>;
  tags?: string[];
  heat?: number;
  status?: "active" | "outdated";
};

export async function updateAdminMeme(keyword: string, input: AdminMemeUpdate) {
  const current = await getMeme(keyword);
  if (!current) return null;

  await upsertMeme({
    keyword,
    title: input.title ?? current.title,
    meaning: input.meaning ?? current.meaning,
    replyGuide: input.replyGuide ?? current.replyGuide,
    aliases: input.aliases ?? current.aliases,
    examples: input.examples ?? current.examples,
    tags: input.tags ?? current.tags,
    heat: input.heat ?? current.heat,
    status:
      input.status ?? (current.status === "outdated" ? "outdated" : "active"),
  });
  return true;
}
