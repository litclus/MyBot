import assert from "node:assert/strict";
import { cosineSimilarity, embedText } from "../../src/memory/embedding.js";

const a = await embedText("我喜欢喝美式咖啡");
const b = await embedText("我最爱喝咖啡");
const c = await embedText("今天上海下大雨");

assert.ok(a && b && c, "embedding 返回空");
assert.equal(a.length, 512);
const simAB = cosineSimilarity(a, b);
const simAC = cosineSimilarity(a, c);
assert.ok(simAB > simAC, `语义相近应更高: ${simAB} vs ${simAC}`);

console.log("EMBED OK", {
  dims: a.length,
  coffee: Number(simAB.toFixed(3)),
  weather: Number(simAC.toFixed(3)),
});
