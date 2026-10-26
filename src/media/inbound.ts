import type { InboundAttachment } from "../adapters/qq/types.js";
import { logger } from "../app/logger.js";
import { config } from "../config.js";
import type { ImagePart } from "../ports/model.js";

const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 下载用户发来的图片，作为当前消息的 image part 交给多模态模型 */
export async function fetchImagePart(url: string): Promise<ImagePart | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": config.MYBOT_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn("image download failed", response.status);
      return null;
    }

    const mime = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (!mime || !ALLOWED.has(mime)) {
      logger.debug("unsupported image mime", mime);
      return null;
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      logger.warn("image too large", declared);
      return null;
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_BYTES) {
      logger.warn("image too large after download", data.length);
      return null;
    }
    if (!looksLikeImage(data, mime)) {
      logger.warn("image magic mismatch", mime);
      return null;
    }

    return { type: "image", mime, data, name: "image" };
  } catch (error) {
    logger.warn("image download error", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type IndexedImagePart = {
  /** 在当前消息所有图片里的序号，从 1 开始 */
  index: number;
  part: ImagePart;
};

export async function fetchInboundImagesWithIndex(
  attachments: InboundAttachment[],
  limit = 2,
): Promise<IndexedImagePart[]> {
  const images: IndexedImagePart[] = [];
  let index = 0;
  for (const attachment of attachments) {
    if (!attachment.contentType.startsWith("image/")) continue;
    index += 1;
    if (images.length >= limit) continue;
    const part = await fetchImagePart(attachment.url);
    if (part) images.push({ index, part });
  }
  return images;
}

function looksLikeImage(data: Buffer, mime: string): boolean {
  if (data.length < 12) return false;
  if (mime === "image/png") {
    return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  }
  if (mime === "image/jpeg") {
    return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (mime === "image/gif") {
    return data.toString("ascii", 0, 4) === "GIF8";
  }
  if (mime === "image/webp") {
    return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}
