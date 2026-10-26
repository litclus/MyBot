export type QqAuthOptions = {
  appId: string;
  appSecret: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

type TokenState = {
  value: string;
  expiresAt: number;
};

/**
 * access_token 缓存。
 * 有效期 7200s；提前 60s 刷新；并发请求合并成一次。
 */
export class QqAuth {
  private token: TokenState | undefined;
  private pending: Promise<string> | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QqAuthOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    if (this.pending) return this.pending;

    this.pending = this.fetchToken(force).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  invalidate(): void {
    this.token = undefined;
  }

  private async fetchToken(force: boolean): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/app/getAppAccessToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: this.options.appId,
          clientSecret: this.options.appSecret,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      const data = JSON.parse(text) as {
        access_token?: string;
        expires_in?: number | string;
        code?: number;
        message?: string;
      };

      if (!response.ok || !data.access_token) {
        throw new Error(
          `获取 access_token 失败 (${response.status}): ${data.message ?? text.slice(0, 200)}`,
        );
      }

      const expiresIn = Number(data.expires_in ?? 7200);
      const ttl = Number.isFinite(expiresIn) ? expiresIn : 7200;
      this.token = {
        value: data.access_token,
        expiresAt: Date.now() + Math.max(ttl - 60, 30) * 1000,
      };
      if (force) this.token.expiresAt = Date.now() + Math.max(ttl - 60, 30) * 1000;
      return this.token.value;
    } finally {
      clearTimeout(timer);
    }
  }
}
