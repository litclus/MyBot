import type { InboundAttachment } from "../adapters/qq/types.js";

export type QuotedAttachmentMeta = {
  type: "image" | "file";
  mime: string;
  name?: string;
  size?: number;
};

export type QuotedMeta = {
  author?: string;
  text: string;
  attachments?: QuotedAttachmentMeta[];
  /** 传给 image_view 的缓存 key */
  viewId?: string;
};

export function quotedViewId(messageId: string): string {
  return `${messageId}#quoted`;
}

export function buildQuotedMeta(
  quoted:
    | { author?: string; text: string; attachments?: InboundAttachment[] }
    | undefined,
  messageId: string,
): QuotedMeta | undefined {
  if (!quoted) return undefined;
  const attachments = (quoted.attachments ?? []).map((attachment) => ({
    type: attachment.contentType.startsWith("image/") ? ("image" as const) : ("file" as const),
    mime: attachment.contentType,
    ...(attachment.filename ? { name: attachment.filename } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  }));
  const hasImage = attachments.some((attachment) => attachment.type === "image");
  return {
    ...(quoted.author ? { author: quoted.author } : {}),
    text: quoted.text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(hasImage ? { viewId: quotedViewId(messageId) } : {}),
  };
}

export function parseQuotedMeta(value: unknown): QuotedMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.text !== "string") return undefined;
  const attachments = Array.isArray(data.attachments)
    ? data.attachments
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          type: item.type === "image" ? ("image" as const) : ("file" as const),
          mime: typeof item.mime === "string" ? item.mime : "",
          ...(typeof item.name === "string" ? { name: item.name } : {}),
          ...(typeof item.size === "number" ? { size: item.size } : {}),
        }))
        .filter((item) => item.mime)
    : [];
  return {
    ...(typeof data.author === "string" ? { author: data.author } : {}),
    text: data.text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof data.viewId === "string" ? { viewId: data.viewId } : {}),
  };
}
