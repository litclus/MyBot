import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";
import { parseSchemaComments } from "./schema-comments.js";

const SCHEMA_FILE = fileURLToPath(new URL("./schema.ts", import.meta.url));

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 从 schema.ts 的 JSDoc 生成表/字段注释，不维护第二份清单 */
export async function applyDbComments(): Promise<void> {
  const parsed = parseSchemaComments(readFileSync(SCHEMA_FILE, "utf8"));
  const statements: string[] = [];

  for (const table of parsed.tables) {
    if (table.comment) {
      statements.push(`COMMENT ON TABLE "${table.name}" IS ${quote(table.comment)};`);
    }
    for (const column of table.columns) {
      if (!column.comment) continue;
      statements.push(
        `COMMENT ON COLUMN "${table.name}"."${column.name}" IS ${quote(column.comment)};`,
      );
    }
  }

  for (const view of parsed.views) {
    if (view.comment) {
      statements.push(`COMMENT ON VIEW "${view.name}" IS ${quote(view.comment)};`);
    }
    // 视图列沿用 images 的字段注释
    if (view.name === "sticker_images") {
      const images = parsed.tables.find((table) => table.name === "images");
      for (const column of images?.columns ?? []) {
        if (!column.comment) continue;
        statements.push(
          `COMMENT ON COLUMN "${view.name}"."${column.name}" IS ${quote(column.comment)};`,
        );
      }
    }
  }

  if (statements.length > 0) await pool.query(statements.join("\n"));
}
