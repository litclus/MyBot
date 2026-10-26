import assert from "node:assert/strict";
import { sanitizeReply } from "../../src/chat/sanitize.js";

const input = [
  "# 标题",
  "",
  "**加粗** 和 *斜体* 还有 __下划线__",
  "",
  "- 列表一",
  "- 列表二",
  "",
  "1. 编号一",
  "2. 编号二",
  "",
  "> 引用",
  "",
  "| 列一 | 列二 |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "见 [链接](https://example.com)",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "你好 [[mention:u1]]。",
].join("\n");

const output = sanitizeReply(input);
console.log("--- output ---");
console.log(output);

assert.ok(!output.includes("#"));
assert.ok(!output.includes("**"));
assert.ok(!output.includes("```"));
assert.ok(!output.includes("|"));
assert.ok(!output.includes("[链接]"));
assert.ok(output.includes("加粗"));
assert.ok(output.includes("列表一"));
assert.ok(output.includes("const a = 1;"));
assert.ok(output.includes("[[mention:u1]]"));
assert.ok(!output.endsWith("。"));

console.log("FORMAT OK");
