export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no JSON object in model output");
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
