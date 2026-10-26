import { env, pipeline } from "@huggingface/transformers";
import { logger } from "../app/logger.js";

const MODEL = "Xenova/bge-small-zh-v1.5";
const DIMENSIONS = 512;

type EmbeddingOutput = {
  data: Float32Array | number[];
  dims: number[];
};

type EmbeddingPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<EmbeddingOutput>;

let extractorPromise: Promise<EmbeddingPipeline> | undefined;
let queue: Promise<unknown> = Promise.resolve();

async function getExtractor(): Promise<EmbeddingPipeline> {
  if (!extractorPromise) {
    env.remoteHost = "https://hf-mirror.com";
    env.allowLocalModels = true;
    extractorPromise = pipeline("feature-extraction", MODEL, {
      dtype: "q8",
      device: "cpu",
    }) as unknown as Promise<EmbeddingPipeline>;
  }
  return extractorPromise;
}

/**
 * 本地 bge-small-zh-v1.5，512 维，CPU。
 * onnxruntime-node 固定在 1.20.1：1.30.0 的 Windows 二进制在本机会 0xC0000005。
 */
export async function embedText(text: string): Promise<number[] | null> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!clean) return null;

  try {
    const extractor = await getExtractor();
    const run = async (): Promise<number[]> => {
      const output = await extractor(clean, { pooling: "mean", normalize: true });
      const values = Array.from(output.data as ArrayLike<number>);
      return values.slice(0, DIMENSIONS);
    };
    const task = queue.then(run, run);
    queue = task.catch(() => undefined);
    return await task;
  } catch (error) {
    logger.warn("embedding failed", error);
    return null;
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
