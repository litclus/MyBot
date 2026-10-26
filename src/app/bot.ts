import type { InboundMessage } from "../adapters/qq/types.js";
import { buildReplyGraph } from "../agent/graph.js";
import { commitDeferredActions } from "../agent/commit.js";
import {
  agentTools,
  type AgentTool,
  type FetchGroupMembers,
  type ToolContext,
} from "../agent/tools.js";
import {
  DEFAULT_PERSONA_TEMPLATE,
  DEFAULT_SYSTEM_TEMPLATE,
  renderSystemPrompt,
  stripImageSaveRules,
} from "../agent/prompt.js";
import { config } from "../config.js";
import { insertMessage, getRecentMessagesWithNames, getMentionCandidates } from "../db/repository.js";
import type { ChatMessage, ChatPart } from "../ports/model.js";
import type { MessageContent } from "../db/schema.js";
import { ingestInbound } from "./ingest.js";
import type { Logger } from "./logger.js";
import { logger as defaultLogger } from "./logger.js";
import { sanitizeReply } from "../chat/sanitize.js";
import { parseReplyMessages, type ReplyMessage } from "../chat/reply-format.js";
import { toHistoryMessage, trimHistory } from "../chat/history.js";
import { gapMsFor } from "../chat/pacing.js";
import { shouldCancelPrevious } from "../chat/queue.js";
import { fetchInboundImagesWithIndex } from "../media/inbound.js";
import { rememberHistoryImages } from "../media/history-cache.js";
import type { ImageMedia } from "../media/media.js";
import { markImagesUsed } from "../media/store.js";
import { markdownImageSize } from "../media/display.js";
import { resolveMentions } from "../chat/mentions.js";
import { buildQuotedMeta, quotedViewId } from "../chat/quoted.js";
import { unwrapQqText } from "../adapters/qq/normalize.js";

export type SendReplyInput = {
  conversationExternalId: string;
  conversationKind: "group" | "dm";
  text: string;
  replyTo: string;
  msgSeq: number;
};

export type SendReply = (input: SendReplyInput) => Promise<void>;

export type SendMarkdownInput = {
  conversationExternalId: string;
  conversationKind: "group" | "dm";
  content: string;
  /** 被动回复必填；主动消息不传 */
  replyTo?: string;
  msgSeq?: number;
};

export type VoiceAudio = {
  data: Buffer;
  mime: string;
};

export type SendVoiceInput = {
  conversationExternalId: string;
  conversationKind: "group" | "dm";
  audio: Buffer;
  mime: string;
  replyTo: string;
  msgSeq: number;
};

export type SendVoice = (input: SendVoiceInput) => Promise<void>;
export type SynthesizeVoice = (text: string) => Promise<VoiceAudio>;

export type BotDeps = {
  provider: import("../ports/model.js").ModelProvider;
  send: SendReply;
  /** 发送 Markdown 消息，所有回复优先走这里 */
  sendMarkdown?: (input: SendMarkdownInput) => Promise<void>;
  /** 把 image id 换成 qqbot-media:// 引用；categories 限定 image/sticker/meme */
  resolveImage?: (
    imageId: number,
    conversationId: string,
    categories?: readonly string[],
  ) => Promise<ImageMedia | null>;
  /** 调 TTS，把 voiceText 合成为音频 */
  synthesizeVoice?: SynthesizeVoice;
  /** 发送语音消息；不支持语音时抛错，由 Bot 退回纯文本 */
  sendVoice?: SendVoice;
  /** 系统提示词模板；启动时由 index 从文件加载 */
  systemPromptTemplate?: string;
  /** 人设提示词模板；启动时由 index 从文件加载 */
  personaPromptTemplate?: string;
  /** 初始名字；QQ READY 后会覆盖 */
  botName?: string;
  /** 调 QQ API 拉当前群成员，供 group_members 工具使用 */
  fetchGroupMembers?: FetchGroupMembers;
  logger?: Logger;
};

