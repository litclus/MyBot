import type {
  InboundMention,
  InboundMessage,
  InboundPart,
  QqAttachment,
  QqC2CEvent,
  QqGroupAtEvent,
  QqMsgElement,
  QqUser,
} from "./types.js";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** QQ 表情的 ext 是 base64 文本，例如 [牛逼] */
function decodeFaceText(ext: string | undefined): string {
  if (!ext) return "表情";
  try {
    const decoded = Buffer.from(ext, "base64").toString("utf8").trim();
    const text = unwrapQqText(decoded).trim().slice(0, 20);
    if (!text || /[\u0000-\u001f]/.test(text)) return "表情";
    return text.replace(/^\[|\]$/g, "").replace(/[<>]/g, "").trim() || "表情";
  } catch {
    return "表情";
  }
}

/** QQ 有时把图片/卡片正文包成 {"text":""}，这里把 text 字段拆出来 */
export function unwrapQqText(content: string): string {
  // 有些客户端会在 JSON 前后带零宽字符
  const cleaned = content.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!cleaned.includes('"text"')) return content;

  try {
    const data = JSON.parse(cleaned) as { text?: unknown };
    if (data && typeof data === "object" && typeof data.text === "string") {
      return data.text;
    }
  } catch {
    // JSON 不完整时继续用正则兜底
  }

  const match = cleaned.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1] ?? "";
    }
  }
  return content;
}

function replaceMentions(content: string, mentions: QqUser[]): string {
  let text = content;
  for (const mention of mentions) {
    const openid = mention.member_openid;
    if (!openid) continue;
    const label = mention.bot ? "你" : (mention.username ?? "成员");
    text = text.replaceAll(`<@${openid}>`, `@${label}`);
  }
  return text.replaceAll("<@all>", "@全体成员");
}

/** 把消息正文拆成文字、emoji、sticker 三类 part，顺序不变。 */
function renderContentParts(
  content: string,
  mentions: QqUser[],
  hasImage = false,
): InboundPart[] {
  const source = unwrapQqText(content);
  const parts: InboundPart[] = [];
  const pushText = (raw: string) => {
    const text = replaceMentions(raw, mentions)
      .replace(/<faceType=[^>]*>/g, "")
      .trim();
    if (text) parts.push({ type: "text", text });
  };

  const facePattern =
    /<faceType=(\d+)\s*,\s*faceId="[^"]*"(?:\s*,\s*ext="([^"]*)")?\s*\/?>/g;
  let lastIndex = 0;
  for (const match of source.matchAll(facePattern)) {
    const index = match.index ?? 0;
    pushText(source.slice(lastIndex, index));
    const faceType = match[1];
    const description = decodeFaceText(match[2]);
    if (faceType === "1") {
      parts.push({ type: "emoji", description });
    } else if (!(faceType === "6" && hasImage)) {
      parts.push({ type: "sticker", description });
    }
    lastIndex = index + match[0].length;
  }
  pushText(source.slice(lastIndex));
  return parts;
}

/** 历史/旧数据：把原始正文转成 parts，不生成中间标签。 */
export function parseQqContentParts(content: string, hasImage = false): InboundPart[] {
  return renderContentParts(content, [], hasImage);
}

function toAttachment(attachment: QqAttachment): InboundMessage["attachments"][number] | null {
  const url = nonEmpty(attachment.url);
  if (!url) return null;
  const contentType = nonEmpty(attachment.content_type) ?? "application/octet-stream";
  return {
    url,
    contentType,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.width !== undefined ? { width: attachment.width } : {}),
    ...(attachment.height !== undefined ? { height: attachment.height } : {}),
  };
}

function toInboundMention(user: QqUser): InboundMention | null {
  const externalId = nonEmpty(user.member_openid) ?? nonEmpty(user.id);
  const personKey = nonEmpty(user.union_openid) ?? externalId;
  if (!externalId || !personKey) return null;
  return {
    externalId,
    personKey,
    name: nonEmpty(user.username) ?? `用户${personKey.slice(-4)}`,
    bot: user.bot === true,
  };
}

/**
 * 把 QQ 的 GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE 归一化成平台无关的消息。
 * forceMention 用于 @ 事件；全量事件则根据 mentions 判断是否 @ 了机器人。
 */
