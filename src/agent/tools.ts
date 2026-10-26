import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { describeBalanceSafe } from "../services/balance.js";
import { describeSearchBalanceSafe, describeSearchSafe } from "../services/websearch.js";
import { describeRateSafe } from "../services/fx.js";
import { images } from "../db/schema.js";
import {
  createMentionToken,
  getKnownMembers,
  type MentionCandidate,
} from "../db/repository.js";
import { quotedViewId } from "../chat/quoted.js";
import { getHistoryImages } from "../media/history-cache.js";
import {
  deleteMeme,
  formatMeme,
  getMeme,
  searchMemes,
  setMemeHeat,
  setMemeStatus,
  upsertMeme,
} from "../memes/repository.js";
import {
  formatMemory,
  getProfile,
  searchMemories,
} from "../memory/repository.js";
import { cosineSimilarity, embedText } from "../memory/embedding.js";
import type { ToolDefinition } from "../ports/model.js";
import type { DeferredAction, DeferredPayload, ToolExecutionResult } from "./actions.js";

export type ToolContextImage = {
  url: string;
  mime: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
};

export type GroupMemberInfo = {
  openid: string;
  name: string;
  role?: string;
  bot?: boolean;
};

export type FetchGroupMembers = (
  groupOpenId: string,
  cursor?: string,
) => Promise<{ members: GroupMemberInfo[]; nextCursor?: string }>;

export type ToolContext = {
  conversationId: string;
  conversationExternalId?: string;
  conversationKind?: "group" | "dm";
  personId: string;
  /** 当前平台消息 id，用于记录梗使用 */
  messageId?: string;
  /** 当前消息里的图片，顺序即 image_save 的 index */
  images?: ToolContextImage[];
  /** 引用消息里的图片，source=quoted 时使用 */
  quotedImages?: ToolContextImage[];
  /** 延迟写操作的过期时间 */
  actionExpiresAt?: number;
  /** 本轮可用于 @ 的成员；group_members 可以补充不在最近列表里的人 */
  mentionCandidates?: MentionCandidate[];
  /** 拉取当前群完整成员，由 QQ API 适配器提供 */
  fetchGroupMembers?: FetchGroupMembers;
};

export type AgentTool = {
  definition: ToolDefinition;
  execute: (
    input: unknown,
    context: ToolContext,
  ) => Promise<string | ToolExecutionResult>;
};

/**
 * MyBot 的工具注册表。
 *
 * 语义判断交给模型；这里只做机械的查询和格式化。
 */
