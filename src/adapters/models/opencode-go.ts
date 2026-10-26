import { createHash } from "node:crypto";
import type {
  ChatMessage,
  ChatPart,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  ModelProvider,
  ToolCall,
} from "../../ports/model.js";

export type OpenCodeGoOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  userAgent: string;
  timeoutMs?: number;
  maxRetries?: number;
};

type OpenAIMessage = Record<string, unknown>;

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string };
};

class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "ModelHttpError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OpenCode Go 的 OpenAI 兼容通道。
 *
 * - 直连 https://opencode.ai/inference/go/openai/v1，不经过 opencode serve，因此没有
 *   OpenCode 那套 agent/项目上下文，提示词完全由 MyBot 控制。
 * - Go 网关要求每个会话带稳定的 x-opencode-session，否则会 400 MissingSessionID。
 * - 支持原生 tools / tool_calls 与图片输入。
 */
export class OpenCodeGoProvider implements ModelProvider {
  readonly id = "opencode-go";
  readonly capabilities = { vision: true, tools: true, json: true, cache: true };

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: OpenCodeGoOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: req.messages.map(toOpenAIMessage),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const data = await this.request(
      "/chat/completions",
      body,
      sessionIdFor(req.sessionKey ?? "default"),
      req.signal,
    );
    const choice = data.choices?.[0];
    const message = choice?.message;
    const text = typeof message?.content === "string" ? message.content : "";
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : undefined;

    const response: ChatResponse = { text, raw: data };
    if (toolCalls && toolCalls.length > 0) response.toolCalls = toolCalls;
    if (choice?.finish_reason) response.finishReason = choice.finish_reason;
    if (data.usage) response.usage = mapUsage(data.usage);
    return response;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OpenAIResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await fetch(this.baseUrl + path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": this.options.userAgent,
            "x-opencode-session": sessionId,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const raw = await response.text();
        if (response.ok) {
          return JSON.parse(raw) as OpenAIResponse;
        }

        const error = new ModelHttpError(
          response.status,
          `OpenCode Go ${path} -> ${response.status}: ${raw.slice(0, 300)}`,
          raw,
        );
        lastError = error;

        if (!isRetryable(response.status) || attempt === this.maxRetries) throw error;
        await sleep(retryDelay(response, attempt));
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (attempt === this.maxRetries) throw error;
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("OpenCode Go 请求失败");
  }
}

function sessionIdFor(sessionKey: string): string {
  // Go 网关要求每个会话有稳定的 x-opencode-session，用于路由和提示缓存。
  // 同一 QQ 会话重启后仍是同一个 id。
  return `ses_${createHash("sha256").update(sessionKey).digest("hex").slice(0, 24)}`;
}

function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  const text = message.parts
    .filter((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  if (message.role === "assistant") {
    const result: OpenAIMessage = { role: "assistant", content: text || null };
    if (message.toolCalls && message.toolCalls.length > 0) {
      result.tool_calls = message.toolCalls;
    }
    return result;
  }

  const images = message.parts.filter(
    (part): part is Extract<ChatPart, { type: "image" }> => part.type === "image",
  );
  if (images.length === 0) {
    return { role: message.role, content: text };
  }

  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: "text", text });
  for (const image of images) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`,
      },
    });
  }
  return { role: message.role, content };
}

function mapUsage(usage: NonNullable<OpenAIResponse["usage"]>): ChatUsage {
  const result: ChatUsage = {};
  if (usage.prompt_tokens !== undefined) result.input = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) result.output = usage.completion_tokens;
  if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
    result.reasoning = usage.completion_tokens_details.reasoning_tokens;
  }
  if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
    result.cacheRead = usage.prompt_tokens_details.cached_tokens;
  }
  return result;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10_000);
  }
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}