export function normalizeGroupAt(
  data: QqGroupAtEvent,
  options: { forceMention?: boolean } = {},
): InboundMessage | null {
  const messageId = nonEmpty(data.id);
  const groupOpenid = nonEmpty(data.group_openid);
  if (!messageId || !groupOpenid) return null;

  const author = data.author ?? {};
  const memberOpenid = nonEmpty(author.member_openid);
  const unionOpenid = nonEmpty(author.union_openid);
  const authorId = nonEmpty(author.id);
  const personKey = unionOpenid ?? memberOpenid ?? authorId;
  if (!personKey) return null;

  const externalId = memberOpenid ?? authorId ?? personKey;
  const name = nonEmpty(author.username) ?? `用户${personKey.slice(-4)}`;

  const mentions = data.mentions ?? [];
  const mentionedBot = mentions.some((mention) => mention.bot === true);
  const isMention = options.forceMention === true || mentionedBot;
  const mentionTargets = mentions
    .map(toInboundMention)
    .filter((mention): mention is InboundMention => mention !== null);

  const attachments = (data.attachments ?? [])
    .map(toAttachment)
    .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);

  const receivedAt = data.timestamp ? new Date(data.timestamp) : new Date();
  const quoted = extractQuoted(data);
  const parts = renderContentParts(
    data.content ?? "",
    mentions,
    attachments.length > 0,
  );
  const text = parts
    .filter((part): part is Extract<InboundPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return {
    platform: "qq",
    messageId,
    conversation: {
      externalId: groupOpenid,
      kind: "group",
    },
    sender: {
      externalId,
      personKey,
      name,
      ...(author.member_role ? { role: author.member_role } : {}),
    },
    text,
    parts,
    attachments,
    ...(mentionTargets.length > 0 ? { mentions: mentionTargets } : {}),
    ...(quoted ? { quoted } : {}),
    isMention,
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    raw: data,
  };
}

/** 私聊消息：C2C_MESSAGE_CREATE。 */
export function normalizeC2C(data: QqC2CEvent): InboundMessage | null {
  const messageId = nonEmpty(data.id);
  const author = data.author ?? {};
  const userOpenid = nonEmpty(author.user_openid) ?? nonEmpty(author.id);
  if (!messageId || !userOpenid) return null;

  const name = nonEmpty(author.username) ?? `用户${userOpenid.slice(-4)}`;
  const attachments = (data.attachments ?? [])
    .map(toAttachment)
    .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);
  const receivedAt = data.timestamp ? new Date(data.timestamp) : new Date();
  const quoted = extractQuoted(data);
  const parts = renderContentParts(
    data.content ?? "",
    [],
    attachments.length > 0,
  );
  const text = parts
    .filter((part): part is Extract<InboundPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return {
    platform: "qq",
    messageId,
    conversation: { externalId: userOpenid, kind: "dm" },
    sender: {
      externalId: userOpenid,
      personKey: nonEmpty(author.union_openid) ?? userOpenid,
      name,
    },
    text,
    parts,
    attachments,
    ...(quoted ? { quoted } : {}),
    isMention: true,
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    raw: data,
  };
}

/** 引用消息：message_type=103 时 msg_elements 里是被引用的内容。 */
function extractQuoted(
  data: QqGroupAtEvent | QqC2CEvent,
): { author?: string; text: string; attachments?: InboundMessage["attachments"] } | undefined {
  if (data.message_type !== 103) return undefined;
  const parts: string[] = [];
  const attachments: InboundMessage["attachments"] = [];
  const seen = new Set<string>();
  let author: string | undefined;

  const walk = (elements: QqMsgElement[] | undefined) => {
    for (const element of elements ?? []) {
      if (!author && element.author?.username) author = element.author.username;
      if (element.content?.trim()) {
        const rendered = renderContent(
          element.content,
          [],
          (element.attachments?.length ?? 0) > 0,
        ).trim();
        if (rendered) parts.push(rendered);
      }
      for (const attachment of element.attachments ?? []) {
        const parsed = toAttachment(attachment);
        if (!parsed || seen.has(parsed.url)) continue;
        seen.add(parsed.url);
        attachments.push(parsed);
      }
      if (element.msg_elements?.length) walk(element.msg_elements);
    }
  };
  walk(data.msg_elements);

  const text = parts.join("\n").trim().slice(0, 500);
  if (!text && attachments.length === 0) return undefined;
  return {
    ...(author ? { author } : {}),
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** 引用消息等纯文本场景：把文字和表情描述拼成可读文本。 */
function renderContent(content: string, mentions: QqUser[], hasImage = false): string {
  return renderContentParts(content, mentions, hasImage)
    .map((part) => (part.type === "text" ? part.text : part.description))
    .join(" ")
    .trim();
}
