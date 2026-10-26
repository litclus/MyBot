import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseSchemaComments } from "../../../src/db/schema-comments.js";

const schema = readFileSync(new URL("../../../src/db/schema.ts", import.meta.url), "utf8");
const parsed = parseSchemaComments(schema);

test("每张表和每个字段都有 JSDoc 注释", () => {
  assert.ok(parsed.tables.length > 0);
  for (const table of parsed.tables) {
    assert.ok(table.comment, `缺少表注释: ${table.name}`);
    for (const column of table.columns) {
      assert.ok(column.comment, `缺少字段注释: ${table.name}.${column.name}`);
    }
  }
});

test("视图注释存在", () => {
  const view = parsed.views.find((item) => item.name === "sticker_images");
  assert.ok(view?.comment);
});
