import assert from "node:assert/strict";
import { closeDb } from "../../src/db/client.js";
import {
  deleteMeme,
  searchMemes,
  setMemeHeat,
  setMemeStatus,
  upsertMeme,
} from "../../src/memes/repository.js";
import { ensureSeedMemes } from "../../src/memes/seed.js";

try {
  await ensureSeedMemes();

  const results = await searchMemes({ query: "token来", limit: 3 });
  assert.ok(results.length > 0, "应该检索到梗");
  assert.ok(results[0]?.meme.replyGuide, "应带回复方式");
  console.log("SEARCH:", results[0]?.meme.title, results[0]?.meme.heat);

  const testKeyword = "smoke梗";
  await upsertMeme({
    keyword: testKeyword,
    title: "冒烟梗",
    meaning: "测试用",
    replyGuide: "测试回复",
    heat: 3,
  });
  await setMemeHeat(testKeyword, 5);
  await setMemeStatus(testKeyword, "outdated");
  const hidden = await searchMemes({ query: testKeyword });
  assert.ok(!hidden.some((item) => item.meme.keyword === testKeyword), "过时梗不应出现在默认检索");
  const shown = await searchMemes({ query: testKeyword, includeOutdated: true });
  assert.ok(shown.some((item) => item.meme.keyword === testKeyword), "includeOutdated 应能看到");
  assert.ok(await deleteMeme(testKeyword), "应能删除");

  console.log("MEME OK");
} finally {
  await closeDb();
}
