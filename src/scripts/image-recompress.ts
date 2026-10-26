import { eq } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { images } from "../db/schema.js";
import { compressImage } from "../media/compress.js";

try {
  const rows = await db.select().from(images).orderBy(images.id);
  for (const row of rows) {
    const compressed = await compressImage(row.data, row.mime);
    if (!compressed.changed) {
      console.log(`#${row.id} skip ${row.bytes}B`);
      continue;
    }
    await db
      .update(images)
      .set({
        data: compressed.data,
        mime: compressed.mime,
        bytes: compressed.data.length,
        width: compressed.width,
        height: compressed.height,
        mediaUrl: null,
        mediaImageId: null,
        mediaUpdatedAt: null,
      })
      .where(eq(images.id, row.id));
    console.log(
      `#${row.id} ${row.bytes}B -> ${compressed.data.length}B ${compressed.mime} ${compressed.width ?? "?"}x${compressed.height ?? "?"}`,
    );
  }
} finally {
  await closeDb();
}
