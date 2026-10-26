import { eq, lte } from "drizzle-orm";
import type { Bot } from "../app/bot.js";
import type { Logger } from "../app/logger.js";
import { logger as defaultLogger } from "../app/logger.js";
import { canProactivelyReply } from "./policy.js";
import { proactiveSlotAt } from "./slot.js";
import { parseReplyMessages, type ReplyMessage } from "../chat/reply-format.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { conversations, proactiveSchedules } from "../db/schema.js";
import {
  getRecentMessagesWithNames,
  type RecentMessage,
} from "../db/repository.js";
import type { ModelProvider } from "../ports/model.js";

const DAY_MS = 24 * 3600_000;
const MIN_DELAY_MS = 60 * 60_000;
const TICK_MS = 60_000;

export type ProactiveSchedule = typeof proactiveSchedules.$inferSelect;

function formatTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function renderRecent(recent: RecentMessage[]): string {
  return recent
    .map((row) => {
      const text = row.content.parts
        .map((part) => (part.type === "text" ? part.text : "[图片]"))
        .join(" ")
        .trim();
      const name = row.role === "assistant" ? "助手" : (row.personName ?? "成员");
      return `[${formatTime(row.createdAt)}] ${name}: ${text}`;
    })
    .join("\n");
}

export async function generateProactiveReply(input: {
  provider: ModelProvider;
  conversationId: string;
  systemPrompt: string;
  personaPrompt: string;
  recent: RecentMessage[];
  now: Date;
}): Promise<ReplyMessage[] | null> {
  const last = input.recent.at(-1);
  if (!last) return null;

  const ageMinutes = Math.max(
    0,
    Math.round((input.now.getTime() - last.createdAt.getTime()) / 60_000),
  );
  const slot = proactiveSlotAt(input.now);
  const prompt = [
    "现在是一次群聊主动回复判断，不是被点名",
    `当前时间：${formatTime(input.now)}（${slot.label}）`,
    `最后一条消息时间：${formatTime(last.createdAt)}，约 ${ageMinutes} 分钟前`,
    "",
    "最近消息：",
    renderRecent(input.recent),
    "",
    "规则：",
    "- 只承接最后一条用户消息，不要补之前没来得及回的消息",
    "- 最后一条超过补回复窗口、话题已结束、没有自然接话点，就返回空数组",
    `- 现在是${slot.label}：${slot.hint}`,
    `- 回复内容要自然贴合${slot.label}，但不要直接报时间，也不要说“现在是几点”`,
    "- 回复要像群友自然接话，1-2 行，中文，不用 Markdown，不 @ 人",
    "- 不要重复最近机器人说过的话",
    "- 不要解释自己在主动发言",
    "- 最多 3 条消息，能一句说完就一条；分两条时用 gap 控制间隔，单位秒",
    '只输出 JSON：{"messages":[{"plainText":"第一段","voiceText":"","gap":0},{"plainText":"第二段","voiceText":"","gap":1.5}]} 或 {"messages":[]}',
  ].join("\n");

  const response = await input.provider.chat({
    sessionKey: `proactive:${input.conversationId}`,
    messages: [
      { role: "system", parts: [{ type: "text", text: input.systemPrompt }] },
      ...(input.personaPrompt
        ? [{ role: "system" as const, parts: [{ type: "text" as const, text: input.personaPrompt }] }]
        : []),
      { role: "user", parts: [{ type: "text", text: prompt }] },
    ],
    maxTokens: 260,
    temperature: 0.8,
  });

  const shards = parseReplyMessages(response.text)
    .slice(0, 3)
    .filter((message) => Boolean(message.plainText.trim() || message.voiceText.trim()));
  return shards.length > 0 ? shards : null;
}

function randomNextRunAt(now = Date.now()): Date {
  // 1-24 小时内随机，避免一启动就发
  const delay = MIN_DELAY_MS + Math.floor(Math.random() * (DAY_MS - MIN_DELAY_MS));
  return new Date(now + delay);
}

/**
 * 每个群每天随机抽一个时间点做一次主动回复判断。
 * 错过时间、最后消息太旧、模型说 null，都直接放弃，不补发。
 */
