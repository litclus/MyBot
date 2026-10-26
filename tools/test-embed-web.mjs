console.log("start");
const { env, pipeline } = await import(
  "@huggingface/transformers/dist/transformers.web.mjs"
);
console.log("imported");
env.remoteHost = "https://hf-mirror.com";
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

const extractor = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5", {
  dtype: "q8",
});
console.log("loaded");
const out = await extractor("我喜欢喝美式咖啡", { pooling: "mean", normalize: true });
console.log("dims", out.dims, Array.from(out.data).slice(0, 3));
