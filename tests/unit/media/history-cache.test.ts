import assert from "node:assert/strict";
import test from "node:test";
import type { ImagePart } from "../../../src/ports/model.js";
import {
  clearHistoryImageCache,
  getHistoryImage,
  getHistoryImages,
  rememberHistoryImages,
} from "../../../src/media/history-cache.js";

const image = (text: string): ImagePart => ({
  type: "image",
  mime: "image/png",
  data: Buffer.from(text),
});

test("历史图片可以按消息 id 和原图序号取回，且不消费", () => {
  clearHistoryImageCache();
  rememberHistoryImages("m1", [{ index: 2, part: image("a") }]);
  assert.equal(getHistoryImages("m1")?.length, 1);
  assert.equal(getHistoryImage("m1", 2)?.data.toString(), "a");
  assert.equal(getHistoryImage("m1", 1), null);
  assert.equal(getHistoryImages("m1")?.length, 1);
});

test("不同消息分开缓存", () => {
  clearHistoryImageCache();
  rememberHistoryImages("m1", [{ index: 1, part: image("a") }]);
  rememberHistoryImages("m2", [{ index: 1, part: image("b") }]);
  assert.equal(getHistoryImage("m1", 1)?.data.toString(), "a");
  assert.equal(getHistoryImage("m2", 1)?.data.toString(), "b");
});

test("同一条消息重复写入会覆盖", () => {
  clearHistoryImageCache();
  rememberHistoryImages("m1", [{ index: 1, part: image("a") }]);
  rememberHistoryImages("m1", [
    { index: 1, part: image("b") },
    { index: 2, part: image("c") },
  ]);
  assert.equal(getHistoryImages("m1")?.length, 2);
  assert.equal(getHistoryImage("m1", 1)?.data.toString(), "b");
});
