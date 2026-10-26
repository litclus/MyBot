import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { images } from "../db/schema.js";
import { logger } from "../app/logger.js";
import { embedText } from "../memory/embedding.js";
import { compressImage } from "./compress.js";
import { getHistoryImage } from "./history-cache.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 普通图片保留 30 天；sticker / meme 永久保存 */
export const IMAGE_TTL_MS = 30 * 24 * 3600_000;

export type StoreImageInput = {
  url: string;
  conversationId: string;
  uploaderPersonId: string;
  sourceMsgId: string;
  /** 历史缓存 key，当前消息是 messageId，引用图片是 messageId#quoted */
  cacheKey: string;
  /** 当前消息里的第几张图，1 开始 */
  imageIndex: number;
  category: "image" | "sticker" | "meme";
  caption: string;
  emotion: string | null;
  tags: string[];
};

export type ImageStoreResult = "stored" | "duplicate" | "failed";

/** 消息真的发出去后回写使用次数 */
export async function markImagesUsed(ids: number[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  await db
    .update(images)
    .set({ useCount: sql`${images.useCount} + 1`, lastUsedAt: new Date() })
    .where(inArray(images.id, unique));
}

/**
 * 由 agent 的 image_save 调用：下载、压缩、去重后入库。
 * 类型和描述由主模型给，不再单独调视觉模型。
 * sticker/meme 全局保存；普通图片归上传群，30 天后过期。
 */
export async function storeImage(input: StoreImageInput): Promise<ImageStoreResult> {
  // 当前消息/引用图片下载给模型时已经进了历史缓存，直接复用，不再下载第二遍
  const cached = getHistoryImage(input.cacheKey, input.imageIndex);
  const loaded = cached
    ? { data: Buffer.from(cached.data), mime: cached.mime }
    : await loadImage(input.url);
  if (!loaded) return "failed";
  const { data: raw, mime } = loaded;

  try {
    const compressed = await compressImage(raw, mime);
    const data = compressed.data;
    const sha256 = createHash("sha256").update(data).digest("hex");
    const permanent = input.category === "sticker" || input.category === "meme";

    // 表情包全局去重；普通图片只在上传群内去重
    const duplicateFilter = permanent
      ? and(eq(images.sha256, sha256), inArray(images.category, ["sticker", "meme"]))
      : and(
          eq(images.sha256, sha256),
          eq(images.category, "image"),
          eq(images.conversationId, input.conversationId),
        );
    const existing = await db
      .select({ id: images.id })
      .from(images)
      .where(duplicateFilter)
      .limit(1);
    if (existing.length > 0) {
      logger.info("image duplicate skipped", sha256.slice(0, 12));
      return "duplicate";
    }

    const caption = input.caption.trim().slice(0, 80);
    const emotion = input.emotion?.trim().slice(0, 20) || null;
    const tags = input.tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 5);
    const embedding = caption
      ? await embedText([caption, emotion ?? "", tags.join(" ")].filter(Boolean).join(" "))
      : null;
    const expiresAt = permanent ? null : new Date(Date.now() + IMAGE_TTL_MS);

    const inserted = await db
      .insert(images)
      .values({
        sha256,
        mime: compressed.mime,
        bytes: data.length,
        data,
        category: input.category,
        ...(compressed.width ? { width: compressed.width } : {}),
        ...(compressed.height ? { height: compressed.height } : {}),
        // 表情包全局共享；普通图片归上传群，随会话级联删除
        conversationId: permanent ? null : input.conversationId,
        uploaderPersonId: input.uploaderPersonId,
        sourceMsgId: input.sourceMsgId,
        caption,
        emotion,
        tags,
        expiresAt,
        ...(embedding ? { embedding } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: images.id });

    if (inserted.length === 0) {
      logger.info("image duplicate skipped", sha256.slice(0, 12));
      return "duplicate";
    }

    logger.info("image stored", sha256.slice(0, 12), input.category, `${raw.length} -> ${data.length}`);
    return "stored";
  } catch (error) {
    logger.warn("image store failed", error);
    return "failed";
  }
}

/** 缓存里没有时才走网络 */
async function loadImage(url: string): Promise<{ data: Buffer; mime: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": config.MYBOT_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn("image download failed", response.status, url);
      return null;
    }

    const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!mime.startsWith("image/")) {
      logger.debug("attachment is not an image", mime);
      return null;
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      logger.warn("image too large", declared);
      return null;
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_IMAGE_BYTES) {
      logger.warn("image too large after download", data.length);
      return null;
    }
    return { data, mime };
  } catch (error) {
    logger.warn("image download failed", url, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
