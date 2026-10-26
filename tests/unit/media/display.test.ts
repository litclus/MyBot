import assert from "node:assert/strict";
import test from "node:test";
import { markdownImageSize } from "../../../src/media/display.js";

test("markdownImageSize 按最长边缩放", () => {
  assert.equal(markdownImageSize(300, 300), " #200px #200px");
  assert.equal(markdownImageSize(240, 354), " #136px #200px");
  assert.equal(markdownImageSize(480, 320), " #200px #133px");
});

test("markdownImageSize 不放大", () => {
  assert.equal(markdownImageSize(100, 100), " #100px #100px");
  assert.equal(markdownImageSize(80, 200), " #80px #200px");
});

test("markdownImageSize 缺尺寸返回空", () => {
  assert.equal(markdownImageSize(null, null), "");
  assert.equal(markdownImageSize(0, 100), "");
  assert.equal(markdownImageSize(100, -1), "");
});

test("markdownImageSize 可覆盖上限", () => {
  assert.equal(markdownImageSize(400, 200, 100, 100), " #100px #50px");
});