export const agentTools: Record<string, AgentTool> = {
  balance_get: {
    definition: {
      type: "function",
      function: {
        name: "balance_get",
        description:
          "查当前余额（元）和大约还能吃多少 token。被问到余额、还剩多少 token、还有没有饭、够不够吃时调用",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    execute: async () => describeBalanceSafe(),
  },

  web_search: {
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "搜索网页，返回标题、摘要和链接。问新闻、价格、版本、政策、比赛结果这类会变的事，或遇到不认识的名词时调用",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "搜索词，最多 128 字。可带检索语法：site: 限定站点、-site: 排除、-词 排除词、\"短语\" 精确匹配、lang:zh,en 限语言、after:/before: 限时间",
            },
            count: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              description: "返回条数，默认 5",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input) => {
      const { query, count } = (input ?? {}) as { query?: string; count?: number };
      if (!query || !query.trim()) return "缺少 query";
      const size = count ?? config.DEEPSEEK_SEARCH_COUNT;
      return describeSearchSafe(query, size);
    },
  },

  search_balance: {
    definition: {
      type: "function",
      function: {
        name: "search_balance",
        description: "查网页搜索现在还能不能继续用。被问到搜索额度时调用",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    execute: async () => describeSearchBalanceSafe(),
  },

  fx_rate: {
    definition: {
      type: "function",
      function: {
        name: "fx_rate",
        description: "查两种货币之间的汇率。被问到汇率、换汇、多少钱换多少时调用",
        parameters: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "源货币的三字母代码，默认 CNY，例如 CNY、USD、JPY",
            },
            to: {
              type: "string",
              description: "目标货币的三字母代码，默认 USD",
            },
          },
          additionalProperties: false,
        },
      },
    },
    execute: async (input) => {
      const { from, to } = (input ?? {}) as { from?: string; to?: string };
      return describeRateSafe(from ?? "CNY", to ?? "USD");
    },
  },

  memory_search: {
    definition: {
      type: "function",
      function: {
        name: "memory_search",
        description:
          "搜索本群更早的记忆（约定、偏好、事实、决定）。问题涉及过去发生过的事、某人说过的话、之前的约定时调用",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "要搜索的关键词或短句，尽量具体，例如“周五桌游 地点”",
            },
            limit: {
              type: "integer",
              description: "返回条数，1-12，默认 6",
              minimum: 1,
              maximum: 12,
            },
          },
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { query, limit } = (input ?? {}) as { query?: string; limit?: number };
      const rows = await searchMemories({
        conversationId: context.conversationId,
        personId: context.personId,
        ...(query ? { query } : {}),
        ...(limit ? { limit } : {}),
      });
      if (rows.length === 0) return "没有找到相关记忆";
      return rows.map(formatMemory).join("\n");
    },
  },

  memory_save: {
    definition: {
      type: "function",
      function: {
        name: "memory_save",
        description:
          "当你判断某件事值得长期记住时主动调用，不需要用户说“记住”。写入长期记忆，并带上标签和重要度；不要用它记寒暄",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "要记住的完整内容，写清楚主体和事情" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "最多 5 个短标签，例如 偏好、忌口、约定",
            },
            importance: {
              type: "integer",
              minimum: 1,
              maximum: 5,
              description: "重要度 1-5，按这件事以后还会不会用到判断",
            },
            scope: {
              type: "string",
              enum: ["member", "group"],
              description: "只和说话人有关用 member，全群约定用 group",
            },
            kind: {
              type: "string",
              enum: ["fact", "preference", "decision", "event", "task", "identity"],
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const data = (input ?? {}) as {
        content?: string;
        tags?: string[];
        importance?: number;
        scope?: "member" | "group";
        kind?: string;
      };
      const content = data.content?.trim().slice(0, 500);
      if (!content) return "没有可保存的内容";

      const tags = [
        ...new Set(
          Array.isArray(data.tags)
            ? data.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
        ),
      ].slice(0, 5);
      const importance = Math.min(Math.max(Math.round(data.importance ?? 3), 1), 5);
      const scope = data.scope === "group" ? "group" : "member";
      const allowedKinds = new Set([
        "fact",
        "preference",
        "decision",
        "event",
        "task",
        "identity",
      ]);
      const kind = data.kind && allowedKinds.has(data.kind) ? data.kind : "fact";
      return defer(
        `已准备记住：${content}（重要度 ${importance}，标签 ${tags.join("、")}）`,
        {
          kind: "memory_save",
          payload: {
            conversationId: context.conversationId,
            ...(scope === "member" ? { personId: context.personId } : {}),
            scope,
            kind,
            content,
            tags,
            importance,
          },
        },
        context,
      );
    },
  },

  profile_get: {
    definition: {
      type: "function",
      function: {
        name: "profile_get",
        description: "获取当前说话人的名字、别名和长期画像",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    execute: async (_input, context) => {
      const profile = await getProfile(context.personId);
      if (!profile) return "没有找到当前说话人的画像";
      return JSON.stringify(profile);
    },
  },

  group_members: {
    definition: {
      type: "function",
      function: {
        name: "group_members",
        description:
          "获取当前群的完整成员列表，包括最近没发过言的人。要找某个人、确认某人在不在群里、或者要 @ 不在最近活跃列表里的人时调用。可以按群名片、QQ 昵称或别名筛选，返回的 token 直接写进 [[mention:token]] 就能 @",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "按名字筛选，不填则返回成员列表",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "最多返回多少人，默认 30",
            },
          },
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      if (context.conversationKind !== "group" || !context.conversationExternalId) {
        return "当前不是群聊，查不到群成员";
      }
      if (!context.fetchGroupMembers) return "群成员接口没有配置";
      if (!context.mentionCandidates) return "当前没有 @ 成员上下文";

      const data = (input ?? {}) as { query?: string; limit?: number };
      const queryText = data.query?.trim() ?? "";
      const keyword = queryText.toLowerCase();
      const max = Math.min(Math.max(Math.round(data.limit ?? 30), 1), 100);
      const maxPages = keyword ? 8 : Math.min(4, Math.ceil(max / 30));
      const members = new Map<string, GroupMemberInfo>();
      let cursor: string | undefined;
      let complete = false;

      try {
        for (let page = 0; page < maxPages; page += 1) {
          const result = await context.fetchGroupMembers(
            context.conversationExternalId,
            cursor,
          );
          for (const member of result.members) {
            const openid = member.openid?.trim();
            if (!openid || member.bot) continue;
            if (!members.has(openid)) {
              members.set(openid, {
                ...member,
                openid,
                name: member.name?.trim() || "成员",
              });
            }
          }
          cursor = result.nextCursor;
          if (!cursor) {
            complete = true;
            break;
          }
          if (!keyword && members.size >= max) break;
          if (
            keyword &&
            [...members.values()].filter((member) =>
              member.name.toLowerCase().includes(keyword),
            ).length >= max
          ) {
            break;
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const fallback = await getKnownMembers({
          conversationId: context.conversationId,
          ...(keyword ? { query: queryText } : {}),
          limit: max,
        }).catch(() => []);
        if (fallback.length === 0) return `获取群成员失败：${reason}`;
        return `群成员接口不可用（${reason}），只能列出本地记录过的 ${fallback.length} 人，没发过言的人查不到\n${renderMentionMembers(fallback, context)}`;
      }

      const all = [...members.values()];
      const matched = keyword
        ? all.filter((member) => member.name.toLowerCase().includes(keyword))
        : all;
      const selected = matched.slice(0, max);
      if (selected.length === 0) {
        if (keyword) {
          return complete
            ? `群里没有名字包含“${queryText}”的成员`
            : `前 ${all.length} 个成员里没有名字包含“${queryText}”的人`;
        }
        return "群里没有成员";
      }

      return `已读取 ${all.length} 人，显示 ${selected.length} 人\n${renderMentionMembers(selected, context)}`;
    },
  },

  image_view: {
    definition: {
      type: "function",
      function: {
        name: "image_view",
        description:
          "打开最近 10 分钟内历史消息里的图片。messageId 用该消息 JSON 的 id；引用图片用 quoted.viewId",
        parameters: {
          type: "object",
          properties: {
            messageId: {
              type: "string",
              description: "历史消息 JSON 里的 id，或引用图片的 quoted.viewId",
            },
            index: {
              type: "integer",
              minimum: 1,
              description: "这条消息里的第几张图，从 1 开始，默认 1",
            },
          },
          required: ["messageId"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input) => {
      const { messageId, index } = (input ?? {}) as { messageId?: string; index?: number };
      if (!messageId) return "缺少 messageId";
      const images = getHistoryImages(messageId);
      if (!images || images.length === 0) {
        return "这张历史图片已经不在短期缓存里了，只能看到附件元数据";
      }
      const at = Number.isInteger(index) ? index! : 1;
      const image = images.find((item) => item.index === at)?.part;
      if (!image) return `图片序号超出范围，这条消息有 ${images.length} 张`;
      return {
        content: `已打开历史消息 ${messageId} 的第 ${at} 张图`,
        images: [image],
      };
    },
  },

  image_save: {
    definition: {
      type: "function",
      function: {
        name: "image_save",
        description:
          "把当前消息或引用消息里的一张图存进图片库。用户明确要保存/收藏，或这张图以后能当表情包、梗图复用时才调用；不要每张图都存。分类和描述由你自己判断，不需要额外的视觉模型",
        parameters: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: ["current", "quoted"],
              description: "current 是当前消息，quoted 是引用消息；默认 current",
            },
            viewId: {
              type: "string",
              description: "quoted.viewId 或历史消息 id；直接从 10 分钟缓存里保存",
            },
            index: {
              type: "integer",
              minimum: 1,
              description: "对应来源里的第几张图，从 1 开始，默认 1",
            },
            category: {
              type: "string",
              enum: ["image", "sticker", "meme"],
              description: "表情包填 sticker（全局），梗图填 meme（全局），普通照片/截图填 image（只在本群可见）",
            },
            caption: { type: "string", description: "一句话描述画面，40 字以内" },
            emotion: { type: "string", description: "情绪，例如好笑、无语、点赞" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "最多 5 个短标签",
            },
          },
          required: ["category", "caption"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const data = (input ?? {}) as {
        source?: string;
        index?: number;
        viewId?: string;
        category?: string;
        caption?: string;
        emotion?: string;
        tags?: string[];
      };
      const source = data.source === "quoted" ? "quoted" : "current";
      const index = Number.isInteger(data.index) ? data.index! : 1;
      if (
        data.category !== "image" &&
        data.category !== "sticker" &&
        data.category !== "meme"
      ) {
        return "category 只能是 image / sticker / meme";
      }
      const caption = data.caption?.trim().slice(0, 80);
      if (!caption) return "caption 不能为空";
      if (!context.messageId) return "缺少当前消息 id";

      const emotion = data.emotion?.trim().slice(0, 20) || null;
      const tags = Array.isArray(data.tags)
        ? [...new Set(data.tags.filter((tag): tag is string => typeof tag === "string"))]
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];

      const viewId = data.viewId?.trim();
      if (viewId) {
        const cached = getHistoryImages(viewId)?.find((item) => item.index === index);
        if (!cached) return "缓存里没有这张历史图片，可能超过 10 分钟了";
        return defer(
          `已准备保存第 ${index} 张图：${caption}`,
          {
            kind: "image_save",
            payload: {
              conversationId: context.conversationId,
              uploaderPersonId: context.personId,
              sourceMsgId: context.messageId,
              cacheKey: viewId,
              imageIndex: index,
              url: "",
              category: data.category,
              caption,
              emotion,
              tags,
            },
          },
          context,
        );
      }

      const images = source === "quoted" ? (context.quotedImages ?? []) : (context.images ?? []);
      if (images.length === 0) {
        return source === "quoted" ? "引用消息里没有图片" : "当前消息没有图片";
      }
      const image = images[index - 1];
      if (index < 1 || !image) return `图片序号超出范围，当前有 ${images.length} 张`;

      return defer(
        `已准备保存第 ${index} 张图：${caption}`,
        {
          kind: "image_save",
          payload: {
            conversationId: context.conversationId,
            uploaderPersonId: context.personId,
            sourceMsgId: context.messageId,
            cacheKey:
              source === "quoted" ? quotedViewId(context.messageId) : context.messageId,
            imageIndex: index,
            url: image.url,
            category: data.category,
            caption,
            emotion,
            tags,
          },
        },
        context,
      );
    },
  },

  image_search: {
    definition: {
      type: "function",
      function: {
        name: "image_search",
        description:
          "搜索图片库里的 sticker/meme/image，按画面描述、情绪或标签匹配。sticker/meme 搜全库，普通图片只搜本群。想要表情包或梗图时调用",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "情绪或画面关键词，例如“无语”“猫猫”“点赞”" },
            category: {
              type: "string",
              enum: ["image", "sticker", "meme"],
              description: "不填则搜索全部分类",
            },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { query, category, limit } = (input ?? {}) as {
        query?: string;
        category?: string;
        limit?: number;
      };
      const max = Math.min(Math.max(limit ?? 5, 1), 10);
      const q = query?.trim() ?? "";
      const filters = [isNotNull(images.caption), imageScope(context)];
      if (category === "image" || category === "sticker" || category === "meme") {
        filters.push(eq(images.category, category));
      }
      const base = and(...filters)!;

      if (!q) {
        const rows = await db
          .select({
            id: images.id,
            category: images.category,
            caption: images.caption,
            emotion: images.emotion,
            tags: images.tags,
          })
          .from(images)
          .where(base)
          .orderBy(desc(images.createdAt))
          .limit(max);
        return formatImageRows(rows);
      }

      const queryVector = await embedText(q);
      const terms = q
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(Boolean);

      const vectorRows: ImageCandidate[] =
        queryVector === null
          ? []
          : await db.transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
              await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`);
              return tx
                .select(imageCandidateColumns)
                .from(images)
                .where(and(base, isNotNull(images.embedding)))
                .orderBy(
                  sql`${images.embedding} <=> ${`[${queryVector.join(",")}]`}::vector`,
                )
                .limit(50);
            });

      const keywordConditions = terms.flatMap((term) => {
        const pattern = `%${escapeLike(term)}%`;
        return [
          ilike(images.caption, pattern),
          ilike(images.emotion, pattern),
          sql`array_to_string(${images.tags}, ' ') ILIKE ${pattern}`,
          sql`${term} = ANY(${images.tags})`,
        ];
      });

      const keywordRows: ImageCandidate[] =
        keywordConditions.length === 0
          ? []
          : await db
              .select(imageCandidateColumns)
              .from(images)
              .where(and(base, or(...keywordConditions)!))
              .limit(50);

      const merged = new Map<number, ImageCandidate>();
      for (const row of vectorRows) merged.set(row.id, row);
      for (const row of keywordRows) merged.set(row.id, row);

      const scored = [...merged.values()].map((row) => {
        const haystack =
          `${row.caption ?? ""} ${row.emotion ?? ""} ${row.tags.join(" ")}`.toLowerCase();
        const keyword = terms.some((term) => haystack.includes(term)) ? 1 : 0;
        const similarity =
          queryVector && row.embedding ? cosineSimilarity(queryVector, row.embedding) : 0;
        const ageDays = Math.max(0, (Date.now() - row.createdAt.getTime()) / 86_400_000);
        const recency = Math.exp((-Math.LN2 * ageDays) / 30);
        const usage = Math.min(1, Math.log1p(row.useCount) / 5);
        const score = 0.45 * similarity + 0.3 * keyword + 0.15 * recency + 0.1 * usage;
        return { row, score, similarity, keyword };
      });

      const selected = scored
        .filter(
          (item) => item.keyword > 0 || (queryVector !== null && item.similarity >= 0.35),
        )
        .sort((left, right) => right.score - left.score)
        .slice(0, max)
        .map((item) => item.row);

      return formatImageRows(selected);
    },
  },

  image_list: {
    definition: {
      type: "function",
      function: {
        name: "image_list",
        description: "列出图片库最近的图片，带 id、category、描述、情绪和标签，方便修改或删除。sticker/meme 全库，普通图片只列本群",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["image", "sticker", "meme"] },
            limit: { type: "integer", minimum: 1, maximum: 20 },
          },
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { category, limit } = (input ?? {}) as {
        category?: string;
        limit?: number;
      };
      const filters = [imageScope(context)];
      if (category === "image" || category === "sticker" || category === "meme") {
        filters.push(eq(images.category, category));
      }
      const rows = await db
        .select({
          id: images.id,
          category: images.category,
          caption: images.caption,
          emotion: images.emotion,
          tags: images.tags,
        })
        .from(images)
        .where(and(...filters))
        .orderBy(desc(images.createdAt))
        .limit(Math.min(Math.max(limit ?? 10, 1), 20));
      return formatImageRows(rows);
    },
  },

  image_update: {
    definition: {
      type: "function",
      function: {
        name: "image_update",
        description: "修改图片的 category、caption、情绪或标签；先用 image_search / image_list 拿 id",
        parameters: {
          type: "object",
          properties: {
            id: { type: "integer", description: "图片 id" },
            category: { type: "string", enum: ["image", "sticker", "meme"] },
            caption: { type: "string" },
            emotion: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const data = (input ?? {}) as {
        id?: number;
        category?: string;
        caption?: string;
        emotion?: string;
        tags?: string[];
      };
      if (!Number.isInteger(data.id) || (data.id ?? 0) <= 0) return "图片 id 不合法";

      const rows = await db
        .select()
        .from(images)
        .where(and(eq(images.id, data.id!), imageScope(context)))
        .limit(1);
      const current = rows[0];
      if (!current) return `没有找到图片 #${data.id}`;

      const category =
        data.category === "image" ||
        data.category === "sticker" ||
        data.category === "meme"
          ? data.category
          : current.category;
      const caption =
        data.caption !== undefined ? data.caption.trim().slice(0, 80) : current.caption;
      if (!caption) return "caption 不能为空";
      const emotion =
        data.emotion !== undefined ? data.emotion.trim().slice(0, 20) || null : current.emotion;
      const tags = Array.isArray(data.tags)
        ? data.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 5)
        : current.tags;
      return defer(
        `已准备更新图片 #${data.id}`,
        {
          kind: "image_update",
          payload: {
            id: data.id!,
            conversationId: context.conversationId,
            category,
            caption,
            emotion,
            tags,
          },
        },
        context,
      );
    },
  },

  image_delete: {
    definition: {
      type: "function",
      function: {
        name: "image_delete",
        description: "删除一个图片；先用 image_search / image_list 拿 id",
        parameters: {
          type: "object",
          properties: {
            id: { type: "integer", description: "图片 id" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { id } = (input ?? {}) as { id?: number };
      if (!Number.isInteger(id) || (id ?? 0) <= 0) return "图片 id 不合法";
      const rows = await db
        .select({ id: images.id })
        .from(images)
        .where(and(eq(images.id, id!), imageScope(context)))
        .limit(1);
      if (rows.length === 0) return `没有找到图片 #${id}`;
      return defer(
        `已准备删除图片 #${id}`,
        {
          kind: "image_delete",
          payload: { id: id!, conversationId: context.conversationId },
        },
        context,
      );
    },
  },

  meme_search: {
    definition: {
      type: "function",
      function: {
        name: "meme_search",
        description:
          "查询网络梗/黑话/固定句式的含义、来源、回复方式和示例。遇到不认识的梗、或用户要求玩梗时调用；按 replyGuide 和 examples 自己组织回复",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "梗的关键词或描述，例如“token来”" },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { query, limit } = (input ?? {}) as { query?: string; limit?: number };
      const results = await searchMemes({
        ...(query ? { query } : {}),
        ...(limit ? { limit } : {}),
      });
      if (results.length === 0) return "没有找到相关梗";
      return results.map(formatMeme).join("\n\n");
    },
  },

  meme_mark_used: {
    definition: {
      type: "function",
      function: {
        name: "meme_mark_used",
        description:
          "meme_search 返回的梗真的被用进回复后调用，记录一次真实使用；只搜不用不要调",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string", description: "实际使用的那条梗的 keyword" },
          },
          required: ["keyword"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { keyword } = (input ?? {}) as { keyword?: string };
      if (!keyword) return "缺少 keyword";
      return defer(
        `已准备记录梗使用：${keyword}`,
        {
          kind: "meme_use",
          payload: { keyword },
        },
        context,
      );
    },
  },

  meme_upsert: {
    definition: {
      type: "function",
      function: {
        name: "meme_upsert",
        description:
          "新增或更新一条梗知识。用户明确让你记住某个梗、修改含义或回复方式时调用；尽量带上输入和回复示例",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            title: { type: "string" },
            meaning: { type: "string", description: "这个梗是什么意思、什么场景用" },
            replyGuide: { type: "string", description: "应该怎么回复" },
            aliases: { type: "array", items: { type: "string" } },
            examples: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  input: { type: "string" },
                  reply: { type: "string" },
                },
                required: ["input", "reply"],
                additionalProperties: false,
              },
              description: "输入和回复示例，最多 5 条",
            },
            tags: { type: "array", items: { type: "string" } },
            heat: { type: "integer", minimum: 1, maximum: 5 },
            status: { type: "string", enum: ["active", "outdated"] },
            sourceUrl: { type: "string" },
            sourceTitle: { type: "string" },
            sourceSite: { type: "string" },
            sourceSummary: { type: "string" },
            sourceFetchedAt: { type: "string", description: "ISO 时间" },
            sourceAuthority: { type: "integer" },
            sourceHash: { type: "string" },
          },
          required: ["keyword", "title", "meaning", "replyGuide"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const data = (input ?? {}) as {
        keyword?: string;
        title?: string;
        meaning?: string;
        replyGuide?: string;
        aliases?: string[];
        examples?: Array<{ input: string; reply: string }>;
        tags?: string[];
        heat?: number;
        status?: "active" | "outdated";
        sourceUrl?: string;
        sourceTitle?: string;
        sourceSite?: string;
        sourceSummary?: string;
        sourceFetchedAt?: string;
        sourceAuthority?: number;
        sourceHash?: string;
      };
      if (!data.keyword || !data.title || !data.meaning || !data.replyGuide) {
        return "缺少必填字段：keyword/title/meaning/replyGuide";
      }
      const examples = Array.isArray(data.examples)
        ? data.examples
            .filter(
              (item): item is { input: string; reply: string } =>
                Boolean(item) &&
                typeof (item as { input?: unknown }).input === "string" &&
                typeof (item as { reply?: unknown }).reply === "string",
            )
            .slice(0, 5)
        : undefined;
      return defer(
        `已准备保存梗：${data.keyword}`,
        {
          kind: "meme_upsert",
          payload: {
            keyword: data.keyword,
            title: data.title,
            meaning: data.meaning,
            replyGuide: data.replyGuide,
            ...(data.aliases ? { aliases: data.aliases } : {}),
            ...(examples ? { examples } : {}),
            ...(data.tags ? { tags: data.tags } : {}),
            ...(data.heat !== undefined ? { heat: data.heat } : {}),
            ...(data.status ? { status: data.status } : {}),
            ...(data.sourceUrl ? { sourceUrl: data.sourceUrl } : {}),
            ...(data.sourceTitle ? { sourceTitle: data.sourceTitle } : {}),
            ...(data.sourceSite ? { sourceSite: data.sourceSite } : {}),
            ...(data.sourceSummary ? { sourceSummary: data.sourceSummary } : {}),
            ...(data.sourceFetchedAt
              ? { sourceFetchedAt: new Date(data.sourceFetchedAt) }
              : {}),
            ...(data.sourceAuthority !== undefined
              ? { sourceAuthority: data.sourceAuthority }
              : {}),
            ...(data.sourceHash ? { sourceHash: data.sourceHash } : {}),
          },
        },
        context,
      );
    },
  },

  meme_delete: {
    definition: {
      type: "function",
      function: {
        name: "meme_delete",
        description: "删除一条梗知识。只有用户明确要求删除时调用",
        parameters: {
          type: "object",
          properties: { keyword: { type: "string" } },
          required: ["keyword"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { keyword } = (input ?? {}) as { keyword?: string };
      if (!keyword) return "缺少 keyword";
      if (!(await getMeme(keyword))) return `没有找到梗：${keyword}`;
      return defer(
        `已准备删除梗：${keyword}`,
        { kind: "meme_delete", payload: { keyword } },
        context,
      );
    },
  },

  meme_set_status: {
    definition: {
      type: "function",
      function: {
        name: "meme_set_status",
        description: "把梗标记为过时或恢复有效。过时的梗不会进入正常检索",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            status: { type: "string", enum: ["active", "outdated"] },
          },
          required: ["keyword", "status"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { keyword, status } = (input ?? {}) as {
        keyword?: string;
        status?: "active" | "outdated";
      };
      if (!keyword || (status !== "active" && status !== "outdated")) {
        return "参数不合法";
      }
      if (!(await getMeme(keyword))) return `没有找到梗：${keyword}`;
      return defer(
        `已准备把梗 ${keyword} 状态改为 ${status}`,
        { kind: "meme_set_status", payload: { keyword, status } },
        context,
      );
    },
  },

  meme_set_heat: {
    definition: {
      type: "function",
      function: {
        name: "meme_set_heat",
        description: "设置梗的热度（1-5），热度会作为检索排序参数",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            heat: { type: "integer", minimum: 1, maximum: 5 },
          },
          required: ["keyword", "heat"],
          additionalProperties: false,
        },
      },
    },
    execute: async (input, context) => {
      const { keyword, heat } = (input ?? {}) as { keyword?: string; heat?: number };
      if (!keyword || heat === undefined) return "参数不合法";
      if (!(await getMeme(keyword))) return `没有找到梗：${keyword}`;
      return defer(
        `已准备把梗 ${keyword} 热度改为 ${heat}/5`,
        { kind: "meme_set_heat", payload: { keyword, heat } },
        context,
      );
    },
  },
};

type ImageResultRow = {
  id: number;
  category: string;
  caption: string | null;
  emotion: string | null;
  tags: string[];
};

type ImageCandidate = ImageResultRow & {
  embedding: number[] | null;
  createdAt: Date;
  useCount: number;
};

/** 表情包全局可见；普通图片只在自己的群里可见 */
function imageScope(context: ToolContext) {
  return or(
    inArray(images.category, ["sticker", "meme"]),
    and(eq(images.category, "image"), eq(images.conversationId, context.conversationId)),
  )!;
}

const imageCandidateColumns = {
  id: images.id,
  category: images.category,
  caption: images.caption,
  emotion: images.emotion,
  tags: images.tags,
  embedding: images.embedding,
  createdAt: images.createdAt,
  useCount: images.useCount,
};

function formatImageRows(rows: ImageResultRow[]): string {
  if (rows.length === 0) return "没有找到合适的图片";
  return rows
    .map(
      (row) =>
        `- #${row.id} [${row.category}] [${row.emotion ?? "未标注"}] ${row.caption ?? "(未描述)"} (${row.tags.join(",")})`,
    )
    .join("\n");
}

/** 给成员补 token 并格式化成模型能直接抄的 @ 列表 */
function renderMentionMembers(
  members: Array<{
    openid: string;
    name: string;
    role?: string | null;
    aliases?: string[];
  }>,
  context: ToolContext,
): string {
  const candidates = context.mentionCandidates ?? [];
  const used = new Set(candidates.map((candidate) => candidate.token));
  return members
    .map((member) => {
      const existing = candidates.find((candidate) => candidate.openid === member.openid);
      const token = existing?.token ?? createMentionToken(member.openid, used);
      if (!existing) {
        candidates.push({
          token,
          openid: member.openid,
          name: member.name,
          role: member.role ?? null,
          aliases: (member.aliases ?? []).filter(Boolean),
        });
      }
      const aliases = (member.aliases ?? [])
        .filter((alias) => alias !== member.name)
        .slice(0, 3);
      const label = [
        roleLabel(member.role ?? undefined),
        aliases.length > 0 ? `别名 ${aliases.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("，");
      return `- ${member.name}${label ? `（${label}）` : ""} → [[mention:${token}]]`;
    })
    .join("\n");
}

function roleLabel(role: string | undefined): string {
  if (role === "owner") return "群主";
  if (role === "admin") return "管理员";
  if (role === "member") return "成员";
  return role ?? "";
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function defer(
  content: string,
  payload: DeferredPayload,
  context: ToolContext,
): ToolExecutionResult {
  const expiresAt = context.actionExpiresAt ?? Date.now() + 5 * 60_000;
  return { content, actions: [{ ...payload, expiresAt }] };
}

