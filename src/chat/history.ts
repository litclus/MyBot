import { config } from "../config.js";
import type { RecentMessage } from "../db/repository.js";
import type { MessagePart } from "../db/schema.js";
import type { ChatMessage, ToolCall } from "../ports/model.js";
import { parseQqContentParts } from "../adapters/qq/normalize.js";
import { parseQuotedMeta } from "./quoted.js";

const MESSAGE_OVERHEAD_TOKENS = 12;

export type TrimHistoryOptions = {
  maxTokens?: number;
  minMessages?: number;
};

/**
 * 按 token 预算裁剪历史；方案 A：超出预算直接从最早的消息开始丢。
 * 工具调用和 ToolMessage 只在本轮 graph 内有效，不进入下一轮上下文，
 * 这样历史形状只由 user / assistant 最终回复决定，前缀不会因工具消息改变。
 */
export function trimHistory(
  rows: RecentMessage[],
  options: TrimHistoryOptions = {},
): RecentMessage[] {
  const visible = rows.filter((row) => !isToolRelated(row));
  const maxTokens = options.maxTokens ?? config.HISTORY_MAX_TOKENS;
  const minMessages = Math.min(
    options.minMessages ?? config.HISTORY_MIN_MESSAGES,
    visible.length,
  );
  const selected: RecentMessage[] = [];
  let totalTokens = 0;

  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const row = visible[index]!;
    const tokens = estimateHistoryTokens(row);
    if (selected.length >= minMessages && totalTokens + tokens > maxTokens) {
      break;
    }
    selected.push(row);
    totalTokens += tokens;
  }

  return selected.reverse();
}

/** 粗略估算：中文按 1 字 1 token，英文/JSON 按 4 字符 1 token。 */
function estimateHistoryTokens(row: RecentMessage): number {
  const message = toHistoryMessage(row);
  if (!message || message.role === "tool") return 0;
  const text = message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4) + MESSAGE_OVERHEAD_TOKENS;
}

function isToolRelated(row: RecentMessage): boolean {
  if (row.role === "tool") return true;
  return row.role === "assistant" && Array.isArray(row.metadata.toolCalls);
}

type HistoryPart =
  | { type: "text"; text: string }
  | { type: "emoji"; description: string }
  | { type: "sticker"; description: string };

/** 把数据库消息转成带 time/id/speaker/parts/attachments 的统一 JSON 消息 */
export function toHistoryMessage(row: RecentMessage): ChatMessage | null {
  const parts = historyParts(row.content.parts);
  const text = parts
    .filter((part): part is Extract<HistoryPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const attachments = row.content.parts
    .filter(
      (part): part is Extract<MessagePart, { type: "image" | "file" }> =>
        part.type === "image" || part.type === "file",
    )
    .map((part) => ({
      type: part.type,
      ...(part.type === "image" && part.assetId ? { assetId: part.assetId } : {}),
      ...(part.mime ? { mime: part.mime } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...(part.size !== undefined ? { size: part.size } : {}),
    }));

  if (row.role === "tool") {
    const toolCallId = String(row.metadata.toolCallId ?? "");
    if (!toolCallId) return null;
    return { role: "tool", toolCallId, content: text };
  }

  const speaker =
    row.role === "assistant"
      ? { id: "assistant", name: "助手" }
      : readSpeaker(row);
  const role: "user" | "assistant" = row.role === "assistant" ? "assistant" : "user";
  const quoted = parseQuotedMeta(row.metadata.quoted);
  const payload = {
    time: row.createdAt.toISOString(),
    id: row.platformMsgId ?? row.id,
    role,
    speaker,
    ...(parts.length > 0 ? { parts } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(quoted ? { quoted } : {}),
  };

  const toolCalls = Array.isArray(row.metadata.toolCalls)
    ? (row.metadata.toolCalls as ToolCall[])
    : undefined;

  return {
    role,
    parts: [{ type: "text", text: JSON.stringify(payload) }],
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** 新数据直接用 part.type；旧的原始 faceType 文本在这里转回 part。 */
function historyParts(source: MessagePart[]): HistoryPart[] {
  const result: HistoryPart[] = [];
  const hasImage = source.some((part) => part.type === "image");
  for (const part of source) {
    if (part.type === "emoji" || part.type === "sticker") {
      result.push({ type: part.type, description: part.description });
      continue;
    }
    if (part.type !== "text") continue;
    result.push(...parseQqContentParts(part.text, hasImage));
  }
  return result;
}

function readSpeaker(row: RecentMessage): { id: string; name: string } {
  const stored = row.metadata.speaker;
  if (stored && typeof stored === "object") {
    const data = stored as { id?: unknown; name?: unknown };
    return {
      id: typeof data.id === "string" ? data.id : row.personKey ?? row.personId ?? "unknown",
      name: typeof data.name === "string" ? data.name : row.personName ?? "成员",
    };
  }
  return {
    id: row.personKey ?? row.personId ?? "unknown",
    name: row.personName ?? "成员",
  };
}
