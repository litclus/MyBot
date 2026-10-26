import type { ChatUsage } from "../ports/model.js";
import type { Logger } from "./logger.js";

/** 统一记录模型 token 用量和缓存命中情况，不打印任何消息正文 */
export function logModelUsage(
  logger: Logger | undefined,
  tag: string,
  usage: ChatUsage | undefined,
  extra: Record<string, unknown> = {},
): void {
  if (!logger || !usage) return;
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  logger.info("model usage", {
    tag,
    ...extra,
    input,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    cacheRead,
    cacheWrite: usage.cacheWrite ?? 0,
    cacheHit: input > 0 ? Number((cacheRead / input).toFixed(3)) : 0,
  });
}
