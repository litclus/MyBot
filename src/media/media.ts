import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import type { QqApi } from "../adapters/qq/api.js";
import { logger } from "../app/logger.js";
import { db } from "../db/client.js";
import { images } from "../db/schema.js";

const MEDIA_TTL_MS = 80 * 24 * 3600_000;
const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export type ImageMedia = {
  url: string;
  width: number | null;
  height: number | null;
  mime: string;
};

/** 把图片上传成 Markdown 可引用的 qqbot-media URL，按 80 天缓存 */
export async function ensureImageMedia(
  imageId: number,
  conversationId: string,
  api: QqApi,
  categories?: readonly string[],
): Promise<ImageMedia | null> {
  const filters = [
    eq(images.id, imageId),
    // 表情包全局可用；普通图片只能在本群引用
    or(
      inArray(images.category, ["sticker", "meme"]),
      eq(images.conversationId, conversationId),
    )!,
  ];
  if (categories && categories.length > 0) filters.push(inArray(images.category, [...categories]));

  const rows = await db
    .select()
    .from(images)
    .where(and(...filters))
    .limit(1);

  const image = rows[0];
  if (!image) return null;

  const dims = image.width && image.height
    ? { width: image.width, height: image.height }
    : readDimensions(image.data, image.mime);

  if (
    image.mediaUrl &&
    image.mediaUpdatedAt &&
    Date.now() - image.mediaUpdatedAt.getTime() < MEDIA_TTL_MS
  ) {
    return {
      url: image.mediaUrl,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      mime: image.mime,
    };
  }

  try {
    const md5 = createHash("md5").update(image.data).digest("hex");
    const sha1 = createHash("sha1").update(image.data).digest("hex");
    const prepared = await api.prepareMediaImage({
      fileName: `image-${image.id}${EXT[image.mime] ?? ".png"}`,
      fileSize: image.data.length,
      contentType: image.mime,
      md5,
      sha1,
    });

    const upload = await fetch(prepared.presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": image.mime },
      body: new Uint8Array(image.data),
    });
    if (!upload.ok) {
      throw new Error(`media PUT ${upload.status}`);
    }

    const completed = await api.completeMediaImage({ uploadId: prepared.uploadId, md5 });
    await db
      .update(images)
      .set({
        mediaUrl: completed.url,
        mediaImageId: completed.imageId,
        mediaUpdatedAt: new Date(),
        ...(dims ? { width: dims.width, height: dims.height } : {}),
      })
      .where(eq(images.id, image.id));

    logger.info("image media uploaded", image.id);
    return {
      url: completed.url,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      mime: image.mime,
    };
  } catch (error) {
    logger.warn("image media upload failed", image.id, error);
    return null;
  }
}

function readDimensions(
  data: Buffer,
  mime: string,
): { width: number; height: number } | null {
  try {
    if (mime === "image/gif" && data.length >= 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (mime === "image/png" && data.length >= 24) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (mime === "image/webp" && data.length >= 30) {
      const chunk = data.toString("ascii", 12, 16);
      if (chunk === "VP8X") {
        return {
          width: 1 + data.readUIntLE(24, 3),
          height: 1 + data.readUIntLE(27, 3),
        };
      }
    }
    if (mime === "image/jpeg") {
      return readJpegDimensions(data);
    }
  } catch {
    return null;
  }
  return null;
}

function readJpegDimensions(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}
