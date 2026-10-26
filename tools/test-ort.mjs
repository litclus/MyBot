console.log("before import");
const ort = await import("onnxruntime-node");
console.log("after import", Object.keys(ort).slice(0, 8));
