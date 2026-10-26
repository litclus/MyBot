import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Logger } from "../app/logger.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { conversations, memories, messages } from "../db/schema.js";
import type { ModelProvider } from "../ports/model.js";
import { embedText } from "./embedding.js";

/**
 * 阶段摘要：每个群累计 20 条新消息后，压成一条 episode 记忆。
 * 只做导航，不替代原始消息；事实冲突时以原文为准。
 */
export class MemorySummarizer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly provider: ModelProvider,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 15 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<number> {
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.kind, "group"));

    let created = 0;
    for (const conversation of rows) {
      try {
        const episode = await this.summarize(conversation.id);
        if (episode) created += 1;
      } catch (error) {
        this.log.warn("summarize conversation failed", conversation.id, error);
      }
    }
    return created;
  }

  private async summarize(conversationId: string): Promise<boolean> {
    const last = await db
      .select({ periodEnd: memories.periodEnd })
      .from(memories)
      .where(and(eq(memories.conversationId, conversationId), eq(memories.kind, "episode")))
      .orderBy(desc(memories.periodEnd))
      .limit(1);

    const since = last[0]?.periodEnd ?? new Date(0);
    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.createdAt, since)))
      .orderBy(asc(messages.createdAt))
      .limit(40);

    if (rows.length < config.SUMMARY_MIN_MESSAGES) return false;

    const transcript = rows
      .map((row) => {
        const text = row.content.parts
          .map((part) => (part.type === "text" ? part.text : "[图片]"))
          .join(" ");
        return `[${row.createdAt.toISOString()}] ${row.role}: ${text}`;
      })
      .join("\n");

    const response = await this.provider.chat({
      sessionKey: `summary:${conversationId}`,
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: [
                "把这段群聊压缩成一条阶段摘要，供以后检索。要求：",
                "- 不超过 150 字；",
                "- 保留人名、时间、约定、决定、待办、未解决的问题；",
                "- 不编造，不评论；",
                "- 只输出摘要正文",
                "",
                transcript,
              ].join("\n"),
            },
          ],
        },
      ],
      maxTokens: 300,
      temperature: 0,
    });

    const summary = response.text.trim().slice(0, 300);
    if (!summary) return false;

    const first = rows[0];
    const lastRow = rows[rows.length - 1];
    if (!first || !lastRow) return false;

    const embedding = await embedText(summary);

    await db.insert(memories).values({
      conversationId,
      scope: "group",
      kind: "episode",
      content: summary,
      importance: 3,
      tags: ["episode"],
      sourceMsgIds: rows.map((row) => row.id),
      periodStart: first.createdAt,
      periodEnd: lastRow.createdAt,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
      ...(embedding ? { embedding } : {}),
    });

    this.log.info("episode summarized", conversationId, rows.length);
    return true;
  }

  private async tick(): Promise<void> {
    if (this.running || !config.SUMMARY_ENABLED) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.log.error("summarizer tick failed", error);
    } finally {
      this.running = false;
    }
  }
}
