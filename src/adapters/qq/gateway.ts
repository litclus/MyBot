import WebSocket from "ws";
import type { RawData } from "ws";
import type { Logger } from "../../app/logger.js";
import { logger as defaultLogger } from "../../app/logger.js";
import type { QqApi } from "./api.js";
import type { QqAuth } from "./auth.js";

export type QqGatewayOptions = {
  auth: QqAuth;
  api: QqApi;
  intents: number;
  onEvent: (type: string, data: unknown) => Promise<void> | void;
  /** READY 后拿到机器人自己的 id/昵称 */
  onReady?: (user: { id?: string; username?: string }) => void;
  logger?: Logger;
};

type GatewayPayload = {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
};

const HEARTBEAT_TIMEOUT_FACTOR = 2.5;
const MAX_BACKOFF_MS = 30_000;

/**
 * QQ 网关 WebSocket 客户端。
 *
 * 负责 hello / identify / 心跳 / resume / 重连，把 op=0 的业务事件交给 onEvent。
 * 业务层不需要关心 opcode。
 */
export class QqGateway {
  private socket: WebSocket | undefined;
  private sessionId: string | undefined;
  private lastSeq: number | null = null;
  private lastAckAt = 0;
  private heartbeatIntervalMs = 45_000;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private stopped = false;
  private connected = false;
  private readonly log: Logger;

  constructor(private readonly options: QqGatewayOptions) {
    this.log = options.logger ?? defaultLogger;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("QQ gateway 在超时前没有 READY");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "shutdown");
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const url = await this.options.api.getGatewayUrl();
      this.log.info("gateway connecting", url);
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.on("open", () => this.log.info("gateway socket open"));
      socket.on("message", (data) => void this.handleMessage(data));
      socket.on("error", (error) => this.log.error("gateway socket error", error));
      socket.on("close", (code, reason) => {
        this.log.warn("gateway socket closed", code, reason.toString());
        this.onClose();
      });
    } catch (error) {
      this.log.error("gateway connect failed", error);
      this.scheduleReconnect();
    }
  }

  private async handleMessage(raw: RawData): Promise<void> {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw.toString()) as GatewayPayload;
    } catch (error) {
      this.log.error("gateway bad payload", error);
      return;
    }

    if (typeof payload.s === "number") this.lastSeq = payload.s;

    switch (payload.op) {
      case 10: {
        const d = payload.d as { heartbeat_interval?: number } | undefined;
        this.heartbeatIntervalMs = d?.heartbeat_interval ?? 45_000;
        this.lastAckAt = Date.now();
        this.startHeartbeat();
        if (this.sessionId && this.lastSeq !== null) {
          await this.resume();
        } else {
          await this.identify();
        }
        break;
      }
      case 0: {
        if (payload.t === "READY") {
          const d = payload.d as
            | { session_id?: string; user?: { id?: string; username?: string } }
            | undefined;
          this.sessionId = d?.session_id;
          this.connected = true;
          this.reconnectAttempts = 0;
          this.log.info("gateway READY", this.sessionId);
          if (d?.user) {
            try {
              this.options.onReady?.(d.user);
            } catch (error) {
              this.log.warn("onReady callback failed", error);
            }
          }
        } else if (payload.t === "RESUMED") {
          this.connected = true;
          this.reconnectAttempts = 0;
          this.log.info("gateway RESUMED");
        } else if (payload.t) {
          try {
            await this.options.onEvent(payload.t, payload.d);
          } catch (error) {
            this.log.error("gateway event handler failed", payload.t, error);
          }
        }
        break;
      }
      case 1:
        this.sendHeartbeat();
        break;
      case 11:
        this.lastAckAt = Date.now();
        break;
      case 7:
        this.log.warn("gateway asks reconnect");
        this.reconnect();
        break;
      case 9:
        this.log.warn("gateway invalid session");
        this.sessionId = undefined;
        this.lastSeq = null;
        this.reconnect();
        break;
      default:
        this.log.debug("gateway unhandled op", payload.op);
    }
  }

  private async identify(): Promise<void> {
    try {
      const token = await this.options.auth.getToken();
      this.send({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: this.options.intents,
          shard: [0, 1],
          properties: {
            $os: process.platform,
            $browser: "mybot",
            $device: "mybot",
          },
        },
      });
      this.log.info("gateway identify sent");
    } catch (error) {
      this.log.error("gateway identify failed", error);
      this.reconnect();
    }
  }

  private async resume(): Promise<void> {
    try {
      const token = await this.options.auth.getToken();
      this.send({
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.lastSeq,
        },
      });
      this.log.info("gateway resume sent");
    } catch (error) {
      this.log.error("gateway resume failed", error);
      this.reconnect();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastAckAt > this.heartbeatIntervalMs * HEARTBEAT_TIMEOUT_FACTOR) {
        this.log.warn("gateway heartbeat timeout");
        this.reconnect();
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeat(): void {
    this.send({ op: 1, d: this.lastSeq });
  }

  private send(payload: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private onClose(): void {
    this.connected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.socket = undefined;
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private reconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (socket) {
      try {
        socket.close(4000, "reconnect");
      } catch {
        socket.terminate();
      }
    } else {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      MAX_BACKOFF_MS,
      1000 * 2 ** Math.min(this.reconnectAttempts, 5) + Math.floor(Math.random() * 500),
    );
    this.log.info(`gateway reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}
