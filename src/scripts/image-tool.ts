import { and, desc, eq, isNotNull } from "drizzle-orm";
import { QqApi } from "../adapters/qq/api.js";
import { QqAuth } from "../adapters/qq/auth.js";
import { config } from "../config.js";
import { closeDb, db } from "../db/client.js";
import { conversations, messages, images } from "../db/schema.js";
import { ensureImageMedia } from "../media/media.js";
import { markdownImageSize } from "../media/display.js";

const [action, arg1, arg2, arg3, arg4] = process.argv.slice(2);

function makeApi(): QqApi {
  const auth = new QqAuth({
    appId: config.QQ_APP_ID,
    appSecret: config.QQ_APP_SECRET,
    baseUrl: config.QQ_API_BASE,
  });
  return new QqApi({ auth, baseUrl: config.QQ_API_BASE });
}

async function latestImage() {
  const rows = await db.select().from(images).orderBy(desc(images.id)).limit(1);
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  if (action === "list" || !action) {
    const rows = await db
      .select({
        id: images.id,
        category: images.category,
        mime: images.mime,
        bytes: images.bytes,
        caption: images.caption,
        mediaUrl: images.mediaUrl,
        conversationId: images.conversationId,
      })
      .from(images)
      .orderBy(desc(images.id))
      .limit(20);
    if (rows.length === 0) {
      console.log("还没有图片，先在群里发一张图片或 GIF");
      return;
    }
    for (const row of rows) {
      console.log(
        `#${row.id} [${row.category}] ${row.mime} ${row.bytes}B caption=${row.caption ?? "-"} media=${row.mediaUrl ? "cached" : "-"}`,
      );
    }
    return;
  }

  if (action === "media") {
    const id = arg1 ? Number(arg1) : (await latestImage())?.id;
    if (!id) {
      console.log("没有图片可上传");
      return;
    }
    const rows = await db.select().from(images).where(eq(images.id, id)).limit(1);
    const image = rows[0];
    if (!image) throw new Error(`没有 #${id}`);
    if (arg2 === "--force") {
      await db
        .update(images)
        .set({ mediaUrl: null, mediaImageId: null, mediaUpdatedAt: null })
        .where(eq(images.id, id));
    }
    const media = await ensureImageMedia(id, image.conversationId ?? "", makeApi());
    console.log(
      media
        ? `media ok: ${media.url} (${media.width ?? "?"}x${media.height ?? "?"})`
        : "media 上传失败，看日志",
    );
    return;
  }

  if (action === "send") {
    const id = arg1 ? Number(arg1) : (await latestImage())?.id;
    if (!id) {
      console.log("没有图片可发送");
      return;
    }
    const rows = await db.select().from(images).where(eq(images.id, id)).limit(1);
    const image = rows[0];
    if (!image) throw new Error(`没有 #${id}`);

    let conversationId = image.conversationId;
    if (!conversationId && arg3) {
      const conv = await db
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, arg3))
        .limit(1);
      conversationId = conv[0]?.id ?? null;
    }
    if (!conversationId) throw new Error("这个图片没有关联群，第二个参数给文字，第三个参数给 group_openid");

    const convRows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const conversation = convRows[0];
    if (!conversation) throw new Error("找不到关联会话");

    const latest = await db
      .select({ msgId: messages.platformMsgId, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(eq(messages.conversationId, conversationId), isNotNull(messages.platformMsgId)),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const last = latest[0];
    const flags = new Set(process.argv.slice(2).filter((value) => value.startsWith("--")));
    const active = flags.has("--active");

    let msgSeq = 1;
    if (!active) {
      if (!last?.msgId) throw new Error("这个群还没有可用的被动回复 msg_id，先让人发一句话");
      if (Date.now() - last.createdAt.getTime() > 4.5 * 60_000) {
        throw new Error("最近一条消息超过 4.5 分钟，先让人发一句话，或加 --active");
      }
      const sent = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.replyTo, last.msgId)));
      msgSeq = sent.length + 1;
    }

    const text = arg2 ? `${arg2}\n` : "";
    const rawText = text.trim();

    const media = await ensureImageMedia(id, conversationId, makeApi());
    if (!media) throw new Error("media 上传失败，看日志");

    const size = markdownImageSize(
      media.width,
      media.height,
      config.IMAGE_DISPLAY_MAX_WIDTH,
      config.IMAGE_DISPLAY_MAX_HEIGHT,
    );
    await makeApi().sendGroupMarkdown({
      groupOpenid: conversation.externalId,
      content: `${text}![图片${size}](${media.url})`,
      ...(active ? {} : { msgId: last?.msgId ?? "", msgSeq }),
    });
    console.log(active ? "sent active" : "sent passive", conversation.externalId);
    return;
  }

  console.log("用法: list | media [id] [--force] | send [id] [文字] [group_openid] [--active]");
}

try {
  await main();
} finally {
  await closeDb();
}
