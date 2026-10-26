import { pathToFileURL } from "node:url";

globalThis.self = globalThis;

const url = pathToFileURL(
  "D:/Projects/MyBot/node_modules/.pnpm/@huggingface+transformers@4.3.1_@types+node@26.6.5/node_modules/@huggingface/transformers/dist/transformers.web.js",
).href;

console.log("importing");
const { env, pipeline } = await import(url);
console.log("imported");
env.remoteHost = "https://hf-mirror.com";
env.allowLocalModels = false;

console.log("loading");
const extractor = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5", {
  dtype: "q8",
});
console.log("loaded");
const out = await extractor("我喜欢喝美式咖啡", { pooling: "mean", normalize: true });
console.log("dims", out.dims, Array.from(out.data).slice(0, 3));
