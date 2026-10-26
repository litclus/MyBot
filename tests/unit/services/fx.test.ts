import assert from "node:assert/strict";
import test from "node:test";
import { currencyName, formatRate, parseRate } from "../../../src/services/fx.js";

test("parseRate 默认取人民币→美元", () => {
  const parsed = parseRate([{ date: "2026-10-25", base: "CNY", quote: "USD", rate: 0.15 }]);
  assert.equal(parsed?.rate, 0.15);
  assert.equal(parsed?.date, "2026-10-25");
});

test("parseRate 按指定货币对取数", () => {
  const usdCny = parseRate([{ base: "USD", quote: "CNY", rate: 6.6669 }], "USD", "CNY");
  assert.equal(usdCny?.rate, 6.6669);
  assert.equal(parseRate([{ base: "EUR", quote: "CNY", rate: 7.81 }]), null);
});

test("parseRate 格式不对给 null", () => {
  assert.equal(parseRate(null), null);
  assert.equal(parseRate({}), null);
  assert.equal(parseRate([]), null);
  assert.equal(parseRate([{ base: "CNY", quote: "USD", rate: "abc" }]), null);
  assert.equal(parseRate([{ base: "CNY", quote: "USD", rate: -1 }]), null);
});

test("formatRate 带中文名和日期", () => {
  const text = formatRate("USD", "CNY", { rate: 6.6669, date: "2026-10-25", fetchedAt: 0 });
  assert.equal(text, "1 美元 = 6.6669 人民币（2026-10-25）");
});

test("formatRate 小额货币多留几位", () => {
  const text = formatRate("JPY", "CNY", { rate: 0.047012, date: "2026-10-25", fetchedAt: 0 });
  assert.equal(text, "1 日元 = 0.047012 人民币（2026-10-25）");
});

test("currencyName 没收录就用代码", () => {
  assert.equal(currencyName("cny"), "人民币");
  assert.equal(currencyName("XYZ"), "XYZ");
});
