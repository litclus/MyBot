const model = process.argv[2] ?? "Xenova/bge-small-zh-v1.5";
const dtype = process.argv[3] ?? "q8";
const device = process.argv[4] ?? "cpu";
console.log({ model, dtype, device });

const { env, pipeline } = await import("@huggingface/transformers");
env.remoteHost = "https://hf-mirror.com";
env.allowLocalModels = false;

const extractor = await pipeline("feature-extraction", model, { dtype, device });
console.log("loaded");
const out = await extractor("我喜欢喝美式咖啡", { pooling: "mean", normalize: true });
console.log("dims", out.dims);
