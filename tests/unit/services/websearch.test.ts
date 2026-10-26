import assert from "node:assert/strict";
import test from "node:test";
import { formatSearchHits, fuzzyQuota, type SearchHit } from "../../../src/services/websearch.js";

test("formatSearchHits 空结果", () => {
  assert.equal(formatSearchHits([]), "没有搜到结果");
});

test("formatSearchHits 带站点和日期", () => {
  const hits: SearchHit[] = [
    {
      title: "某新闻",
      url: "https://example.com/a",
      snippet: "一句话摘要",
      siteName: "示例网",
      date: "2026-10-20T00:00:00Z",
      authority: 3,
    },
  ];
  const text = formatSearchHits(hits);
  assert.ok(text.includes("1. 某新闻"));
  assert.ok(text.includes("示例网 2026-10-20 权威"));
  assert.ok(text.includes("https://example.com/a"));
});

test("formatSearchHits 洗掉 Markdown 和省略号", () => {
  const hits: SearchHit[] = [
    {
      title: "标题",
      url: "https://example.com/b",
      snippet: "# 标题 **重点** [链接](https://x.com) ... 后半段",
    },
  ];
  const text = formatSearchHits(hits);
  assert.ok(!text.includes("**"));
  assert.ok(!text.includes("]("));
  assert.ok(text.includes("链接"));
  assert.ok(text.includes("/"));
});

test("formatSearchHits 总长有上限", () => {
  const hits: SearchHit[] = Array.from({ length: 10 }, (_, index) => ({
    title: `标题${index}`,
    url: `https://example.com/${index}`,
    snippet: "很长的摘要".repeat(60),
  }));
  const text = formatSearchHits(hits);
  assert.ok(text.length <= 1_500, `超长: ${text.length}`);
  assert.ok(text.includes("1. 标题0"));
});

test("fuzzyQuota 只给状态，不暴露次数和金额", () => {
  assert.equal(fuzzyQuota(0), "网页搜索额度已经用完了");
  assert.equal(fuzzyQuota(50), "网页搜索额度快见底了");
  assert.equal(fuzzyQuota(300), "网页搜索额度勉强够用");
  assert.equal(fuzzyQuota(1_807), "网页搜索额度还够用");
  assert.equal(fuzzyQuota(5_000), "网页搜索额度很宽裕");
  for (const value of [0, 5, 50, 200, 800, 1_807, 9_999]) {
    const text = fuzzyQuota(value);
    assert.ok(!/\d/.test(text), `${value} 的文案带了数字`);
    assert.ok(!text.includes("次"), `${value} 的文案带了次数`);
    assert.ok(!text.includes("元"), `${value} 的文案带了金额`);
  }
});
