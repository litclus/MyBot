import { humanDelayMs, type ReplyMessage } from "./reply-format.js";

/**
 * 分片之间的等待时间
 *
 * 模型给了 gap 就用模型的（秒 → 毫秒），没给就按上一条文本长度估
 * 主动消息和被动回复共用这一套，避免两边节奏不一致
 */
export function gapMsFor(message: ReplyMessage, previousText: string): number {
  if (message.gapSeconds === undefined) return humanDelayMs(previousText);
  return Math.max(0, Math.round(message.gapSeconds * 1000));
}
