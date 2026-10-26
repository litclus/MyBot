import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { ChatMessage, ImagePart, ModelProvider, ToolCall } from "../ports/model.js";
import type { DeferredAction } from "./actions.js";
import { agentTools, type AgentTool, type ToolContext } from "./tools.js";
import { DEFAULT_SYSTEM_TEMPLATE, renderSystemPrompt } from "./prompt.js";

const State = Annotation.Root({
  messages: Annotation<ChatMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  toolCalls: Annotation<ToolCall[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  actions: Annotation<DeferredAction[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  steps: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  reply: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

export type ReplyState = typeof State.State;

export type ReplyGraphOptions = {
  context: ToolContext;
  /** 稳定的会话键，传给模型网关做路由和提示缓存 */
  sessionKey?: string;
  tools?: Record<string, AgentTool>;
  /** 运行规则：工具、输出、上下文约束 */
  systemPrompt?: string;
  /** 人设：名字、性格、说话风格 */
  personaPrompt?: string;
  maxSteps?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

const DEFAULT_SYSTEM = renderSystemPrompt(DEFAULT_SYSTEM_TEMPLATE, { name: "MyBot" });

export function buildReplyGraph(provider: ModelProvider, options: ReplyGraphOptions) {
  const maxSteps = options.maxSteps ?? 4;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM;
  const tools = options.tools ?? agentTools;
  const toolList = Object.values(tools).map((tool) => tool.definition);

  const agentNode = async (state: ReplyState) => {
    const atLimit = state.steps >= maxSteps;
    const systemMessages: ChatMessage[] = [
      { role: "system", parts: [{ type: "text", text: systemPrompt }] },
    ];
    if (options.personaPrompt) {
      systemMessages.push({
        role: "system",
        parts: [{ type: "text", text: options.personaPrompt }],
      });
    }

    const response = await provider.chat({
      messages: [...systemMessages, ...state.messages],
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      ...(atLimit ? {} : { tools: toolList }),
      maxTokens: options.maxTokens ?? 600,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const assistant: ChatMessage = {
      role: "assistant",
      parts: response.text ? [{ type: "text", text: response.text }] : [],
      ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
    };

    return {
      messages: [assistant],
      toolCalls: response.toolCalls ?? [],
      reply: response.text,
      steps: state.steps + 1,
    };
  };

  const toolsNode = async (state: ReplyState) => {
    const results: ChatMessage[] = [];
    const actions: DeferredAction[] = [];
    const imageParts: ImagePart[] = [];
    for (const call of state.toolCalls) {
      if (options.signal?.aborted) throw new Error("agent aborted");
      const tool = tools[call.function.name];
      let content: string;
      if (!tool) {
        content = `Unknown tool: ${call.function.name}`;
      } else {
        try {
          const input = call.function.arguments ? (JSON.parse(call.function.arguments) as unknown) : {};
          const output = await tool.execute(input, options.context);
          if (typeof output === "string") {
            content = output;
          } else {
            content = output.content;
            if (output.actions) actions.push(...output.actions);
            if (output.images) imageParts.push(...output.images);
          }
        } catch (error) {
          content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      results.push({ role: "tool", toolCallId: call.id, content });
    }
    if (imageParts.length > 0) {
      results.push({
        role: "user",
        parts: [{ type: "text", text: "以下是通过 image_view 打开的历史图片" }, ...imageParts],
      });
    }
    return { messages: results, toolCalls: [], actions };
  };

  return new StateGraph(State)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", (state: ReplyState) =>
      state.toolCalls.length > 0 && state.steps < maxSteps ? "tools" : END,
    )
    .addEdge("tools", "agent")
    .compile();
}
