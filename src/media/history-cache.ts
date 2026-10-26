import type { ImagePart } from "../ports/model.js";
import type { IndexedImagePart } from "./inbound.js";

type CachedHistoryImages = {
  images: IndexedImagePart[];
  bytes: number;
  expiresAt: number;
};

/** 历史图片只在内存里留一小段，过期后只剩附件元数据 */
const TTL_MS = 10 * 60_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const cache = new Map<string, CachedHistoryImages>();
let totalBytes = 0;

function sweep(now = Date.now()): void {
  for (const [messageId, item] of cache) {
    if (item.expiresAt > now) continue;
    cache.delete(messageId);
    totalBytes -= item.bytes;
  }
}

/** 当前消息下载给模型后，顺手按平台消息 id 留一份短期副本 */
export function rememberHistoryImages(messageId: string, images: IndexedImagePart[]): void {
  sweep();
  if (!messageId || images.length === 0) return;

  const bytes = images.reduce((sum, image) => sum + image.part.data.length, 0);
  if (bytes > MAX_TOTAL_BYTES) return;

  const previous = cache.get(messageId);
  if (previous) {
    cache.delete(messageId);
    totalBytes -= previous.bytes;
  }

  while (totalBytes + bytes > MAX_TOTAL_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    const item = cache.get(oldest);
    cache.delete(oldest);
    if (item) totalBytes -= item.bytes;
  }

  cache.set(messageId, { images, bytes, expiresAt: Date.now() + TTL_MS });
  totalBytes += bytes;
}

/** 取历史图片，不消费；过期返回 null */
export function getHistoryImages(messageId: string): IndexedImagePart[] | null {
  sweep();
  return cache.get(messageId)?.images ?? null;
}

export function getHistoryImage(messageId: string, index: number): ImagePart | null {
  sweep();
  return cache.get(messageId)?.images.find((item) => item.index === index)?.part ?? null;
}

export function clearHistoryImageCache(): void {
  cache.clear();
  totalBytes = 0;
}

const sweeper = setInterval(() => sweep(), 60_000);
sweeper.unref();
