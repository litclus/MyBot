import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Logger } from "../app/logger.js";
import { db } from "../db/client.js";
import { memories, messages, images } from "../db/schema.js";
import { msUntilShanghaiMidnight } from "../util/time.js";

const DAY = 24 * 3600_000;

/**
 * 每天上海时间 0 点清理一次：
 * - 普通图片按 expires_at 删除；sticker / meme 的 expires_at 为 null，永久保留
 * - 历史普通图片没有 expires_at 时，按 created_at + 30 天补上
 * - 消息过期 7 天后删，记忆过期 30 天后删
 */
export class CleanupJob {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly log: Logger) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<void> {
    const now = Date.now();
    try {
      await db
        .update(images)
        .set({ expiresAt: sql`${images.createdAt} + interval '30 days'` })
        .where(and(eq(images.category, "image"), isNull(images.expiresAt)));

      await db
        .delete(images)
        .where(and(eq(images.category, "image"), lt(images.expiresAt, new Date(now))));
      await db.delete(messages).where(lt(messages.expiresAt, new Date(now - 7 * DAY)));
      await db.delete(memories).where(lt(memories.expiresAt, new Date(now - 30 * DAY)));
      this.log.info("cleanup done");
    } catch (error) {
      this.log.warn("cleanup failed", error);
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = msUntilShanghaiMidnight();
    this.log.info("cleanup scheduled", Math.round(delay / 1000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run().finally(() => this.schedule());
    }, delay);
  }
}
