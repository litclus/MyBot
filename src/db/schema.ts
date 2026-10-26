import { inArray, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** pgvector：固定 512 维，和 bge-small-zh-v1.5 对齐。 */
const vector512 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(512)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return JSON.parse(value as string) as number[];
  },
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "emoji"; description: string }
  | { type: "sticker"; description: string }
  | {
      type: "image";
      assetId?: string;
      mime?: string;
      caption?: string;
      name?: string;
      size?: number;
    }
  | { type: "file"; mime?: string; name?: string; size?: number };

export type MessageContent = {
  /** 消息内容分片：文字、表情、表情包、图片、文件 */
  parts: MessagePart[];
  /** 平台原始字段，排查用 */
  raw?: unknown;
};

/** 平台上的人，同一个 QQ 用户在库里只有一条 */
export const persons = pgTable(
  "persons",
  {
    /** 主键 */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 平台内稳定的人标识，优先 union_openid */
    personKey: text("person_key").notNull(),
    /** 最近一次看到的昵称 */
    displayName: text("display_name").notNull(),
    /** 历史昵称和别名 */
    aliases: text("aliases").array().notNull(),
    /** 长期画像，例如 preferences */
    profile: jsonb("profile")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** 名字来源：平台字段、模型推断等 */
    nameSource: text("name_source"),
    /** 名字或画像的置信度 */
    confidence: real("confidence"),
    /** 首次出现时间 */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** 最近出现时间 */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** 最近更新时间 */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("persons_person_key_uq").on(table.personKey)],
);

/** 控制面板保存的运行配置，键名和 EnvSchema 一致 */
export const appSettings = pgTable("app_settings", {
  /** 配置键，例如 BOT_NAME */
  key: text("key").primaryKey(),
  /** 面板保存的 JSON 值 */
  value: jsonb("value").$type<unknown>().notNull(),
  /** 最近保存时间 */
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 会话：QQ 群或私聊 */
export const conversations = pgTable(
  "conversations",
  {
    /** 主键 */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 平台标识，目前固定 qq */
    platform: text("platform").notNull(),
    /** 群 openid 或用户 openid */
    externalId: text("external_id").notNull(),
    /** group | dm | channel */
    kind: text("kind").notNull(),
    /** 群名或备注 */
    title: text("title"),
    /** 平台原始信息 */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** 最近活跃时间 */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("conversations_platform_external_uq").on(table.platform, table.externalId)],
);

/** 主动消息调度：每个群一行 */
export const proactiveSchedules = pgTable(
  "proactive_schedules",
  {
    /** 群会话 id，一个群只有一条 */
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** 下一次主动判断时间 */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /** 上一次主动判断时间 */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** 上一次结果：sent / no_reply / stale / missed / offline 等 */
    lastResult: text("last_result"),
    /** 最近更新时间 */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("proactive_schedules_next_run_idx").on(table.nextRunAt)],
);

/** 群成员快照，用来给 @ 人提供 token 和名字 */
export const conversationMembers = pgTable(
  "conversation_members",
  {
    /** 所属会话 */
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** 群成员 openid */
    externalId: text("external_id").notNull(),
    /** 对应到 persons */
    personId: uuid("person_id").references(() => persons.id),
    /** 群角色，例如 owner / admin / member */
    role: text("role"),
    /** 群昵称 */
    nickname: text("nickname"),
    /** 最近发言时间 */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.externalId] })],
);

