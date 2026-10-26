import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { conversations, images } from "../db/schema.js";
import { embedText } from "../memory/embedding.js";

const [file, groupOpenid, categoryArg, caption] = process.argv.slice(2);
if (!file || !groupOpenid) {
  console.log("用法: image:add <file> <group_openid> [sticker|meme|image] [caption]");
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

try {
  const data = await readFile(file);
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) throw new Error(`不支持的文件类型: ${extname(file)}`);
  const category =
    categoryArg === "sticker" || categoryArg === "meme" || categoryArg === "image"
      ? categoryArg
      : "sticker";
  const permanent = category === "sticker" || category === "meme";
  const expiresAt = permanent ? null : new Date(Date.now() + 30 * 24 * 3600_000);

  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, groupOpenid))
    .limit(1);
  const conversation = rows[0];
  if (!conversation) throw new Error(`没有找到群会话: ${groupOpenid}`);

  const sha256 = createHash("sha256").update(data).digest("hex");
  const captionText = caption?.trim() || "测试图片";
  const embedding = await embedText(captionText);
  await db
    .insert(images)
    .values({
      sha256,
      mime,
      bytes: data.length,
      data,
      category,
      // 表情包全局；普通图片归上传群
      conversationId: permanent ? null : conversation.id,
      expiresAt,
      caption: captionText,
      tags: [],
      ...(embedding ? { embedding } : {}),
    })
    .onConflictDoNothing();

  const inserted = await db
    .select({ id: images.id })
    .from(images)
    .where(
      permanent
        ? and(eq(images.sha256, sha256), inArray(images.category, ["sticker", "meme"]))
        : and(eq(images.sha256, sha256), eq(images.conversationId, conversation.id)),
    )
    .limit(1);
  console.log(inserted[0]?.id ?? "insert failed");
} finally {
  await closeDb();
}
