import type { QqAuth } from "./auth.js";
import type { QqGroupMember } from "./types.js";

export type QqApiOptions = {
  auth: QqAuth;
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

/**
 * QQ 开放平台 HTTP API 的最小封装。
 * 只覆盖当前用到的：取 gateway、发群文本消息。
 */
export class QqApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QqApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getGatewayUrl(): Promise<string> {
    const data = await this.request<{ url?: string; data?: { url?: string } }>("GET", "/gateway");
    const url = data.url ?? data.data?.url;
    if (!url) throw new Error("gateway 响应里没有 url");
    return url;
  }

  async sendGroupText(input: {
    groupOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      content: input.content,
      msg_type: 0,
    };
    if (input.msgId) body.msg_id = input.msgId;
    if (input.msgSeq !== undefined) body.msg_seq = input.msgSeq;
    await this.request(
      "POST",
      `/v2/groups/${encodeURIComponent(input.groupOpenid)}/messages`,
      body,
    );
  }

  async sendC2CText(input: {
    userOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      content: input.content,
      msg_type: 0,
    };
    if (input.msgId) body.msg_id = input.msgId;
    if (input.msgSeq !== undefined) body.msg_seq = input.msgSeq;
    await this.request(
      "POST",
      `/v2/users/${encodeURIComponent(input.userOpenid)}/messages`,
      body,
    );
  }

  async sendGroupMarkdown(input: {
    groupOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      msg_type: 2,
      markdown: { content: input.content },
    };
    if (input.msgId) body.msg_id = input.msgId;
    if (input.msgSeq !== undefined) body.msg_seq = input.msgSeq;
    await this.request(
      "POST",
      `/v2/groups/${encodeURIComponent(input.groupOpenid)}/messages`,
      body,
    );
  }

  async sendC2CMarkdown(input: {
    userOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      msg_type: 2,
      markdown: { content: input.content },
    };
    if (input.msgId) body.msg_id = input.msgId;
    if (input.msgSeq !== undefined) body.msg_seq = input.msgSeq;
    await this.request(
      "POST",
      `/v2/users/${encodeURIComponent(input.userOpenid)}/messages`,
      body,
    );
  }

  async uploadGroupFile(input: {
    groupOpenid: string;
    fileType: number;
    fileName: string;
    data: Buffer;
  }): Promise<{ fileInfo: string; ttl: number }> {
    if (input.data.length > 5_000_000) {
      throw new Error("文件超过 5MB，无法直接上传");
    }
    const raw = await this.request<Record<string, unknown>>(
      "POST",
      `/v2/groups/${encodeURIComponent(input.groupOpenid)}/files`,
      {
        file_type: input.fileType,
        file_name: input.fileName,
        file_data: input.data.toString("base64"),
        srv_send_msg: false,
      },
    );
    const data = (raw.data as Record<string, unknown> | undefined) ?? raw;
    const fileInfo = String(data.file_info ?? "");
    if (!fileInfo) throw new Error("QQ 文件上传响应缺少 file_info");
    return { fileInfo, ttl: Number(data.ttl ?? 0) };
  }

  async sendGroupMedia(input: {
    groupOpenid: string;
    fileInfo: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      msg_type: 7,
      media: { file_info: input.fileInfo },
    };
    if (input.msgId) body.msg_id = input.msgId;
    if (input.msgSeq !== undefined) body.msg_seq = input.msgSeq;
    await this.request(
      "POST",
      `/v2/groups/${encodeURIComponent(input.groupOpenid)}/messages`,
      body,
    );
  }

  async sendGroupVoice(input: {
    groupOpenid: string;
    audio: Buffer;
    fileName: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<void> {
    const uploaded = await this.uploadGroupFile({
      groupOpenid: input.groupOpenid,
      fileType: 3,
      fileName: input.fileName,
      data: input.audio,
    });
    await this.sendGroupMedia({
      groupOpenid: input.groupOpenid,
      fileInfo: uploaded.fileInfo,
      ...(input.msgId ? { msgId: input.msgId } : {}),
      ...(input.msgSeq !== undefined ? { msgSeq: input.msgSeq } : {}),
    });
  }

  async getGroupMembers(
    groupOpenid: string,
    cursor?: string,
  ): Promise<{ members: QqGroupMember[]; nextCursor?: string }> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      `/v2/groups/${encodeURIComponent(groupOpenid)}/members${suffix}`,
    );
    const data = (raw.data as Record<string, unknown> | undefined) ?? raw;
    const members = Array.isArray(data.members)
      ? (data.members as QqGroupMember[])
      : [];
    return {
      members,
      ...(typeof data.next_cursor === "string" && data.next_cursor
        ? { nextCursor: data.next_cursor }
        : {}),
    };
  }

  async prepareMediaImage(input: {
    fileName: string;
    fileSize: number;
    contentType: string;
    md5: string;
    sha1: string;
  }): Promise<{ uploadId: string; presignedUrl: string; expiresIn: number }> {
    const raw = await this.request<Record<string, unknown>>(
      "POST",
      "/v2/media-images/prepare",
      {
        file_name: input.fileName,
        file_size: input.fileSize,
        content_type: input.contentType,
        md5: input.md5,
        sha1: input.sha1,
      },
    );
    const data = (raw.data as Record<string, unknown> | undefined) ?? raw;
    const uploadId = String(data.upload_id ?? "");
    const presignedUrl = String(data.presigned_url ?? "");
    if (!uploadId || !presignedUrl) throw new Error("media prepare 响应缺少 upload_id/presigned_url");
    return {
      uploadId,
      presignedUrl,
      expiresIn: Number(data.expires_in ?? 0),
    };
  }

  async completeMediaImage(input: {
    uploadId: string;
    md5: string;
  }): Promise<{ imageId: string; url: string; ttl: number; previewUrl?: string }> {
    const raw = await this.request<Record<string, unknown>>(
      "POST",
      "/v2/media-images/complete",
      {
        upload_id: input.uploadId,
        md5: input.md5,
      },
    );
    const data = (raw.data as Record<string, unknown> | undefined) ?? raw;
    const url = String(data.url ?? "");
    if (!url) throw new Error("media complete 响应缺少 url");
    return {
      imageId: String(data.image_id ?? ""),
      url,
      ttl: Number(data.ttl ?? 0),
      ...(data.preview_url ? { previewUrl: String(data.preview_url) } : {}),
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const token = await this.options.auth.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);

      const response = await this.fetchImpl(this.options.baseUrl + path, init);
      const text = await response.text();
      const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;

      if (response.status === 401 && !retried) {
        this.options.auth.invalidate();
        return this.request<T>(method, path, body, true);
      }
      if (!response.ok) {
        throw new Error(
          `QQ API ${method} ${path} -> ${response.status}: ${String(parsed.message ?? text.slice(0, 200))}`,
        );
      }
      if (typeof parsed.code === "number" && parsed.code !== 0) {
        throw new Error(`QQ API ${method} ${path} -> code ${parsed.code}: ${String(parsed.message ?? "")}`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
