import type { MentionCandidate } from "../db/repository.js";

export type ResolvedMentions = {
  /** 发给 QQ 的正文，群聊里是 <qqbot-at-user id="..." /> */
  content: string;
  /** 写入历史/日志的展示文本，@名字 */
  display: string;
};

/**
 * 把 agent 输出的 [[mention:uXXXXXX]] 换成真正的 @ 标签。
 * 模型不写 token 就不会 @ 任何人；不会自动 @ 提问者。
 */
export function resolveMentions(
  text: string,
  candidates: MentionCandidate[],
  kind: "group" | "dm",
): ResolvedMentions {
  let content = text;
  let display = text;

  for (const candidate of candidates) {
    const token = `[[mention:${candidate.token}]]`;
    // 模型常写成“[[mention:u1]] 张三 内容”；token 本身已经带名字，去掉后面重复的称呼
    const names = [candidate.name, ...(candidate.aliases ?? [])]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    if (names.length > 0) {
      const pattern = new RegExp(
        `${escapeRegExp(token)}\\s*(?:${names.map(escapeRegExp).join("|")})(?=\\s|$|[，,。.!！?？、])`,
        "g",
      );
      content = content.replace(pattern, token);
      display = display.replace(pattern, token);
    }
    content = content.split(token).join(
      kind === "group" ? `<qqbot-at-user id="${candidate.openid}" />` : `@${candidate.name}`,
    );
    display = display.split(token).join(`@${candidate.name}`);
  }

  content = stripUnknownMentions(content).trim();
  display = stripUnknownMentions(display).trim();
  return { content, display };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 模型写错/编造的 token 直接去掉，避免把内部标记发给用户。 */
function stripUnknownMentions(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("[[mention:", index);
    if (start < 0) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, start);
    const end = text.indexOf("]]", start);
    if (end < 0) break;
    index = end + 2;
  }
  return result;
}