const PASSIVE_WINDOW_MS = 4.5 * 60 * 1000;
const VOICE_FALLBACK_TEXT = "语音没发出来，稍后再试";

const TOOLS_WITHOUT_IMAGE_SAVE = Object.fromEntries(
  Object.entries(agentTools).filter(([name]) => name !== "image_save"),
) as Record<string, AgentTool>;

type ActiveTask = {
  state: "thinking" | "sending";
  controller: AbortController;
  cancelled: boolean;
  lastMessageAt: number;
  run?: Promise<void>;
};

export class Bot {
  private readonly seen = new Map<string, number>();
  private readonly inFlight = new Map<string, ActiveTask>();
  private readonly sendLocks = new Map<string, Promise<void>>();
  private readonly log: Logger;
  private readonly promptTemplate: string;
  private readonly personaTemplate: string;
  private botName: string;
  private systemPrompt: string;
  private personaPrompt: string;
  /** 唤醒词同时当昵称，注入人设；与名字重复的去掉 */
  private nicknames: string[] = [];

  constructor(private readonly deps: BotDeps) {
    this.log = deps.logger ?? defaultLogger;
    this.promptTemplate = deps.systemPromptTemplate ?? DEFAULT_SYSTEM_TEMPLATE;
    this.personaTemplate = deps.personaPromptTemplate ?? DEFAULT_PERSONA_TEMPLATE;
    this.botName = deps.botName ?? config.BOT_NAME;
    this.systemPrompt = renderSystemPrompt(this.promptTemplate, { name: this.botName });
    this.personaPrompt = this.renderPersona();
  }

  getBotName(): string {
    return this.botName;
  }

  getPrompts(): { systemPrompt: string; personaPrompt: string } {
    return {
      systemPrompt: config.IMAGE_SAVE
        ? this.systemPrompt
        : stripImageSaveRules(this.systemPrompt),
      personaPrompt: this.personaPrompt,
    };
  }

  /** 主动消息：不带 msg_id，按分片发送并模拟输入间隔 */
  async sendProactive(input: {
    conversationId: string;
    conversationExternalId: string;
    conversationKind: "group" | "dm";
    messages: ReplyMessage[];
  }): Promise<void> {
    if (!this.deps.sendMarkdown) throw new Error("sendMarkdown 未配置，无法发主动消息");
    const shards = input.messages
      .map((message) => ({
        ...message,
        plainText: sanitizeReply(message.plainText || message.voiceText),
      }))
      .filter((message) => Boolean(message.plainText))
      .slice(0, 3);
    if (shards.length === 0) throw new Error("主动消息内容为空");

    await this.withSendLock(input.conversationExternalId, async () => {
      for (const [index, shard] of shards.entries()) {
        if (index > 0) {
          const gapMs = gapMsFor(shard, shards[index - 1]?.plainText ?? "");
          this.log.debug("proactive shard gap", index, gapMs);
          await sleep(gapMs);
        }
        await this.sendMarkdownWithRetry({
          conversationExternalId: input.conversationExternalId,
          conversationKind: input.conversationKind,
          content: shard.plainText,
        });
        await insertMessage({
          conversationId: input.conversationId,
          role: "assistant",
          content: { parts: [{ type: "text", text: shard.plainText }] },
          metadata: { speaker: { id: "assistant", name: "助手" } },
        });
      }
    });
    this.log.info("proactive replied", input.conversationExternalId, shards.length);
  }

