import { config } from "../config.js";

export type VoiceAudio = {
  data: Buffer;
  mime: string;
};

type TtsResponse = {
  choices?: Array<{
    message?: {
      audio?: {
        data?: unknown;
      };
    };
  }>;
  error?: { message?: unknown };
  message?: unknown;
};

const TIMEOUT_MS = 60_000;

/** 调 MiMo TTS，把语音文本合成为 wav；密钥和音色都从控制面板配置读取 */
export async function synthesizeVoice(text: string): Promise<VoiceAudio> {
  const content = text.trim();
  if (!content) throw new Error("语音文本为空");

  const apiKey = config.MIMO_API_KEY.trim();
  if (!apiKey) throw new Error("未配置 MIMO_API_KEY");

  const baseUrl = config.MIMO_TTS_BASE_URL.replace(/\/+$/, "");
  const model = config.MIMO_TTS_MODEL.trim();
  const voiceDesign = model.includes("voicedesign");
  const style = config.MIMO_TTS_STYLE.trim();
  if (voiceDesign && !style) throw new Error("voicedesign 模型需要配置 MIMO_TTS_STYLE");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(style ? [{ role: "user" as const, content: style }] : []),
          { role: "assistant" as const, content },
        ],
        audio: {
          format: "wav",
          ...(voiceDesign ? {} : { voice: config.MIMO_TTS_VOICE }),
        },
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed: TtsResponse = {};
    try {
      parsed = JSON.parse(raw) as TtsResponse;
    } catch {
      // 非 JSON 错误下面统一处理
    }

    if (!response.ok) {
      const detail =
        (typeof parsed.error?.message === "string" && parsed.error.message) ||
        (typeof parsed.message === "string" && parsed.message) ||
        raw.slice(0, 300);
      throw new Error(`TTS ${response.status}: ${detail}`);
    }

    const encoded = parsed.choices?.[0]?.message?.audio?.data;
    if (typeof encoded !== "string" || !encoded) {
      throw new Error("TTS 响应里没有 audio.data");
    }

    const data = Buffer.from(encoded, "base64");
    if (data.length === 0) throw new Error("TTS 返回了空音频");
    return { data, mime: "audio/wav" };
  } finally {
    clearTimeout(timer);
  }
}
