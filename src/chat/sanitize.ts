/**
 * 回复正文清洗：去掉 Markdown 语法，保留文字和 [[mention:...]] 标记
 * 提示词只是约束，这里做最后一道兜底
 */
export function sanitizeReply(input: string): string {
  const tokens: string[] = [];
  let text = input.replace(/\[\[mention:[^\]]+\]\]/g, (match) => {
    tokens.push(match);
    return `\u0000${tokens.length - 1}\u0000`;
  });

  text = text.replace(/```[^\n]*\n?/g, "");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");

  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[图片]");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1");

  text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/gm, "");
  text = text.replace(/\|/g, " ");

  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[。]+$/g, "");
  text = text.trim();

  for (let index = 0; index < tokens.length; index += 1) {
    text = text.split(`\u0000${index}\u0000`).join(tokens[index] ?? "");
  }

  return text;
}
