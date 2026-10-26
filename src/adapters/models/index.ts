import { config } from "../../config.js";
import type { ModelProvider } from "../../ports/model.js";
import { OpenCodeGoProvider } from "./opencode-go.js";

/** 目前只有 Go 直连；以后新增 provider 在这里按配置路由。 */
export function createModelProvider(): ModelProvider {
  return new OpenCodeGoProvider({
    baseUrl: config.OPENCODE_BASE_URL,
    apiKey: config.OPENCODE_API_KEY,
    model: config.OPENCODE_MODEL,
    userAgent: config.MYBOT_USER_AGENT,
  });
}
