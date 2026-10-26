export type SchemaColumnComment = {
  name: string;
  comment: string | null;
};

export type SchemaTableComment = {
  name: string;
  comment: string | null;
  columns: SchemaColumnComment[];
};

export type SchemaViewComment = {
  name: string;
  comment: string | null;
};

export type SchemaComments = {
  tables: SchemaTableComment[];
  views: SchemaViewComment[];
};

const snake = (value: string) => value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

function docText(raw: string): string | null {
  const text = raw
    .trim()
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
  return text || null;
}

/** 从 i 开始读一段 JSDoc，返回文本和结束位置 */
function readDoc(lines: string[], i: number): { text: string | null; next: number } {
  const parts: string[] = [];
  let index = i;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    parts.push(line);
    if (line.includes("*/")) return { text: docText(parts.join("\n")), next: index + 1 };
    index += 1;
  }
  return { text: null, next: lines.length };
}

/**
 * 从 schema.ts 的 JSDoc 里读表注释和字段注释。
 * schema.ts 是唯一来源，comments.ts 不再维护第二份清单。
 */
export function parseSchemaComments(source: string): SchemaComments {
  const lines = source.split(/\r?\n/);
  const tables: SchemaTableComment[] = [];
  const views: SchemaViewComment[] = [];
  let pendingDoc: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("/**")) {
      const doc = readDoc(lines, i);
      pendingDoc = doc.text;
      i = doc.next - 1;
      continue;
    }

    const declaration = line.match(/^export const \w+\s*=\s*(pgTable|pgView)\(/);
    if (!declaration) {
      if (line.startsWith("export ")) pendingDoc = null;
      continue;
    }

    const kind = declaration[1];
    let name =
      line.match(/pgTable\(\s*"(\w+)"/)?.[1] ??
      line.match(/pgView\(\s*"(\w+)"/)?.[1] ??
      "";
    let cursor = i;
    while (!name && cursor + 1 < lines.length) {
      cursor += 1;
      const nextLine = lines[cursor] ?? "";
      name = nextLine.match(/"(\w+)"/)?.[1] ?? "";
    }

    const doc = pendingDoc;
    pendingDoc = null;

    if (kind === "pgView") {
      views.push({ name, comment: doc });
      continue;
    }

    const columns: SchemaColumnComment[] = [];
    let fieldDoc: string | null = null;
    let inBody = line.includes("{");

    for (let j = cursor + 1; j < lines.length; j += 1) {
      const bodyLine = lines[j] ?? "";
      const bodyTrimmed = bodyLine.trim();

      if (!inBody) {
        if (bodyLine.includes("{")) inBody = true;
        continue;
      }

      if (bodyTrimmed.startsWith("/**")) {
        const field = readDoc(lines, j);
        fieldDoc = field.text;
        j = field.next - 1;
        continue;
      }

      const field = bodyLine.match(/^ {2,4}(\w+):/);
      if (field) {
        columns.push({ name: snake(field[1] ?? ""), comment: fieldDoc });
        fieldDoc = null;
        continue;
      }

      if (
        bodyTrimmed.startsWith("(table) =>") ||
        bodyTrimmed.startsWith(");") ||
        bodyTrimmed.startsWith("});")
      ) {
        break;
      }
    }

    tables.push({ name, comment: doc, columns });
  }

  return { tables, views };
}
