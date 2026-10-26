console.log("importing");
const { env, pipeline } = await import("@huggingface/transformers");
console.log("imported");
env.remoteHost = "https://hf-mirror.com";
env.allowLocalModels = false;

console.log("loading pipeline");
const extractor = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5", {
  dtype: "q8",
  device: "wasm",
});
console.log("loaded");
const out = await extractor("我喜欢喝美式咖啡", { pooling: "mean", normalize: true });
console.log("dims", out.dims, Array.from(out.data).slice(0, 3));
