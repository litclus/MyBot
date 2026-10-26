import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeReply } from "../../../src/chat/sanitize.js";

test("sanitizeReply 去掉常见 Markdown", () => {
  const input = [
    "# 标题",
    "**加粗** 和 *斜体*",
    "> 引用",
    "- 列表",
    "1. 编号",
    "`代码`",
    "[链接](https://example.com)",
    "![图](https://example.com/a.png)",
  ].join("\n");
  const output = sanitizeReply(input);

  assert.ok(!output.includes("#"));
  assert.ok(!output.includes("**"));
  assert.ok(!output.includes(">"));
  assert.ok(!output.includes("- "));
  assert.ok(!output.includes("1. "));
  assert.ok(!output.includes("`"));
  assert.ok(output.includes("标题"));
  assert.ok(output.includes("加粗"));
  assert.ok(output.includes("链接"));
  assert.ok(output.includes("[图片]"));
});

test("sanitizeReply 保留内部 token", () => {
  const output = sanitizeReply("看 [[mention:u123]]。");
  assert.equal(output, "看 [[mention:u123]]");
});

test("sanitizeReply 去掉句末句号", () => {
  assert.equal(sanitizeReply("你好。"), "你好");
});
