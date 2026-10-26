import { and, eq, inArray, or } from "drizzle-orm";
import type { DeferredAction } from "./actions.js";
import { logger } from "../app/logger.js";
import { db } from "../db/client.js";
import { images } from "../db/schema.js";
import { embedText } from "../memory/embedding.js";
import { IMAGE_TTL_MS, storeImage } from "../media/store.js";
import { saveMemory } from "../memory/repository.js";
import {
  deleteMeme,
  markMemeUsed,
  setMemeHeat,
  setMemeStatus,
  upsertMeme,
} from "../memes/repository.js";

export type CommitResult = {
  /** 真正写成功的动作数 */
  committed: number;
  /** 过期丢弃的动作数 */
  discarded: number;
  /** 没有写入但不算失败，例如图片重复 */
  skipped: number;
  /** 写失败的动作数 */
  failed: number;
};

/**
 * 只有最终回复确定要发送时才提交。
 * 过期的动作直接丢弃，写失败记录日志但不阻塞回复。
 */
export async function commitDeferredActions(
  actions: DeferredAction[],
): Promise<CommitResult> {
  const now = Date.now();
  let committed = 0;
  let discarded = 0;
  let skipped = 0;
  let failed = 0;

  for (const action of actions) {
    if (action.expiresAt < now) {
      discarded += 1;
      logger.warn("deferred action expired", action.kind);
      continue;
    }

    try {
      switch (action.kind) {
        case "memory_save": {
          const embedding = await embedText(action.payload.content);
          await saveMemory({
            conversationId: action.payload.conversationId,
            ...(action.payload.personId ? { personId: action.payload.personId } : {}),
            scope: action.payload.scope,
            kind: action.payload.kind,
            content: action.payload.content,
            tags: action.payload.tags,
            importance: action.payload.importance,
            ...(embedding ? { embedding } : {}),
          });
          break;
        }
        case "image_save": {
          const result = await storeImage(action.payload);
          if (result === "duplicate") {
            skipped += 1;
            continue;
          }
          if (result === "failed") throw new Error("图片保存失败");
          break;
        }
        case "image_update": {
          const embedding = await embedText(
            [action.payload.caption, action.payload.emotion ?? "", action.payload.tags.join(" ")]
              .filter(Boolean)
              .join(" "),
          );
          const permanent =
            action.payload.category === "sticker" || action.payload.category === "meme";
          const updated = await db
            .update(images)
            .set({
              category: action.payload.category,
              // 表情包全局；改回普通图片时归当前群
              conversationId: permanent ? null : action.payload.conversationId,
              // 表情包永久；普通图片重新给 30 天
              expiresAt: permanent ? null : new Date(Date.now() + IMAGE_TTL_MS),
              caption: action.payload.caption,
              emotion: action.payload.emotion,
              tags: action.payload.tags,
              ...(embedding ? { embedding } : {}),
            })
            .where(
              and(
                eq(images.id, action.payload.id),
                imageScopeFor(action.payload.conversationId),
              ),
            )
            .returning({ id: images.id });
          if (updated.length === 0) {
            skipped += 1;
            continue;
          }
          break;
        }
        case "image_delete": {
          const deleted = await db
            .delete(images)
            .where(
              and(
                eq(images.id, action.payload.id),
                imageScopeFor(action.payload.conversationId),
              ),
            )
            .returning({ id: images.id });
          if (deleted.length === 0) {
            skipped += 1;
            continue;
          }
          break;
        }
        case "meme_use": {
          const used = await markMemeUsed(action.payload.keyword);
          if (!used) {
            skipped += 1;
            continue;
          }
          break;
        }
        case "meme_upsert":
          await upsertMeme(action.payload);
          break;
        case "meme_delete": {
          const deleted = await deleteMeme(action.payload.keyword);
          if (!deleted) {
            skipped += 1;
            continue;
          }
          break;
        }
        case "meme_set_status": {
          const updated = await setMemeStatus(action.payload.keyword, action.payload.status);
          if (!updated) {
            skipped += 1;
            continue;
          }
          break;
        }
        case "meme_set_heat": {
          const updated = await setMemeHeat(action.payload.keyword, action.payload.heat);
          if (!updated) {
            skipped += 1;
            continue;
          }
          break;
        }
      }
      committed += 1;
    } catch (error) {
      failed += 1;
      logger.warn("deferred action failed", action.kind, error);
    }
  }

  return { committed, discarded, skipped, failed };
}

/** 和工具层同一个规则：表情包全局，普通图片只看当前群 */
function imageScopeFor(conversationId: string) {
  return or(
    inArray(images.category, ["sticker", "meme"]),
    and(eq(images.category, "image"), eq(images.conversationId, conversationId)),
  )!;
}