  private async sendMarkdownWithRetry(input: SendMarkdownInput): Promise<void> {
    if (!this.deps.sendMarkdown) throw new Error("sendMarkdown 未配置");
    let lastError: unknown;
    for (let attempt = 0; attempt <= config.SEND_MAX_RETRIES; attempt += 1) {
      try {
        await this.deps.sendMarkdown(input);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < config.SEND_MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  private async sendTextWithRetry(input: SendReplyInput): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= config.SEND_MAX_RETRIES; attempt += 1) {
      try {
        await this.deps.send(input);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < config.SEND_MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  private async sendVoiceWithRetry(input: SendVoiceInput): Promise<void> {
    if (!this.deps.sendVoice) throw new Error("sendVoice 未配置");
    let lastError: unknown;
    for (let attempt = 0; attempt <= config.SEND_MAX_RETRIES; attempt += 1) {
      try {
        await this.deps.sendVoice(input);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < config.SEND_MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  private async withSendLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sendLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.sendLocks.set(key, chain);
    try {
      return await run;
    } finally {
      if (this.sendLocks.get(key) === chain) this.sendLocks.delete(key);
    }
  }

  /** QQ READY 里拿到真实昵称后调用；之后的回复使用新名字。 */
  setBotName(name: string): void {
    const next = name.trim();
    if (!next || next === this.botName) return;
    this.botName = next;
    this.systemPrompt = renderSystemPrompt(this.promptTemplate, { name: next });
    this.personaPrompt = this.renderPersona();
    this.log.info("bot name updated", next);
  }

  /** 人设要注入名字和昵称，昵称就是唤醒词，顺序即配置顺序。 */
  private renderPersona(): string {
    this.nicknames = config.WAKE_WORDS.map((word) => word.trim()).filter(Boolean);
    return renderSystemPrompt(this.personaTemplate, {
      name: this.botName,
      nicknames: this.nicknames,
    });
  }

  async handle(inbound: InboundMessage): Promise<void> {
    // 入库前再兜底一次，防止 QQ 的 {"text":""} 包装漏进数据库和模型上下文
    inbound.text = unwrapQqText(inbound.text).trim();

    if (this.seen.has(inbound.messageId)) {
      this.log.debug("duplicate message skipped", inbound.messageId);
      return;
    }
    this.seen.set(inbound.messageId, Date.now());
    this.cleanupSeen();

    const ingested = await ingestInbound(inbound);
    const { person, conversation } = ingested;

    const taskKey = `${conversation.id}:${person.personKey}`;
    const existing = this.inFlight.get(taskKey);
    if (existing) {
      const gap = inbound.receivedAt.getTime() - existing.lastMessageAt;
      const cancel = shouldCancelPrevious({
        state: existing.state,
        conversationKind: conversation.kind === "dm" ? "dm" : "group",
        isMention: inbound.isMention,
        gapMs: gap,
        cancelWindowMs: config.SAME_USER_CANCEL_WINDOW_MS,
      });
      if (cancel) {
        existing.cancelled = true;
        existing.controller.abort();
        this.log.info("same user superseded", inbound.messageId, gap, inbound.isMention);
      } else {
        await existing.run?.catch(() => undefined);
      }
    }

    const task: ActiveTask = {
      state: "thinking",
      controller: new AbortController(),
      cancelled: false,
      lastMessageAt: inbound.receivedAt.getTime(),
    };
    const run = this.process(inbound, ingested, task).finally(() => {
      if (this.inFlight.get(taskKey) === task) this.inFlight.delete(taskKey);
    });
    task.run = run;
    this.inFlight.set(taskKey, task);
    await run;
  }

  private async process(
    inbound: InboundMessage,
    ingested: Awaited<ReturnType<typeof ingestInbound>>,
    task: ActiveTask,
  ): Promise<void> {
    const { person, conversation, message } = ingested;
    const ownerKey = config.OWNER_PERSON_KEY.trim();
    const isOwner =
      Boolean(ownerKey) &&
      (person.personKey === ownerKey || inbound.sender.externalId === ownerKey);

    const age = Date.now() - inbound.receivedAt.getTime();
    if (age > PASSIVE_WINDOW_MS) {
      this.log.warn("message outside passive window, reply skipped", inbound.messageId, age);
      return;
    }
    if (task.cancelled) return;

    try {
      const recent = await getRecentMessagesWithNames(conversation.id, 200);
      const mentionCandidates = await getMentionCandidates(conversation.id, 10);
      const history = trimHistory(recent.filter((row) => row.id !== message.id))
        .map(toHistoryMessage)
        .filter((item): item is ChatMessage => item !== null);
      const historyCount = history.length;

      const viewableImages = inbound.attachments.filter((attachment) =>
        attachment.contentType.startsWith("image/"),
      );
      const viewableIndex = new Map(
        viewableImages.map((attachment, index) => [attachment, index + 1]),
      );
      const currentAttachments = inbound.attachments.map((attachment) => {
        const isImage = attachment.contentType.startsWith("image/");
        const index = viewableIndex.get(attachment);
        return {
          type: isImage ? "image" : "file",
          mime: attachment.contentType,
          ...(index !== undefined ? { index } : {}),
          ...(attachment.filename ? { name: attachment.filename } : {}),
          ...(attachment.size !== undefined ? { size: attachment.size } : {}),
        };
      });
      const currentImageAttachments = viewableImages.map((attachment) => ({
        url: attachment.url,
        mime: attachment.contentType,
        ...(attachment.filename ? { name: attachment.filename } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
        ...(attachment.width !== undefined ? { width: attachment.width } : {}),
        ...(attachment.height !== undefined ? { height: attachment.height } : {}),
      }));
      const quotedImageSources = (inbound.quoted?.attachments ?? []).filter((attachment) =>
        attachment.contentType.startsWith("image/"),
      );
      const currentBodyParts = (
        inbound.parts ?? (inbound.text ? [{ type: "text" as const, text: inbound.text }] : [])
      )
        .filter((part) => part.type !== "text" || part.text.trim())
        .map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text.trim() }
            : { type: part.type, description: part.description },
        );
      const currentPayload = {
        time: inbound.receivedAt.toISOString(),
        id: inbound.messageId,
        role: "user",
        speaker: {
          id: person.personKey,
          name: person.displayName,
        },
        ...(currentBodyParts.length > 0 ? { parts: currentBodyParts } : {}),
        ...(currentAttachments.length > 0 ? { attachments: currentAttachments } : {}),
      };
      const info = {
        now: new Date().toISOString(),
        speaker: {
          id: person.personKey,
          name: person.displayName,
          ...(isOwner ? { isOwner: true } : {}),
        },
        members: mentionCandidates.map((candidate) => ({
          token: candidate.token,
          name: candidate.name,
          role: candidate.role,
        })),
        current: {
          id: inbound.messageId,
          parts: currentBodyParts,
          mentioned: inbound.isMention,
          quoted: buildQuotedMeta(inbound.quoted, inbound.messageId) ?? null,
        },
      };

      const actionExpiresAt = Date.now() + config.DEFERRED_ACTION_TTL_SECONDS * 1000;
      const toolContext: ToolContext = {
        conversationId: conversation.id,
        personId: person.id,
        messageId: inbound.messageId,
        images: currentImageAttachments,
        quotedImages: quotedImageSources.map((attachment) => ({
          url: attachment.url,
          mime: attachment.contentType,
          ...(attachment.filename ? { name: attachment.filename } : {}),
          ...(attachment.size !== undefined ? { size: attachment.size } : {}),
          ...(attachment.width !== undefined ? { width: attachment.width } : {}),
          ...(attachment.height !== undefined ? { height: attachment.height } : {}),
        })),
        actionExpiresAt,
        conversationExternalId: conversation.externalId,
        conversationKind: conversation.kind === "dm" ? "dm" : "group",
        mentionCandidates,
        ...(this.deps.fetchGroupMembers
          ? { fetchGroupMembers: this.deps.fetchGroupMembers }
          : {}),
      };
      const graph = buildReplyGraph(this.deps.provider, {
        signal: task.controller.signal,
        sessionKey: `qq:${conversation.kind}:${conversation.externalId}:member:${person.personKey}`,
        context: toolContext,
        systemPrompt: config.IMAGE_SAVE
          ? this.systemPrompt
          : stripImageSaveRules(this.systemPrompt),
        personaPrompt: this.personaPrompt,
        logger: this.log,
        ...(config.IMAGE_SAVE ? {} : { tools: TOOLS_WITHOUT_IMAGE_SAVE }),
      });

      const currentImageEntries = await fetchInboundImagesWithIndex(
        viewableImages,
        viewableImages.length,
      );
      const currentImages = currentImageEntries.map((item) => item.part);
      const quotedImageEntries = await fetchInboundImagesWithIndex(
        quotedImageSources,
        quotedImageSources.length,
      );
      const quotedImages = quotedImageEntries.map((item) => item.part);
      rememberHistoryImages(inbound.messageId, currentImageEntries);
      rememberHistoryImages(quotedViewId(inbound.messageId), quotedImageEntries);
      const currentParts: ChatPart[] = [
        { type: "text", text: JSON.stringify(currentPayload) },
        ...currentImages,
        ...(quotedImages.length > 0
          ? [{ type: "text" as const, text: "引用的消息里的图片：" }, ...quotedImages]
          : []),
      ];

      const result = await graph.invoke({
        messages: [
          ...history,
          { role: "user", parts: currentParts },
          {
            role: "system",
            parts: [{ type: "text", text: JSON.stringify(info) }],
          },
        ],
      });

      if (task.cancelled) {
        this.log.info("cancelled reply discarded", inbound.messageId);
        return;
      }

      const pendingActions = result.actions ?? [];
      // 记忆写入和回复解耦：graph 结束就异步提交，不依赖回复是否发出
      const memoryActions = pendingActions.filter((action) => action.kind === "memory_save");
      const replyActions = pendingActions.filter((action) => action.kind !== "memory_save");
      if (memoryActions.length > 0) {
        void commitDeferredActions(memoryActions)
          .then((settled) => this.log.info("memory settled", inbound.messageId, settled))
          .catch((error) => this.log.warn("memory commit failed", inbound.messageId, error));
      }

      // 只持久化本轮新增的消息，历史工具消息不要重复写库
      const newMessages = result.messages.slice(historyCount);
      await this.persistToolMessages(newMessages, conversation.id, inbound.messageId);

      for (const item of newMessages) {
        if (item.role === "tool") {
          this.log.debug("tool result", item.content.slice(0, 200));
        }
      }

      const messages = parseReplyMessages(result.reply.trim());
      if (messages.length === 0) {
        if (replyActions.length > 0) {
          this.log.info("deferred actions discarded", inbound.messageId, replyActions.length);
        }
        this.log.info("agent chose not to reply", inbound.messageId);
        return;
      }

      const actions = replyActions;

      task.state = "sending";
      let sent = 0;
      let deferredSettled: Promise<void> | undefined;
      await this.withSendLock(conversation.externalId, async () => {
        await sleep(400 + Math.floor(Math.random() * 600));

      let msgSeq = 1;
      let mediaBudget = 4;

      const afterSent = (): void => {
        msgSeq += 1;
        sent += 1;

        // 第一片真的发出去之后才提交写操作；异步跑，不挡后面的分片，收尾时再等它
        if (sent === 1 && actions.length > 0) {
          deferredSettled = commitDeferredActions(actions)
            .then((deferred) => {
              if (
                deferred.committed > 0 ||
                deferred.discarded > 0 ||
                deferred.skipped > 0 ||
                deferred.failed > 0
              ) {
                this.log.info("deferred actions settled", inbound.messageId, deferred);
              }
            })
            .catch((error) => this.log.warn("deferred actions failed", inbound.messageId, error));
        }
      };

      for (const [index, message] of messages.entries()) {
        if (index > 0) {
          const gapMs = gapMsFor(message, messages[index - 1]?.plainText ?? "");
          this.log.debug("reply shard gap", index, gapMs);
          await sleep(gapMs);
        }

        const mentionKind = conversation.kind === "dm" ? "dm" : "group";
        const voiceText = resolveMentions(message.voiceText, [], mentionKind).content;
        const canVoice =
          config.VOICE_ENABLED &&
          Boolean(voiceText) &&
          Boolean(this.deps.synthesizeVoice) &&
          Boolean(this.deps.sendVoice);

        if (canVoice) {
          try {
            if (message.images.length > 0 || message.stickers.length > 0) {
              this.log.debug("voice shard media ignored", inbound.messageId, index);
            }
            const voice = await this.deps.synthesizeVoice!(voiceText);
            await this.sendVoiceWithRetry({
              conversationExternalId: conversation.externalId,
              conversationKind: conversation.kind as "group" | "dm",
              audio: voice.data,
              mime: voice.mime,
              replyTo: inbound.messageId,
              msgSeq,
            });
            afterSent();
            await insertMessage({
              conversationId: conversation.id,
              role: "assistant",
              content: {
                parts: [
                  {
                    type: "text",
                    text: message.plainText || sanitizeReply(voiceText),
                  },
                ],
              },
              metadata: {
                speaker: { id: "assistant", name: "助手" },
                voice: true,
                voiceText,
              },
              replyTo: inbound.messageId,
            });
            continue;
          } catch (error) {
            this.log.warn("voice send failed, fallback to text", inbound.messageId, error);
          }

          // 语音失败只发纯文本兜底，不带图片和表情包
          const fallbackText = message.plainText || VOICE_FALLBACK_TEXT;
          const fallbackResolved = resolveMentions(
            fallbackText,
            mentionCandidates,
            mentionKind,
          );
          const fallbackContent = fallbackResolved.content;
          if (!fallbackContent) continue;

          if (this.deps.sendMarkdown) {
            await this.sendMarkdownWithRetry({
              conversationExternalId: conversation.externalId,
              conversationKind: conversation.kind as "group" | "dm",
              content: fallbackContent,
              replyTo: inbound.messageId,
              msgSeq,
            });
          } else {
            await this.sendTextWithRetry({
              conversationExternalId: conversation.externalId,
              conversationKind: conversation.kind as "group" | "dm",
              text: fallbackContent,
              replyTo: inbound.messageId,
              msgSeq,
            });
          }
          afterSent();
          await insertMessage({
            conversationId: conversation.id,
            role: "assistant",
            content: {
              parts: [{ type: "text", text: fallbackResolved.display || fallbackText }],
            },
            metadata: {
              speaker: { id: "assistant", name: "助手" },
              voice: false,
              voiceFallback: true,
            },
            replyTo: inbound.messageId,
          });
          continue;
        }

        const textSource =
          message.plainText || (voiceText ? sanitizeReply(voiceText) : "");
        const resolved = resolveMentions(textSource, mentionCandidates, mentionKind);

        const media: ImageMedia[] = [];
        const sentImageIds: number[] = [];
        if (this.deps.resolveImage && mediaBudget > 0) {
          const imageIds = message.images.slice(0, mediaBudget);
          for (const imageId of imageIds) {
            try {
              const item = await this.deps.resolveImage(imageId, conversation.id, ["image"]);
              if (item) {
                media.push(item);
                sentImageIds.push(imageId);
              } else this.log.warn("image not found", imageId);
            } catch (error) {
              this.log.warn("image resolve failed", imageId, error);
            }
          }

          const stickerIds = message.stickers.slice(0, Math.max(0, mediaBudget - media.length));
          for (const imageId of stickerIds) {
            try {
              const item = await this.deps.resolveImage(imageId, conversation.id, [
                "sticker",
                "meme",
              ]);
              if (item) {
                media.push(item);
                sentImageIds.push(imageId);
              } else this.log.warn("sticker not found", imageId);
            } catch (error) {
              this.log.warn("sticker resolve failed", imageId, error);
            }
          }
          mediaBudget = Math.max(0, mediaBudget - media.length);
        }

        const imageLines = media.map(
          (item) =>
            `![图片${markdownImageSize(
              item.width,
              item.height,
              config.IMAGE_DISPLAY_MAX_WIDTH,
              config.IMAGE_DISPLAY_MAX_HEIGHT,
            )}](${item.url})`,
        );

        const content = [resolved.content, ...imageLines].filter(Boolean).join("\n");
        if (!content) continue;

        if (this.deps.sendMarkdown) {
          await this.sendMarkdownWithRetry({
            conversationExternalId: conversation.externalId,
            conversationKind: conversation.kind as "group" | "dm",
            content,
            replyTo: inbound.messageId,
            msgSeq,
          });
        } else {
          await this.sendTextWithRetry({
            conversationExternalId: conversation.externalId,
            conversationKind: conversation.kind as "group" | "dm",
            text: content,
            replyTo: inbound.messageId,
            msgSeq,
          });
        }
        afterSent();

        if (sentImageIds.length > 0) {
          await markImagesUsed(sentImageIds).catch((error) =>
            this.log.warn("image use count failed", inbound.messageId, error),
          );
        }

        const assistantParts: MessageContent["parts"] = [];
        if (resolved.display) {
          assistantParts.push({ type: "text", text: resolved.display });
        }
        for (const [index, item] of media.entries()) {
          const imageId = sentImageIds[index];
          assistantParts.push({
            type: "image",
            ...(imageId !== undefined ? { assetId: String(imageId) } : {}),
            mime: item.mime,
          });
        }
        if (assistantParts.length === 0) {
          assistantParts.push({ type: "text", text: content });
        }

        await insertMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: { parts: assistantParts },
          metadata: { speaker: { id: "assistant", name: "助手" } },
          replyTo: inbound.messageId,
        });
      }
      });

      await deferredSettled;

      this.log.info("replied", inbound.messageId, sent);
    } catch (error) {
      if (task.cancelled || task.controller.signal.aborted) {
        this.log.info("cancelled reply stopped", inbound.messageId);
        return;
      }
      this.log.error("reply failed", inbound.messageId, error);
      if (Date.now() - inbound.receivedAt.getTime() < PASSIVE_WINDOW_MS) {
        const fallback = {
          conversationExternalId: conversation.externalId,
          conversationKind: conversation.kind as "group" | "dm",
          replyTo: inbound.messageId,
          msgSeq: 1,
        };
        const text = "抱歉，我这边出了点问题，稍后再试";
        await (this.deps.sendMarkdown
          ? this.sendMarkdownWithRetry({ ...fallback, content: text })
          : this.sendTextWithRetry({ ...fallback, text })
        ).catch((sendError) => this.log.error("fallback send failed", sendError));
      }
    }
  }

  private async persistToolMessages(
    messages: ChatMessage[],
    conversationId: string,
    replyTo: string,
  ): Promise<void> {
    for (const message of messages) {
      if (message.role === "assistant" && message.toolCalls?.length) {
        const text = message.parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        await insertMessage({
          conversationId,
          role: "assistant",
          content: { parts: text ? [{ type: "text", text }] : [] },
          metadata: {
            speaker: { id: "assistant", name: "助手" },
            toolCalls: message.toolCalls,
          },
          replyTo,
        });
      } else if (message.role === "tool") {
        await insertMessage({
          conversationId,
          role: "tool",
          content: { parts: [{ type: "text", text: message.content }] },
          metadata: { toolCallId: message.toolCallId },
          replyTo,
        });
      }
    }
  }

  private cleanupSeen(): void {
    if (this.seen.size < 1000) return;
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, at] of this.seen) {
      if (at < cutoff) this.seen.delete(key);
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
