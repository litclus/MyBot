import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export const EnvSchema = z.object({
  OPENCODE_BASE_URL: z
    .string()
    .url()
    .default("https://opencode.ai/inference/go/openai/v1"),
  OPENCODE_API_KEY: z.string().default(""),
  OPENCODE_MODEL: z.string().default("deepseek-v4.1-flash"),
  MYBOT_USER_AGENT: z.string().default("mybot/0.1"),

  /** 语音合成：MiMo TTS，密钥走控制面板 */
  VOICE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  MIMO_API_KEY: z.string().default(""),
  MIMO_TTS_BASE_URL: z.string().url().default("https://api.xiaomimimo.com/v1"),
  MIMO_TTS_MODEL: z.string().default("mimo-v2.5-tts-voicedesign"),
  MIMO_TTS_VOICE: z.string().default("mimo_default"),
  /** 固定发音风格，保证每次音色和语气一致 */
  MIMO_TTS_STYLE: z
    .string()
    .default("一位十二三岁胖嘟嘟的小萝莉，奶声奶气，声音圆润软糯、轻、偏高，带一点稚气的鼻音和湿润的口水音，吐字软一点，像小孩子在撒娇"),

  /** 折算价：每百万 token 多少元（大白饭的抽象口径） */
  RMB_PER_MILLION_TOKENS: z.coerce.number().positive().default(0.1),
  /** Go 套餐的月度额度（美元）：按模型不同，默认按常见的 60 */
  GO_MONTHLY_LIMIT_USD: z.coerce.number().positive().default(60),
  /** 汇率接口，Frankfurter v2 */
  FX_API_URL: z.string().url().default("https://api.frankfurter.dev/v2/rates"),
  /** 汇率缓存时长（分钟）；欧洲央行一天只更新一次，6 小时足够 */
  FX_CACHE_TTL_MINUTES: z.coerce.number().positive().default(360),
  /** 套餐用量接口，用同一个 API key 调 */
  GO_USAGE_URL: z.string().url().default("https://opencode.ai/zen/go/v1/usage"),

  /** DeepSeek 官方 API：只用来做网页搜索和查搜索额度 */
  DEEPSEEK_API_KEY: z.string().default(""),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  /** 单次搜索默认返回几条，1-10 */
  DEEPSEEK_SEARCH_COUNT: z.coerce.number().int().min(1).max(10).default(5),
  /** 搜索单价：每 1000 次成功请求多少元 */
  SEARCH_PRICE_RMB_PER_1K: z.coerce.number().positive().default(5),
  POSTGRES_USER: z.string().default("mybot"),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().default("mybot"),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  POSTGRES_HOST: z.string().default("127.0.0.1"),

  /** 机器人名字；QQ READY 事件会用它实际的名字覆盖 */
  BOT_NAME: z.string().default("MyBot"),
  /** 主人 person_key；留空不启用，填了之后 agent 对这个用户更客气 */
  OWNER_PERSON_KEY: z.string().trim().default(""),
  SYSTEM_PROMPT_FILE: z.string().default("prompts/system.md"),
  PERSONA_PROMPT_FILE: z.string().default("prompts/persona.md"),

  WAKE_WORDS: z
    .string()
    .default("大肥鱼,肥鱼,吃白饭的,吃大白饭的,哦鲸鲸,鲸鲸,鲸鱼,ds,deepseek")
    .transform((value) =>
      value
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean),
    ),

  QQ_APP_ID: z.string().default(""),
  QQ_APP_SECRET: z.string().default(""),
  QQ_INTENTS: z.coerce.number().int().nonnegative().default(33554432),
  QQ_API_BASE: z.string().url().default("https://api.bot.qq.com"),

  HEALTH_HOST: z.string().default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PANEL_HOST: z.string().default("127.0.0.1"),
  PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  PANEL_USER: z.string().min(1).default("litclus"),
  PANEL_PASSWORD: z.string().min(1).default("litclus"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** 延迟写操作的过期时间 */
  DEFERRED_ACTION_TTL_SECONDS: z.coerce.number().positive().default(300),
  /** 单条消息发送失败后的重试次数 */
  SEND_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  /** 同一用户连续发消息的取消窗口 */
  SAME_USER_CANCEL_WINDOW_MS: z.coerce.number().int().positive().default(3_000),
  /** 历史上下文 token 预算，只算 user / assistant 最终消息 */
  HISTORY_MAX_TOKENS: z.coerce.number().int().min(1_000).max(200_000).default(8_000),
  /** 至少保留多少条历史消息，避免预算过小时上下文太短 */
  HISTORY_MIN_MESSAGES: z.coerce.number().int().min(1).max(100).default(20),
  IMAGE_SAVE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  IMAGE_COMPRESS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  IMAGE_MAX_DIMENSION: z.coerce.number().int().min(64).max(4096).default(512),
  IMAGE_MAX_BYTES: z.coerce.number().int().min(10_000).max(20_000_000).default(1_500_000),
  IMAGE_DISPLAY_MAX_WIDTH: z.coerce.number().int().min(16).max(4096).default(200),
  IMAGE_DISPLAY_MAX_HEIGHT: z.coerce.number().int().min(16).max(4096).default(200),

  /** 每天随机抽一次时间做主动回复判断 */
  PROACTIVE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /** 最后一条消息超过这个时间就不补回复 */
  PROACTIVE_MAX_AGE_MINUTES: z.coerce.number().positive().default(5),
  /** 机器人离线错过随机时间超过这个宽限，就当天不补 */
  PROACTIVE_MISS_GRACE_MINUTES: z.coerce.number().positive().default(10),

  ENRICH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  ENRICH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
  ENRICH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(8),

  SUMMARY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  SUMMARY_MIN_MESSAGES: z.coerce.number().int().min(1).max(1000).default(20),
});

export const config = EnvSchema.parse(process.env);

export const databaseUrl =
  `postgres://${encodeURIComponent(config.POSTGRES_USER)}:` +
  `${encodeURIComponent(config.POSTGRES_PASSWORD)}@${config.POSTGRES_HOST}:` +
  `${config.POSTGRES_PORT}/${encodeURIComponent(config.POSTGRES_DB)}`;
