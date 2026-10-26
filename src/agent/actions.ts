import type { UpsertMemeInput } from "../memes/repository.js";
import type { ImagePart } from "../ports/model.js";

export type MemorySavePayload = {
  conversationId: string;
  personId?: string;
  content: string;
  tags: string[];
  importance: number;
  scope: "member" | "group";
  kind: string;
};

export type ImageSavePayload = {
  conversationId: string;
  uploaderPersonId: string;
  sourceMsgId: string;
  /** 历史缓存 key，当前消息是 messageId，引用图片是 messageId#quoted */
  cacheKey: string;
  /** 当前消息里的第几张图，1 开始 */
  imageIndex: number;
  url: string;
  category: "image" | "sticker" | "meme";
  caption: string;
  emotion: string | null;
  tags: string[];
};

export type ImageUpdatePayload = {
  id: number;
  /** 发起修改的会话，改回普通图片时归这个群 */
  conversationId: string;
  category: string;
  caption: string;
  emotion: string | null;
  tags: string[];
};

export type DeferredPayload =
  | { kind: "memory_save"; payload: MemorySavePayload }
  | { kind: "image_save"; payload: ImageSavePayload }
  | { kind: "image_update"; payload: ImageUpdatePayload }
  | { kind: "image_delete"; payload: { id: number; conversationId: string } }
  | { kind: "meme_use"; payload: { keyword: string } }
  | { kind: "meme_upsert"; payload: UpsertMemeInput }
  | { kind: "meme_delete"; payload: { keyword: string } }
  | { kind: "meme_set_status"; payload: { keyword: string; status: "active" | "outdated" } }
  | { kind: "meme_set_heat"; payload: { keyword: string; heat: number } };

export type DeferredAction = DeferredPayload & { expiresAt: number };

export type ToolExecutionResult = {
  content: string;
  actions?: DeferredAction[];
  /** 工具打开的历史图片，由 graph 作为下一条 user 消息带给模型 */
  images?: ImagePart[];
};