export class ProactiveScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      provider: ModelProvider;
      bot: Bot;
      isReady: () => boolean;
      logger?: Logger;
    },
  ) {
    this.log = deps.logger ?? defaultLogger;
  }

  start(): void {
    if (!config.PROACTIVE_ENABLED || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.log.info("proactive scheduler started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running || !config.PROACTIVE_ENABLED) return;
    this.running = true;
    try {
      await this.ensureSchedules();
      const due = await db
        .select()
        .from(proactiveSchedules)
        .where(lte(proactiveSchedules.nextRunAt, new Date()))
        .limit(20);

      for (const schedule of due) {
        try {
          await this.handle(schedule);
        } catch (error) {
          this.log.warn("proactive handle failed", schedule.conversationId, error);
          await this.reschedule(schedule.conversationId, "failed").catch(() => undefined);
        }
      }
    } catch (error) {
      this.log.warn("proactive tick failed", error);
    } finally {
      this.running = false;
    }
  }

  private async ensureSchedules(): Promise<void> {
    const groups = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.kind, "group"));

    const now = Date.now();
    const missGraceMs = config.PROACTIVE_MISS_GRACE_MINUTES * 60_000;

    for (const group of groups) {
      const rows = await db
        .select()
        .from(proactiveSchedules)
        .where(eq(proactiveSchedules.conversationId, group.id))
        .limit(1);
      const schedule = rows[0];

      if (!schedule) {
        await db
          .insert(proactiveSchedules)
          .values({ conversationId: group.id, nextRunAt: randomNextRunAt() })
          .onConflictDoNothing();
        continue;
      }

      if (schedule.nextRunAt.getTime() < now - missGraceMs) {
        await db
          .update(proactiveSchedules)
          .set({
            nextRunAt: randomNextRunAt(),
            lastResult: "missed",
            updatedAt: new Date(),
          })
          .where(eq(proactiveSchedules.conversationId, group.id));
        this.log.info("proactive missed, rescheduled", group.id);
      }
    }
  }

  private async handle(schedule: ProactiveSchedule): Promise<void> {
    const now = Date.now();
    const missGraceMs = config.PROACTIVE_MISS_GRACE_MINUTES * 60_000;
    if (now - schedule.nextRunAt.getTime() > missGraceMs) {
      await this.reschedule(schedule.conversationId, "missed");
      return;
    }

    if (!this.deps.isReady()) {
      await this.reschedule(schedule.conversationId, "offline");
      return;
    }

    const rows = await db
      .select({
        id: conversations.id,
        externalId: conversations.externalId,
        kind: conversations.kind,
      })
      .from(conversations)
      .where(eq(conversations.id, schedule.conversationId))
      .limit(1);
    const conversation = rows[0];
    if (!conversation) {
      await this.reschedule(schedule.conversationId, "no_conversation");
      return;
    }

    const recent = await getRecentMessagesWithNames(conversation.id, 12);
    const last = recent.at(-1);
    if (
      !canProactivelyReply(
        last,
        now,
        config.PROACTIVE_MAX_AGE_MINUTES * 60_000,
      )
    ) {
      await this.reschedule(
        schedule.conversationId,
        last ? "stale" : "no_message",
      );
      return;
    }

    const prompts = this.deps.bot.getPrompts();
    const reply = await generateProactiveReply({
      provider: this.deps.provider,
      conversationId: conversation.id,
      systemPrompt: prompts.systemPrompt,
      personaPrompt: prompts.personaPrompt,
      recent,
      now: new Date(now),
    });

    if (!reply) {
      await this.reschedule(schedule.conversationId, "no_reply");
      return;
    }

    await this.deps.bot.sendProactive({
      conversationId: conversation.id,
      conversationExternalId: conversation.externalId,
      conversationKind: conversation.kind as "group" | "dm",
      messages: reply,
    });
    await this.reschedule(schedule.conversationId, "sent");
  }

  private async reschedule(conversationId: string, result: string): Promise<void> {
    await db
      .update(proactiveSchedules)
      .set({
        nextRunAt: randomNextRunAt(),
        lastRunAt: new Date(),
        lastResult: result,
        updatedAt: new Date(),
      })
      .where(eq(proactiveSchedules.conversationId, conversationId));
    this.log.info("proactive scheduled next", conversationId, result);
  }
}
