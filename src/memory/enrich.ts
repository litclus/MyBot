import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { memories, messages, persons } from "../db/schema.js";
import type { ModelProvider } from "../ports/model.js";
import type { Logger } from "../app/logger.js";
import { extractJsonObject } from "../util/json.js";
import { embedText } from "./embedding.js";

const KINDS = new Set([
  "noise",
  "chitchat",
  "fact",
  "preference",
  "decision",
  "event",
  "task",
  "identity",
]);

const DEFAULT_TTL_DAYS: Record<string, number> = {
  noise: 1,
  chitchat: 3,
  fact: 90,
  preference: 180,
  decision: 90,
  event: 30,
  task: 30,
  identity: 3650,
};

type EnrichFact = {
  subject?: string;
  predicate?: string;
  object?: string;
  scope?: "group" | "member";
};

type EnrichItem = {
  id?: string;
  kind?: string;
  importance?: number;
  tags?: unknown;
  summary?: string;
  facts?: EnrichFact[];
  ttlDays?: number;
  eventTime?: string | null;
};

type PendingMessage = {
  id: string;
  conversationId: string;
  personId: string | null;
  personName: string | null;
  text: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/**
 * 后台记忆加工：
 * - 每 5 秒取一批未加工的用户消息；
 * - 让模型输出 kind/importance/tags/summary/facts/ttl；
 * - 回填 messages，并把 fact/preference/decision/event/task 写进 memories；
 * - 对 preference/identity 合并到 persons.profile。
 *
 * 失败的消息会在内存里冷却 5 分钟，避免死循环。
 */
export class MemoryEnricher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly failed = new Map<string, number>();

  constructor(
    private readonly provider: ModelProvider,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.ENRICH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<number> {
    return this.enrichBatch();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.enrichBatch();
    } catch (error) {
      this.log.error("memory enrich tick failed", error);
    } finally {
      this.running = false;
    }
  }

  private async enrichBatch(): Promise<number> {
    const rows = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        personId: messages.personId,
        personName: persons.displayName,
        content: messages.content,
        createdAt: messages.createdAt,
        metadata: messages.metadata,
      })
      .from(messages)
      .leftJoin(persons, eq(messages.personId, persons.id))
      .where(and(eq(messages.role, "user"), isNull(messages.importance)))
      .orderBy(asc(messages.createdAt))
      .limit(config.ENRICH_BATCH_SIZE);

    if (rows.length === 0) return 0;

    const now = Date.now();
    const pending: PendingMessage[] = [];
    const emptyIds: string[] = [];

    for (const row of rows) {
      const coolDown = this.failed.get(row.id);
      const text = row.content.parts
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .trim();
      if (!text) {
        emptyIds.push(row.id);
        continue;
      }
      if (coolDown && coolDown > now) continue;
      pending.push({
        id: row.id,
        conversationId: row.conversationId,
        personId: row.personId,
        personName: row.personName,
        text,
        createdAt: row.createdAt,
        metadata: row.metadata,
      });
    }

    // 纯图片/空消息：不让它阻塞队列
    if (emptyIds.length > 0) {
      await db
        .update(messages)
        .set({ importance: 2, tags: ["image"] })
        .where(inArray(messages.id, emptyIds));
    }

    if (pending.length === 0) return 0;

    let items: EnrichItem[];
    try {
      items = await this.ask(pending);
    } catch (error) {
      this.log.warn("memory enrich model failed", error);
      const until = Date.now() + 5 * 60_000;
      for (const message of pending) this.failed.set(message.id, until);
      return 0;
    }

    const byId = new Map<string, EnrichItem>();
    for (const item of items) {
      if (item.id && pending.some((message) => message.id === item.id)) {
        byId.set(item.id, item);
      }
    }

    let processed = 0;
    for (const message of pending) {
      const item = byId.get(message.id);
      if (!item) continue;
      try {
        await this.apply(message, item);
        processed += 1;
      } catch (error) {
        this.log.warn("memory enrich apply failed", message.id, error);
      }
    }

    if (processed > 0) this.log.info("memory enriched", processed);
    return processed;
  }

  private async ask(pending: PendingMessage[]): Promise<EnrichItem[]> {
    const input = pending.map((message) => ({
      id: message.id,
      name: message.personName ?? "成员",
      at: message.createdAt.toISOString(),
      text: message.text,
    }));

    const prompt = [
      "你是群聊记忆整理器。为每条消息输出结构化结果，只输出 JSON",
      "输出格式：",
      '{"items":[{',
      '"id":"原样返回消息 id",',
      '"kind":"noise|chitchat|fact|preference|decision|event|task|identity",',
      '"importance":1-5,',
      '"tags":["最多5个短标签"],',
      '"summary":"不超过120字的摘要",',
      '"facts":[{"subject":"主体","predicate":"关系/动作","object":"对象","scope":"group|member"}],',
      '"ttlDays":1-3650,',
      '"eventTime":"ISO 时间或 null"',
      "}]}",
      "规则：",
      "- 寒暄、表情、收到、哈哈：noise，importance 1，ttlDays 1",
      "- 普通闲聊：chitchat，importance 1-2，ttlDays 3",
      "- 明确的事实/偏好：fact/preference，importance 3-5，preference 的 ttlDays 180",
      "- 约定、决定、待办：decision/event/task，importance 4-5",
      "- 名字、身份、长期称呼：identity，importance 5，ttlDays 3650",
      "- 只提取明确说出的信息，不要猜测；facts 可以为空",
      "- member 表示只与说话人有关，group 表示全群适用",
      "",
      "消息列表：",
      JSON.stringify(input),
    ].join("\n");

    const response = await this.provider.chat({
      sessionKey: "enrich:memory",
      messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
      maxTokens: 1200,
      temperature: 0,
    });

    const parsed = extractJsonObject(response.text) as { items?: EnrichItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  }

  private async apply(message: PendingMessage, item: EnrichItem): Promise<void> {
    const kind = item.kind && KINDS.has(item.kind) ? item.kind : "chitchat";
    const importance = clamp(Math.round(item.importance ?? 2), 1, 5);
    const tags = Array.isArray(item.tags)
      ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 5)
      : [];
    const summary = typeof item.summary === "string" ? item.summary.slice(0, 240) : "";
    const facts = Array.isArray(item.facts) ? item.facts.slice(0, 6) : [];
    const defaultTtl = DEFAULT_TTL_DAYS[kind] ?? 7;
    const ttlDays = clamp(Math.round(item.ttlDays ?? defaultTtl), 1, 3650);
    const now = Date.now();

    const messageExpiry =
      kind === "noise"
        ? new Date(now + 24 * 3600_000)
        : kind === "chitchat"
          ? new Date(now + 7 * 24 * 3600_000)
          : null;

    await db
      .update(messages)
      .set({
        importance,
        tags,
        expiresAt: messageExpiry,
      })
      .where(eq(messages.id, message.id));

    if (kind === "noise" || kind === "chitchat") return;

    const memoryExpiry = expiryFor(kind, ttlDays, item.eventTime, now);
    const scopedFacts = facts.filter(
      (fact) => fact.subject || fact.predicate || fact.object,
    );

    if (scopedFacts.length === 0) {
      if (!summary) return;
      await this.insertMemory(message, {
        kind,
        importance,
        tags,
        summary,
        scope: "group",
        expiresAt: memoryExpiry,
      });
      return;
    }

    for (const fact of scopedFacts) {
      const scope = fact.scope === "member" ? "member" : "group";
      const content =
        [fact.subject, fact.predicate, fact.object].filter(Boolean).join(" ") || summary;
      await this.insertMemory(message, {
        kind,
        importance,
        tags,
        summary: content,
        scope,
        expiresAt: memoryExpiry,
        subject: fact.subject ?? null,
        predicate: fact.predicate ?? null,
        object: fact.object ?? null,
      });
    }

    if (kind === "preference" || kind === "identity") {
      await this.mergeProfile(message.personId, scopedFacts);
    }
  }

  private async insertMemory(
    message: PendingMessage,
    input: {
      kind: string;
      importance: number;
      tags: string[];
      summary: string;
      scope: "group" | "member";
      expiresAt: Date | null;
      subject?: string | null;
      predicate?: string | null;
      object?: string | null;
    },
  ): Promise<void> {
    const personId = input.scope === "member" ? message.personId : null;
    const embedding = await embedText(input.summary);

    let previous: { id: number } | undefined;
    if (input.subject && input.predicate) {
      const rows = await db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.conversationId, message.conversationId),
            eq(memories.scope, input.scope),
            eq(memories.subject, input.subject),
            eq(memories.predicate, input.predicate),
            isNull(memories.supersededBy),
            personId ? eq(memories.personId, personId) : isNull(memories.personId),
          ),
        )
        .limit(1);
      previous = rows[0];
    }

    const rows = await db
      .insert(memories)
      .values({
        conversationId: message.conversationId,
        ...(personId ? { personId } : {}),
        scope: input.scope,
        kind: input.kind,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.predicate ? { predicate: input.predicate } : {}),
        ...(input.object ? { object: input.object } : {}),
        content: input.summary,
        tags: input.tags,
        importance: input.importance,
        sourceMsgIds: [message.id],
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(embedding ? { embedding } : {}),
      })
      .returning({ id: memories.id });

    const inserted = rows[0];
    if (inserted && previous && previous.id !== inserted.id) {
      await db
        .update(memories)
        .set({ supersededBy: inserted.id })
        .where(eq(memories.id, previous.id));
    }
  }

  private async mergeProfile(personId: string | null, facts: EnrichFact[]): Promise<void> {
    if (!personId) return;
    const rows = await db
      .select({ profile: persons.profile })
      .from(persons)
      .where(eq(persons.id, personId))
      .limit(1);
    const current = rows[0]?.profile ?? {};
    const preferences = new Set<string>(
      Array.isArray(current.preferences)
        ? current.preferences.filter((item): item is string => typeof item === "string")
        : [],
    );
    for (const fact of facts) {
      if (fact.subject || fact.predicate || fact.object) {
        preferences.add([fact.subject, fact.predicate, fact.object].filter(Boolean).join(" "));
      }
    }
    if (preferences.size === 0) return;

    await db
      .update(persons)
      .set({
        profile: { ...current, preferences: [...preferences].slice(-50) },
        updatedAt: new Date(),
      })
      .where(eq(persons.id, personId));
  }
}

function expiryFor(
  kind: string,
  ttlDays: number,
  eventTime: string | null | undefined,
  now: number,
): Date | null {
  if (kind === "identity") return null;
  if (kind === "event" && eventTime) {
    const parsed = new Date(eventTime);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(parsed.getTime() + 2 * 24 * 3600_000);
    }
  }
  return new Date(now + ttlDays * 24 * 3600_000);
}
