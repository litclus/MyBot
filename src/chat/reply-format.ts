import { sanitizeReply } from "./sanitize.js";
import { extractJsonObject } from "../util/json.js";

export type ReplyMessage = {
  /** 纯文本内容；语音消息里也保留，用于历史记录和语音失败兜底 */
  plainText: string;
  /** 语音文本；非空时优先发语音 */
  voiceText: string;
  images: number[];
  stickers: number[];
  /** 这条发出前等几秒，由模型按语气决定；缺省时按文本长度算 */
  gapSeconds?: number;
};

const MAX_GAP_SECONDS = 15;
const MIN_GAP_SECONDS = 0;

/**
 * 模型最终回复：
 * {"messages":[{"plainText":"...","voiceText":"...","images":[1],"stickers":[2]}]}
 * messages 为空表示不回复。
 *
 * 模型偶尔不包 JSON，直接给一句人话；这种情况按单条文本兜底，
 * 但看起来像写了一半的 JSON 就直接丢弃，不把残片发到群里
 */
export function parseReplyMessages(text: string, maxMessages = 3): ReplyMessage[] {
  const raw = text.trim();
  if (!raw) return [];

  const messages = readMessages(raw);

  if (messages.length > maxMessages) {
    const head = messages.slice(0, maxMessages - 1);
    const tail = messages.slice(maxMessages - 1);
    return [
      ...head,
      {
        plainText: tail.map((item) => item.plainText).filter(Boolean).join("\n"),
        voiceText: tail.map((item) => item.voiceText).filter(Boolean).join("\n"),
        images: tail.flatMap((item) => item.images),
        stickers: tail.flatMap((item) => item.stickers),
      },
    ];
  }
  return messages;
}

function readMessages(raw: string): ReplyMessage[] {
  const parsed = tryExtractJson(raw);
  if (parsed !== null) {
    const data = parsed as { messages?: unknown };
    if (Array.isArray(data.messages)) {
      return data.messages
        .map((item) => renderMessage(item))
        .filter((item): item is ReplyMessage => item !== null);
    }
    const single = renderMessage(parsed);
    return single ? [single] : [];
  }

  if (looksLikeJson(raw)) return [];

  const fallback = sanitizeReply(raw);
  return fallback ? [{ plainText: fallback, voiceText: "", images: [], stickers: [] }] : [];
}

function tryExtractJson(raw: string): unknown | null {
  try {
    return extractJsonObject(raw);
  } catch {
    return null;
  }
}

/** 以 { 或 [ 开头的都当 JSON 残片，宁可这条不回 */
function looksLikeJson(raw: string): boolean {
  return /^[[{]/.test(raw);
}

function renderMessage(item: unknown): ReplyMessage | null {
  if (!item || typeof item !== "object") return null;
  const data = item as {
    plainText?: unknown;
    voiceText?: unknown;
    images?: unknown;
    stickers?: unknown;
    gap?: unknown;
  };
  const plainText =
    typeof data.plainText === "string" ? sanitizeReply(data.plainText) : "";
  const voiceText = typeof data.voiceText === "string" ? data.voiceText.trim() : "";
  const images = normalizeIds(data.images);
  const stickers = normalizeIds(data.stickers);
  const gapSeconds = normalizeGap(data.gap);
  if (!plainText && !voiceText && images.length === 0 && stickers.length === 0) return null;
  return {
    plainText,
    voiceText,
    images,
    stickers,
    ...(gapSeconds === undefined ? {} : { gapSeconds }),
  };
}

/** gap 单位秒，0-15，保留一位小数；不合法就不给 */
function normalizeGap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MIN_GAP_SECONDS) return MIN_GAP_SECONDS;
  const clamped = Math.min(value, MAX_GAP_SECONDS);
  return Math.round(clamped * 10) / 10;
}

function normalizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((id): id is number => Number.isInteger(id) && id > 0),
    ),
  ];
}

/** 模拟人类输入间隔：文本越长等得越久，但不超过 2.5 秒 */
export function humanDelayMs(text: string): number {
  const base = 300 + Math.min(text.length, 200) * 10;
  return Math.min(2500, base + Math.floor(Math.random() * 500));
}
