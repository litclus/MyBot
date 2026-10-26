import { readFile } from "node:fs/promises";
import { logger } from "../app/logger.js";
import { getMeme, upsertMeme, type UpsertMemeInput } from "./repository.js";

const SEED_FILE = "seeds/memes.json";

/** 只补缺失的梗，不覆盖 agent 之后的修改。 */
export async function ensureSeedMemes(): Promise<number> {
  let entries: UpsertMemeInput[];
  try {
    entries = JSON.parse(await readFile(SEED_FILE, "utf8")) as UpsertMemeInput[];
  } catch (error) {
    logger.warn("meme seed file not loaded", error);
    return 0;
  }
  if (!Array.isArray(entries)) return 0;

  let inserted = 0;
  for (const entry of entries) {
    if (!entry?.keyword) continue;
    const existing = await getMeme(entry.keyword);
    if (existing) continue;
    await upsertMeme(entry);
    inserted += 1;
  }
  if (inserted > 0) logger.info("meme seeds inserted", inserted);
  return inserted;
}
