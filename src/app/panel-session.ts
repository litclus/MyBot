import { randomBytes } from "node:crypto";

export const PANEL_SESSION_TTL_MS = 10 * 60 * 1000;

export type PanelSession = {
  token: string;
  expiresAt: number;
};

export class PanelSessions {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = PANEL_SESSION_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(): PanelSession {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(token, expiresAt);
    return { token, expiresAt };
  }

  expiresAt(token: string | null | undefined): number | null {
    if (!token) return null;
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return null;
    if (this.now() >= expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return expiresAt;
  }

  delete(token: string | null | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.sessions) {
      if (now >= expiresAt) this.sessions.delete(token);
    }
  }
}
