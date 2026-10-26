export type TextPart = { type: "text"; text: string };

export type ImagePart = {
  type: "image";
  mime: string;
  data: Uint8Array;
  name?: string;
};

export type ChatPart = TextPart | ImagePart;

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage =
  | { role: "system" | "user"; parts: ChatPart[] }
  | { role: "assistant"; parts: ChatPart[]; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ChatUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ChatRequest = {
  messages: ChatMessage[];
  /** 会话键，例如 qq:group:123:member:456；用于生成稳定的 x-opencode-session */
  sessionKey?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type ChatResponse = {
  text: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: ChatUsage;
  raw?: unknown;
};

export type ModelCapabilities = {
  vision: boolean;
  tools: boolean;
  json: boolean;
  cache: boolean;
};

export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
