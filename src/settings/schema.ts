import type { ZodType } from "zod";
import { config, EnvSchema } from "../config.js";

/** 启动时由 .env 得到的值；删除面板覆盖项时恢复到这一份 */
const INITIAL_CONFIG = { ...config } as Record<string, unknown>;

export type SettingKind = "string" | "number" | "boolean" | "string[]";

export type SettingDef = {
  key: keyof typeof config;
  label: string;
  group: string;
  kind: SettingKind;
  restart?: boolean;
  secret?: boolean;
  hint?: string;
  options?: string[];
};

export const SETTING_DEFS: SettingDef[] = [
  { key: "BOT_NAME", label: "机器人名字", group: "基础", kind: "string", restart: true },
  { key: "OWNER_PERSON_KEY", label: "主人 person_key", group: "基础", kind: "string", hint: "填这个人的 person_key；对话里会对他更客气，留空不启用" },
  { key: "SYSTEM_PROMPT_FILE", label: "系统提示词文件", group: "基础", kind: "string", restart: true },
  { key: "PERSONA_PROMPT_FILE", label: "人设提示词文件", group: "基础", kind: "string", restart: true },
  { key: "WAKE_WORDS", label: "昵称 / 唤醒词", group: "基础", kind: "string[]", restart: true, hint: "回车添加 点 × 删除" },

  { key: "QQ_APP_ID", label: "QQ AppID", group: "QQ", kind: "string", restart: true },
  { key: "QQ_APP_SECRET", label: "QQ AppSecret", group: "QQ", kind: "string", restart: true, secret: true },
  { key: "QQ_INTENTS", label: "QQ Intents", group: "QQ", kind: "number", restart: true },
  { key: "QQ_API_BASE", label: "QQ API 地址", group: "QQ", kind: "string", restart: true },

  { key: "OPENCODE_MODEL", label: "模型", group: "模型", kind: "string", restart: true },
  { key: "OPENCODE_BASE_URL", label: "模型接口", group: "模型", kind: "string", restart: true },
  { key: "OPENCODE_API_KEY", label: "模型 API Key", group: "模型", kind: "string", restart: true, secret: true },
  { key: "MYBOT_USER_AGENT", label: "User-Agent", group: "模型", kind: "string", restart: true },

  { key: "VOICE_ENABLED", label: "启用语音", group: "语音", kind: "boolean" },
  { key: "MIMO_API_KEY", label: "语音 API Key", group: "语音", kind: "string", secret: true },
  { key: "MIMO_TTS_BASE_URL", label: "语音接口", group: "语音", kind: "string" },
  { key: "MIMO_TTS_MODEL", label: "语音模型", group: "语音", kind: "string", hint: "mimo-v2.5-tts-voicedesign 用音色描述；mimo-v2.5-tts 用预置音色" },
  { key: "MIMO_TTS_VOICE", label: "预置音色", group: "语音", kind: "string", hint: "冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean / mimo_default" },
  { key: "MIMO_TTS_STYLE", label: "音色描述 / 发音风格", group: "语音", kind: "string", hint: "voicedesign 模型用它设计固定音色；预置音色模型用它控制语气" },

  { key: "DEFERRED_ACTION_TTL_SECONDS", label: "写操作过期时间（秒）", group: "回复", kind: "number" },
  { key: "SEND_MAX_RETRIES", label: "发送重试次数", group: "回复", kind: "number" },
  { key: "SAME_USER_CANCEL_WINDOW_MS", label: "同用户取消窗口（毫秒）", group: "回复", kind: "number" },
  { key: "HISTORY_MAX_TOKENS", label: "历史 token 预算", group: "回复", kind: "number", hint: "只算 user / assistant 最终消息，超出从最早开始丢" },
  { key: "HISTORY_MIN_MESSAGES", label: "历史最少消息数", group: "回复", kind: "number", hint: "预算不够时也至少保留这么多条" },

  { key: "IMAGE_SAVE", label: "允许保存图片", group: "图片", kind: "boolean" },
  { key: "IMAGE_COMPRESS", label: "压缩图片", group: "图片", kind: "boolean" },
  { key: "IMAGE_MAX_DIMENSION", label: "最长边", group: "图片", kind: "number" },
  { key: "IMAGE_MAX_BYTES", label: "最大字节", group: "图片", kind: "number" },
  { key: "IMAGE_DISPLAY_MAX_WIDTH", label: "Markdown 宽度", group: "图片", kind: "number" },
  { key: "IMAGE_DISPLAY_MAX_HEIGHT", label: "Markdown 高度", group: "图片", kind: "number" },

  { key: "PROACTIVE_ENABLED", label: "启用主动消息", group: "主动消息", kind: "boolean", restart: true },
  { key: "PROACTIVE_MAX_AGE_MINUTES", label: "最后消息最大年龄（分钟）", group: "主动消息", kind: "number" },
  { key: "PROACTIVE_MISS_GRACE_MINUTES", label: "错过宽限（分钟）", group: "主动消息", kind: "number" },

  { key: "ENRICH_ENABLED", label: "启用记忆加工", group: "记忆", kind: "boolean", restart: true },
  { key: "ENRICH_INTERVAL_MS", label: "加工间隔（毫秒）", group: "记忆", kind: "number", restart: true },
  { key: "ENRICH_BATCH_SIZE", label: "每批条数", group: "记忆", kind: "number" },
  { key: "SUMMARY_ENABLED", label: "启用群摘要", group: "记忆", kind: "boolean", restart: true },
  { key: "SUMMARY_MIN_MESSAGES", label: "摘要最少消息数", group: "记忆", kind: "number" },

  { key: "DEEPSEEK_API_KEY", label: "搜索 API Key", group: "搜索", kind: "string", secret: true },
  { key: "DEEPSEEK_BASE_URL", label: "搜索接口", group: "搜索", kind: "string" },
  { key: "DEEPSEEK_SEARCH_COUNT", label: "搜索返回条数", group: "搜索", kind: "number" },
  { key: "SEARCH_PRICE_RMB_PER_1K", label: "搜索单价 / 千次", group: "搜索", kind: "number" },
  { key: "FX_CACHE_TTL_MINUTES", label: "汇率缓存（分钟）", group: "服务", kind: "number" },

  { key: "HEALTH_PORT", label: "健康检查端口", group: "服务", kind: "number", restart: true },
  { key: "LOG_LEVEL", label: "日志级别", group: "服务", kind: "string", options: ["debug", "info", "warn", "error"] },
];

