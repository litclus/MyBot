import { QqApi } from "./adapters/qq/api.js";
import { QqAuth } from "./adapters/qq/auth.js";
import { QqGateway } from "./adapters/qq/gateway.js";
import { normalizeC2C, normalizeGroupAt } from "./adapters/qq/normalize.js";
import type { QqC2CEvent, QqGroupAtEvent } from "./adapters/qq/types.js";
import { createModelProvider } from "./adapters/models/index.js";
import { loadPromptTemplate, DEFAULT_SYSTEM_TEMPLATE, DEFAULT_PERSONA_TEMPLATE } from "./agent/prompt.js";
import { Bot } from "./app/bot.js";
import { CleanupJob } from "./app/cleanup.js";
import { startHealthServer } from "./app/health.js";
import { logger } from "./app/logger.js";
import { config } from "./config.js";
import { closeDb, pool } from "./db/client.js";
import { deleteMessageByPlatformId } from "./db/repository.js";
import { MemoryEnricher } from "./memory/enrich.js";
import { MemorySummarizer } from "./memory/summarize.js";
import { backfillEmbeddings } from "./memory/backfill.js";
import { embedText } from "./memory/embedding.js";
import { ensureSeedMemes } from "./memes/seed.js";
import { ensureImageMedia } from "./media/media.js";
import { synthesizeVoice } from "./services/tts.js";
import { ProactiveScheduler } from "./proactive/scheduler.js";
import { startPanelServer } from "./app/panel.js";
import { loadRuntimeSettings } from "./settings/store.js";

const dbPing = async (): Promise<boolean> => {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
};

if (!(await dbPing())) {
  logger.error("Postgres 不可达，检查 docker compose 与 .env");
  process.exit(1);
}

await loadRuntimeSettings().catch((error) =>
  logger.warn("runtime settings load failed", error),
);

const provider = createModelProvider();
const auth = new QqAuth({
  appId: config.QQ_APP_ID,
  appSecret: config.QQ_APP_SECRET,
  baseUrl: config.QQ_API_BASE,
});
const api = new QqApi({ auth, baseUrl: config.QQ_API_BASE });