/** 聊天消息，历史和工具消息都在这里 */
export const messages = pgTable(
  "messages",
  {
    /** 主键 */
    id: uuid("id").primaryKey().defaultRandom(),
    /** 所属会话 */
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** 发言人，工具消息为空 */
    personId: uuid("person_id").references(() => persons.id),
    /** user | assistant | system | tool */
    role: text("role").notNull(),
    /** 结构化内容 */
    content: jsonb("content").$type<MessageContent>().notNull(),
    /** 平台消息 id，用于去重和撤回 */
    platformMsgId: text("platform_msg_id"),
    /** 被动回复的目标平台消息 id */
    replyTo: text("reply_to"),
    /** 入库时间 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** 过期时间，null 表示永久 */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** 记忆加工后的重要度 1-5 */
    importance: smallint("importance"),
    /** 加工后的标签 */
    tags: text("tags").array().notNull(),
    /** speaker、toolCalls、toolCallId 等附加信息 */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("messages_expires_idx").on(table.expiresAt),
    uniqueIndex("messages_platform_msg_uq").on(table.conversationId, table.platformMsgId),
  ],
);

/** 长期记忆：事实、偏好、约定、阶段摘要等 */
export const memories = pgTable(
  "memories",
  {
    /** 主键 */
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 所属会话 */
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** 只和某个人有关时记录 personId */
    personId: uuid("person_id").references(() => persons.id),
    /** group | member */
    scope: text("scope").notNull().default("group"),
    /** fact | preference | decision | event | task | episode | identity */
    kind: text("kind").notNull(),
    /** 三元组主体 */
    subject: text("subject"),
    /** 三元组关系或动作 */
    predicate: text("predicate"),
    /** 三元组对象 */
    object: text("object"),
    /** 给模型看的完整记忆文本 */
    content: text("content").notNull(),
    /** 检索标签 */
    tags: text("tags").array().notNull(),
    /** 重要度 1-5 */
    importance: smallint("importance").notNull(),
    /** 抽取置信度 */
    confidence: real("confidence"),
    /** 来源消息 id 列表 */
    sourceMsgIds: text("source_msg_ids").array().notNull(),
    /** episode 覆盖开始时间 */
    periodStart: timestamp("period_start", { withTimezone: true }),
    /** episode 覆盖结束时间 */
    periodEnd: timestamp("period_end", { withTimezone: true }),
    /** 事实生效时间 */
    validFrom: timestamp("valid_from", { withTimezone: true }),
    /** 事实失效时间 */
    validTo: timestamp("valid_to", { withTimezone: true }),
    /** 过期时间，null 表示永久 */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** 被哪条新记忆取代 */
    supersededBy: bigint("superseded_by", { mode: "number" }),
    /** 被召回次数 */
    accessCount: integer("access_count").notNull().default(0),
    /** 最近一次被召回时间 */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** 512 维向量，用于语义召回 */
    embedding: vector512("embedding"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memories_conversation_expires_idx").on(table.conversationId, table.expiresAt),
    index("memories_kind_idx").on(table.kind),
    index("memories_tags_idx").using("gin", table.tags),
    index("memories_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

/** 梗知识库：含义、来源、回复方式和热度 */
export const memes = pgTable(
  "memes",
  {
    /** 主键 */
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 梗的主关键词，唯一 */
    keyword: text("keyword").notNull(),
    /** 别名，参与检索 */
    aliases: text("aliases").array().notNull(),
    /** 展示标题 */
    title: text("title").notNull(),
    /** 这个梗是什么意思、什么场景用 */
    meaning: text("meaning").notNull(),
    /** 应该怎么回复 */
    replyGuide: text("reply_guide").notNull(),
    /** 输入和回复示例 */
    examples: jsonb("examples")
      .$type<Array<{ input: string; reply: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** 检索标签 */
    tags: text("tags").array().notNull(),
    /** 热度 1-5，参与排序 */
    heat: smallint("heat").notNull().default(3),
    /** active | outdated */
    status: text("status").notNull().default("active"),
    /** 512 维向量，用于语义检索 */
    embedding: vector512("embedding"),
    /** 真实使用次数，meme_mark_used 回写 */
    useCount: integer("use_count").notNull().default(0),
    /** 最近一次使用时间，meme_mark_used 回写 */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** 最近更新时间 */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memes_keyword_uq").on(table.keyword),
    index("memes_status_heat_idx").on(table.status, table.heat),
    index("memes_tags_idx").using("gin", table.tags),
    index("memes_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

/** 梗的网页来源 */
export const memeSources = pgTable(
  "meme_sources",
  {
    /** 主键 */
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 所属梗 */
    memeId: bigint("meme_id", { mode: "number" })
      .notNull()
      .references(() => memes.id, { onDelete: "cascade" }),
    /** 来源地址 */
    url: text("url").notNull(),
    /** 来源标题 */
    title: text("title"),
    /** 来源站点 */
    site: text("site"),
    /** 来源摘要 */
    summary: text("summary"),
    /** 页面发布时间 */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** 抓取时间 */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** 来源权威度，数值越大越可信 */
    authority: integer("authority"),
    /** 内容哈希，用于判断页面是否变过 */
    contentHash: text("content_hash"),
    /** 创建时间 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("meme_sources_meme_url_uq").on(table.memeId, table.url),
    index("meme_sources_meme_idx").on(table.memeId),
  ],
);

/**
 * 图片库。
 * category=sticker / meme 全局共享，conversationId 为 null；
 * category=image 是普通图片，只属于上传它的群，随会话级联删除。
 */
export const images = pgTable(
  "images",
  {
    /** 主键 */
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 文件内容的 sha256，全局去重 */
    sha256: text("sha256").notNull(),
    /** MIME 类型，压缩后通常是 image/webp */
    mime: text("mime").notNull(),
    /** 文件字节数 */
    bytes: integer("bytes").notNull(),
    /** 宽度，未知时为空 */
    width: integer("width"),
    /** 高度，未知时为空 */
    height: integer("height"),
    /** 图片二进制 */
    data: bytea("data").notNull(),
    /** image | sticker | meme */
    category: text("category").notNull().default("sticker"),
    /** sticker/meme 为 null（全局）；image 为上传群，删群时级联删除 */
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    /** 上传者 */
    uploaderPersonId: uuid("uploader_person_id").references(() => persons.id),
    /** 来源平台消息 id */
    sourceMsgId: text("source_msg_id"),
    /** 画面描述，参与检索 */
    caption: text("caption"),
    /** 情绪标签，例如好笑、无语 */
    emotion: text("emotion"),
    /** 检索标签 */
    tags: text("tags").array().notNull(),
    /** 分类或描述的置信度 */
    confidence: real("confidence"),
    /** 512 维向量，用于图片检索 */
    embedding: vector512("embedding"),
    /** QQ 媒体缓存地址 qqbot-media:// */
    mediaUrl: text("media_url"),
    /** QQ 媒体 image_id */
    mediaImageId: text("media_image_id"),
    /** 媒体上传时间，用于 80 天缓存判断 */
    mediaUpdatedAt: timestamp("media_updated_at", { withTimezone: true }),
    /** 成功发出去的次数，Bot 回写 */
    useCount: integer("use_count").notNull().default(0),
    /** 最近一次发送时间，Bot 回写 */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** 入库时间 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** sticker/meme 永久保存为 null；其它图片 30 天后过期 */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    // 表情包全局按内容去重；普通图片按群去重
    uniqueIndex("images_sticker_sha_uq")
      .on(table.sha256)
      .where(sql`${table.category} in ('sticker', 'meme')`),
    uniqueIndex("images_image_sha_uq")
      .on(table.sha256, table.conversationId)
      .where(sql`${table.category} = 'image'`),
    index("images_category_idx").on(table.category, table.createdAt),
    index("images_category_expires_idx").on(table.category, table.expiresAt),
    index("images_conversation_idx").on(table.conversationId, table.expiresAt),
    index("images_tags_idx").using("gin", table.tags),
    index("images_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

/** 只要 sticker / meme 的图片视图 */
export const stickerImages = pgView("sticker_images").as((qb) =>
  qb.select().from(images).where(inArray(images.category, ["sticker", "meme"])),
);
