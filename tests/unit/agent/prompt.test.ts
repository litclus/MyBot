import assert from "node:assert/strict";
import test from "node:test";
import { stripImageSaveRules } from "../../../src/agent/prompt.js";

test("关闭图片保存时去掉 image_save 规则", () => {
  const text = [
    "# 工具",
    "- 需要图时调用 image_search",
    "- 用户要保存图片时调用 image_save",
    "- 图片不会自动入库，要不要保存由你决定",
    "- 保存是回复发出后才异步入库的",
    "- 改图用 image_update",
  ].join("\n");
  const stripped = stripImageSaveRules(text);
  assert.ok(!stripped.includes("image_save"));
  assert.ok(!stripped.includes("要不要保存由你决定"));
  assert.ok(!stripped.includes("保存是回复发出后"));
  assert.ok(stripped.includes("image_search"));
  assert.ok(stripped.includes("image_update"));
});

test("没有 image_save 时原样保留其它内容", () => {
  const text = "- 正常规则\n- 另一条规则";
  assert.equal(stripImageSaveRules(text), text);
});