export function coerceSetting(def: SettingDef, raw: unknown): unknown {
  if (def.kind === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`${def.label} 需要 true/false`);
  }
  if (def.kind === "number") {
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${def.label} 需要数字`);
    return value;
  }
  if (def.kind === "string[]") {
    const values = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? raw.split(",")
        : null;
    if (!values) throw new Error(`${def.label} 需要数组或逗号分隔字符串`);
    return values
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const value =
    typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
  if (value === null) throw new Error(`${def.label} 需要字符串`);
  if (def.options && !def.options.includes(value)) {
    throw new Error(`${def.label} 只能是 ${def.options.join("/")}`);
  }
  return value;
}

export function settingValue(key: keyof typeof config): unknown {
  return config[key];
}

export function initialSettingValue(key: keyof typeof config): unknown {
  return INITIAL_CONFIG[key];
}

export function applySetting(key: keyof typeof config, value: unknown): void {
  (config as Record<string, unknown>)[key] = value;
}

/** 先按面板控件类型转换，再交给启动时的 EnvSchema 做同一套校验 */
export function normalizeSetting(def: SettingDef, raw: unknown): unknown {
  const coerced = coerceSetting(def, raw);
  const schemaInput =
    def.kind === "string[]"
      ? (coerced as string[]).join(",")
      : def.kind === "boolean"
        ? String(coerced)
        : coerced;
  const fieldSchema = (EnvSchema.shape as Record<string, ZodType>)[def.key];
  if (!fieldSchema) throw new Error(`未知配置项 ${def.key}`);
  const parsed = fieldSchema.safeParse(schemaInput);
  if (!parsed.success) throw new Error(`${def.label} 格式不合法`);
  return parsed.data;
}

export function findSetting(key: string): SettingDef | undefined {
  return SETTING_DEFS.find((def) => def.key === key);
}