const systemPromptTemplate = loadPromptTemplate(
  config.SYSTEM_PROMPT_FILE,
  DEFAULT_SYSTEM_TEMPLATE,
);
const personaPromptTemplate = loadPromptTemplate(
  config.PERSONA_PROMPT_FILE,
  DEFAULT_PERSONA_TEMPLATE,
);
const bot = new Bot({
  provider,
  systemPromptTemplate,
  personaPromptTemplate,
  botName: config.BOT_NAME,
  send: async (input) => {
    if (input.conversationKind === "dm") {
      await api.sendC2CText({
        userOpenid: input.conversationExternalId,
        content: input.text,
        msgId: input.replyTo,
        msgSeq: input.msgSeq,
      });
      return;
    }
    await api.sendGroupText({
      groupOpenid: input.conversationExternalId,
      content: input.text,
      msgId: input.replyTo,
      msgSeq: input.msgSeq,
    });
  },
  sendMarkdown: async (input) => {
    if (input.conversationKind === "dm") {
      await api.sendC2CMarkdown({
        userOpenid: input.conversationExternalId,
        content: input.content,
        ...(input.replyTo ? { msgId: input.replyTo } : {}),
        ...(input.msgSeq !== undefined ? { msgSeq: input.msgSeq } : {}),
      });
      return;
    }
    await api.sendGroupMarkdown({
      groupOpenid: input.conversationExternalId,
      content: input.content,
      ...(input.replyTo ? { msgId: input.replyTo } : {}),
      ...(input.msgSeq !== undefined ? { msgSeq: input.msgSeq } : {}),
    });
  },
  resolveImage: (imageId, conversationId, categories) =>
    ensureImageMedia(imageId, conversationId, api, categories),
  fetchGroupMembers: async (groupOpenId, cursor) => {
    const result = await api.getGroupMembers(groupOpenId, cursor);
    return {
      members: result.members.flatMap((member) => {
        const openid = member.member_openid?.trim();
        if (!openid) return [];
        return [
          {
            openid,
            name: member.username?.trim() || "成员",
            ...(member.member_role ? { role: member.member_role } : {}),
            ...(member.bot !== undefined ? { bot: member.bot } : {}),
          },
        ];
      }),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  },
  synthesizeVoice: (text) => synthesizeVoice(text),
  sendVoice: async (input) => {
    if (input.conversationKind === "dm") {
      throw new Error("C2C 暂不支持语音");
    }
    await api.sendGroupVoice({
      groupOpenid: input.conversationExternalId,
      audio: input.audio,
      fileName: `voice-${Date.now()}.wav`,
      msgId: input.replyTo,
      msgSeq: input.msgSeq,
    });
  },
});

const panel = startPanelServer({
  host: config.PANEL_HOST,
  port: config.PANEL_PORT,
  logger,
  onApplied: (changed) => {
    if (changed.length > 0) logger.info("settings applied", changed.join(","));
  },
});

const gateway = new QqGateway({
  auth,
  api,
  intents: config.QQ_INTENTS,
  onReady: (user) => {
    if (user.username) bot.setBotName(user.username);
  },
  onEvent: async (type, data) => {
    const recallEvents = new Set([
      "GROUP_MESSAGE_DELETE",
      "C2C_MESSAGE_DELETE",
      "MESSAGE_DELETE",
      "GROUP_MSG_RECALL",
      "C2C_MSG_RECALL",
      "MESSAGE_RECALL",
    ]);
    if (recallEvents.has(type)) {
      const payload = data as { id?: string; message_id?: string; msg_id?: string };
      const messageId = payload.message_id ?? payload.msg_id ?? payload.id;
      if (messageId) {
        const deleted = await deleteMessageByPlatformId(messageId);
        logger.info("message recalled", messageId, { deleted });
      }
      return;
    }

    const rawContent = (data as { content?: unknown }).content;
    const messageEvent =
      type === "C2C_MESSAGE_CREATE" ||
      type === "GROUP_AT_MESSAGE_CREATE" ||
      type === "GROUP_MESSAGE_CREATE";
    if (messageEvent) {
      const rawText = typeof rawContent === "string" ? rawContent : String(rawContent ?? "");
      logger.info(
        "qq event content",
        type,
        typeof rawContent,
        JSON.stringify(rawContent),
        Buffer.from(rawText).toString("hex").slice(0, 240),
      );
    }

    if (type === "C2C_MESSAGE_CREATE") {
      const inbound = normalizeC2C(data as QqC2CEvent);
      if (!inbound) {
        logger.warn("invalid C2C_MESSAGE_CREATE payload");
        return;
      }
      await bot.handle(inbound);
      return;
    }

    if (type !== "GROUP_AT_MESSAGE_CREATE" && type !== "GROUP_MESSAGE_CREATE") {
      logger.debug("ignored event", type);
      return;
    }
    const inbound = normalizeGroupAt(data as QqGroupAtEvent, {
      forceMention: type === "GROUP_AT_MESSAGE_CREATE",
    });
    if (!inbound) {
      logger.warn("invalid group message payload", type);
      return;
    }
    await bot.handle(inbound);
  },
});

const requiresWs = Boolean(config.QQ_APP_ID && config.QQ_APP_SECRET);
const health = startHealthServer({
  host: config.HEALTH_HOST,
  port: config.HEALTH_PORT,
  dbPing,
  isWsConnected: () => gateway.isConnected(),
  requiresWs,
  logger,
});

if (requiresWs) {
  logger.info("starting QQ gateway", { appId: config.QQ_APP_ID });
  await gateway.start();
} else {
  logger.warn("QQ_APP_ID / QQ_APP_SECRET 未配置，仅启动健康检查与数据库");
}

const proactive = new ProactiveScheduler({
  provider,
  bot,
  isReady: () => gateway.isConnected(),
  logger,
});
if (config.PROACTIVE_ENABLED) {
  proactive.start();
}

const enricher = new MemoryEnricher(provider, logger);
if (config.ENRICH_ENABLED) {
  enricher.start();
  logger.info("memory enricher started");
}

const summarizer = new MemorySummarizer(provider, logger);
if (config.SUMMARY_ENABLED) {
  summarizer.start();
  logger.info("memory summarizer started");
}

void backfillEmbeddings().catch((error) => logger.warn("embedding backfill failed", error));
void ensureSeedMemes().catch((error) => logger.warn("meme seed failed", error));
void embedText("MyBot embedding warmup")
  .then((vector) => {
    if (vector) logger.info("embedding model ready", { dims: vector.length });
  })
  .catch((error) => logger.warn("embedding warmup failed", error));

const cleanup = new CleanupJob(logger);
cleanup.start();

logger.info("MyBot started", {
  model: config.OPENCODE_MODEL,
  name: bot.getBotName(),
  promptFile: config.SYSTEM_PROMPT_FILE,
  personaFile: config.PERSONA_PROMPT_FILE,
  intents: config.QQ_INTENTS,
  healthPort: config.HEALTH_PORT,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", signal);
  enricher.stop();
  summarizer.stop();
  proactive.stop();
  cleanup.stop();
  await gateway.stop().catch(() => undefined);
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await new Promise<void>((resolve) => panel.close(() => resolve()));
  await closeDb().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
