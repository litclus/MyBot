import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { logger } from "../app/logger.js";
import { db } from "../db/client.js";
import { images, memories } from "../db/schema.js";
import { embedText } from "./embedding.js";

/** 给历史 memories / images 补向量；启动时后台跑一次即可。 */
export async function backfillEmbeddings(limit = 200): Promise<number> {
  const rows = await db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(isNull(memories.embedding))
    .limit(limit);

  let updated = 0;
  for (const row of rows) {
    const embedding = await embedText(row.content);
    if (!embedding) continue;
    await db.update(memories).set({ embedding }).where(eq(memories.id, row.id));
    updated += 1;
  }
  if (updated > 0) logger.info("memory embeddings backfilled", updated);

  const imageRows = await db
    .select({
      id: images.id,
      caption: images.caption,
      emotion: images.emotion,
      tags: images.tags,
    })
    .from(images)
    .where(
      and(isNull(images.embedding), isNotNull(images.caption)),
    )
    .limit(limit);

  let imageUpdated = 0;
  for (const row of imageRows) {
    const text = [row.caption ?? "", row.emotion ?? "", row.tags.join(" ")]
      .filter(Boolean)
      .join(" ");
    const embedding = await embedText(text);
    if (!embedding) continue;
    await db.update(images).set({ embedding }).where(eq(images.id, row.id));
    imageUpdated += 1;
  }
  if (imageUpdated > 0) logger.info("image embeddings backfilled", imageUpdated);

  return updated + imageUpdated;
}
