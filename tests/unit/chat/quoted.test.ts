import assert from "node:assert/strict";
import test from "node:test";
import { buildQuotedMeta, parseQuotedMeta } from "../../../src/chat/quoted.js";

test("引用图片会带 image_view 的 viewId", () => {
  const meta = buildQuotedMeta(
    {
      author: "小明",
      text: "",
      attachments: [
        {
          url: "https://example.com/a.png",
          contentType: "image/png",
          filename: "a.png",
          size: 10,
        },
      ],
    },
    "msg-1",
  );
  assert.equal(meta?.viewId, "msg-1#quoted");
  assert.equal(meta?.attachments?.[0]?.type, "image");
  assert.deepEqual(parseQuotedMeta(meta), meta);
});

test("只有文件时不生成 viewId", () => {
  const meta = buildQuotedMeta(
    {
      text: "文件",
      attachments: [{ url: "https://example.com/a.zip", contentType: "application/zip" }],
    },
    "msg-2",
  );
  assert.equal(meta?.viewId, undefined);
  assert.equal(meta?.attachments?.[0]?.type, "file");
});
