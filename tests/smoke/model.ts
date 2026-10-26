import { readFile } from "node:fs/promises";
import { createModelProvider } from "../../src/adapters/models/index.js";
import type { ChatMessage, ToolDefinition } from "../../src/ports/model.js";

const provider = createModelProvider();

const text = await provider.chat({
  sessionKey: "smoke:text",
  messages: [
    {
      role: "user",
      parts: [{ type: "text", text: "用一句中文回答：1+1 等于几？" }],
    },
  ],
});
console.log("TEXT:", text.text);
if (text.usage) console.log("USAGE:", text.usage);

const echoTool: ToolDefinition = {
  type: "function",
  function: {
    name: "mybot_echo",
    description: "Echo the given text back.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

const toolPrompt: ChatMessage = {
  role: "user",
  parts: [
    {
      type: "text",
      text: "调用 mybot_echo 工具，text 参数为 hello，然后把工具返回的内容原样告诉我",
    },
  ],
};

const first = await provider.chat({
  sessionKey: "smoke:tool",
  messages: [toolPrompt],
  tools: [echoTool],
});
console.log("TOOL CALLS:", JSON.stringify(first.toolCalls));

if (first.toolCalls?.length) {
  const call = first.toolCalls[0];
  if (!call) throw new Error("empty tool call");
  const args = JSON.parse(call.function.arguments) as { text?: string };
  const assistant: ChatMessage = {
    role: "assistant",
    parts: first.text ? [{ type: "text", text: first.text }] : [],
    toolCalls: first.toolCalls,
  };
  const toolResult: ChatMessage = {
    role: "tool",
    toolCallId: call.id,
    content: `echo:${args.text ?? ""}`,
  };
  const final = await provider.chat({
    sessionKey: "smoke:tool",
    messages: [toolPrompt, assistant, toolResult],
    tools: [echoTool],
  });
  console.log("TOOL FINAL:", final.text);
  if (final.usage) console.log("TOOL USAGE:", final.usage);
}

const imagePath = process.argv[2];
if (imagePath) {
  const data = await readFile(imagePath);
  const vision = await provider.chat({
    sessionKey: "smoke:vision",
    messages: [
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: "看这张图，只回答实际看到的内容：有哪些几何图形、各是什么颜色、图上文字是什么？",
          },
          { type: "image", mime: "image/png", data, name: "vision-test.png" },
        ],
      },
    ],
  });
  console.log("VISION:", vision.text);
  if (vision.usage) console.log("VISION USAGE:", vision.usage);
}
