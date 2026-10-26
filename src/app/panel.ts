import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Logger } from "../app/logger.js";
import { config } from "../config.js";
import {
  deleteRuntimeSetting,
  panelSettings,
  saveRuntimeSettings,
} from "../settings/store.js";
import { PANEL_SESSION_TTL_MS, PanelSessions } from "./panel-session.js";
import { DATA_HTML } from "./admin-data.js";
import {
  createAdminImage,
  deleteAdminImage,
  deleteAdminMeme,
  getAdminImageContent,
  listAdminImages,
  listAdminMemes,
  listAdminMemories,
  updateAdminImage,
  updateAdminMeme,
  type AdminMemeUpdate,
} from "../db/admin.js";

export type PanelOptions = {
  host: string;
  port: number;
  logger: Logger;
  onApplied?: (changed: string[]) => void;
};

const SESSION_COOKIE = "mybot_session";
const SESSION_MAX_AGE_SECONDS = Math.floor(PANEL_SESSION_TTL_MS / 1000);

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      cookies.set(name, raw);
    }
  }
  return cookies;
}

function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}`;
}

function sameSecret(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseLogin(raw: string, contentType: string | undefined): { user: string; password: string } {
  if (contentType?.includes("application/json")) {
    try {
      const data = JSON.parse(raw) as { user?: unknown; password?: unknown };
      return {
        user: typeof data.user === "string" ? data.user : "",
        password: typeof data.password === "string" ? data.password : "",
      };
    } catch {
      return { user: "", password: "" };
    }
  }
  const form = new URLSearchParams(raw);
  return { user: form.get("user") ?? "", password: form.get("password") ?? "" };
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

function redirect(response: import("node:http").ServerResponse, location: string): void {
  response.writeHead(303, { ...HTML_HEADERS, Location: location });
  response.end();
}

async function readBody(
  request: import("node:http").IncomingMessage,
  maxBytes = 1_000_000,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function startPanelServer(options: PanelOptions): Server {
  const sessions = new PanelSessions();
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    const parsedUrl = new URL(url, "http://localhost");
    const path = parsedUrl.pathname;

    try {
      if (path === "/login" && request.method === "GET") {
        const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
        if (sessions.expiresAt(token)) {
          redirect(response, "/admin");
          return;
        }
        response.writeHead(200, HTML_HEADERS);
        response.end(
          loginPage(
            undefined,
            parsedUrl.searchParams.has("expired") ? "登录已过期，请重新登录" : undefined,
          ),
        );
        return;
      }

      if (path === "/login" && request.method === "POST") {
        const raw = await readBody(request);
        const { user, password } = parseLogin(raw, request.headers["content-type"]);
        const userOk = sameSecret(user, config.PANEL_USER);
        const passwordOk = sameSecret(password, config.PANEL_PASSWORD);
        if (userOk && passwordOk) {
          const previous = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
          sessions.delete(previous);
          const session = sessions.create();
          response.writeHead(303, {
            ...HTML_HEADERS,
            Location: "/admin",
            "Set-Cookie": sessionCookie(session.token, SESSION_MAX_AGE_SECONDS),
          });
          response.end();
          options.logger.info("panel login", { expiresAt: session.expiresAt });
        } else {
          options.logger.warn("panel login failed");
          response.writeHead(401, HTML_HEADERS);
          response.end(loginPage("账号或密码错误"));
        }
        return;
      }

      if (path === "/logout") {
        sessions.delete(parseCookies(request.headers.cookie).get(SESSION_COOKIE));
        response.writeHead(303, {
          ...HTML_HEADERS,
          Location: "/login",
          "Set-Cookie": sessionCookie("", 0),
        });
        response.end();
        return;
      }

      const session = sessions.expiresAt(
        parseCookies(request.headers.cookie).get(SESSION_COOKIE),
      );
      if (!session) {
        if (path.startsWith("/api/")) {
          response.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify({ error: "登录已过期" }));
        } else {
          redirect(response, "/login");
        }
        return;
      }

      if (path === "/" || path === "/admin") {
        response.writeHead(200, HTML_HEADERS);
        response.end(PANEL_HTML);
        return;
      }

      if (path === "/admin/data" && request.method === "GET") {
        response.writeHead(200, HTML_HEADERS);
        response.end(DATA_HTML);
        return;
      }

      const rawLimit = Number(parsedUrl.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;

      if (path === "/api/data/images" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ items: await listAdminImages(limit) }));
        return;
      }

      if (path === "/api/data/memes" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ items: await listAdminMemes(limit) }));
        return;
      }

      if (path === "/api/data/memories" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ items: await listAdminMemories(limit) }));
        return;
      }

      if (path === "/api/data/images" && request.method === "DELETE") {
        const id = Number(parsedUrl.searchParams.get("id"));
        if (!Number.isInteger(id) || id <= 0) throw new Error("图片 id 不合法");
        const deleted = await deleteAdminImage(id);
        if (!deleted) throw new Error(`没有找到图片 #${id}`);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (path === "/api/data/images" && request.method === "PATCH") {
        const raw = await readBody(request);
        const body = JSON.parse(raw) as Record<string, unknown>;
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) throw new Error("图片 id 不合法");

        const updated = await updateAdminImage(id, {
          ...(typeof body.category === "string" ? { category: body.category } : {}),
          ...(typeof body.caption === "string" ? { caption: body.caption } : {}),
          ...(typeof body.emotion === "string" ? { emotion: body.emotion } : {}),
          ...(Array.isArray(body.tags)
            ? {
                tags: body.tags
                  .filter((item): item is string => typeof item === "string")
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, 5),
              }
            : {}),
        });
        if (!updated) throw new Error(`没有找到图片 #${id}`);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (path === "/api/data/images" && request.method === "POST") {
        const raw = await readBody(request, 25_000_000);
        const body = JSON.parse(raw) as Record<string, unknown>;
        const mime = typeof body.mime === "string" ? body.mime : "";
        const encoded = typeof body.data === "string" ? body.data : "";
        const category = body.category;
        const caption = typeof body.caption === "string" ? body.caption : "";
        if (!mime.startsWith("image/")) throw new Error("只支持图片文件");
        if (category !== "sticker" && category !== "meme") {
          throw new Error("上传只能选 sticker 或 meme");
        }
        if (!encoded) throw new Error("缺少图片数据");
        if (!caption.trim()) throw new Error("caption 不能为空");

        const data = Buffer.from(encoded, "base64");
        if (data.length === 0) throw new Error("图片数据为空");
        if (data.length > 10 * 1024 * 1024) throw new Error("图片不能超过 10MB");

        const result = await createAdminImage({
          data,
          mime,
          category,
          caption,
          emotion: typeof body.emotion === "string" ? body.emotion : null,
          tags: Array.isArray(body.tags)
            ? body.tags
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 5)
            : [],
        });
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, ...result }));
        return;
      }

      if (path === "/api/data/memes" && request.method === "DELETE") {
        const keyword = parsedUrl.searchParams.get("keyword") ?? "";
        if (!keyword) throw new Error("缺少 keyword");
        const deleted = await deleteAdminMeme(keyword);
        if (!deleted) throw new Error(`没有找到梗：${keyword}`);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (path === "/api/data/memes" && request.method === "PATCH") {
        const raw = await readBody(request);
        const body = JSON.parse(raw) as Record<string, unknown>;
        const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
        if (!keyword) throw new Error("缺少 keyword");

        const update: AdminMemeUpdate = {};
        if (typeof body.title === "string" && body.title.trim()) {
          update.title = body.title.trim().slice(0, 200);
        }
        if (typeof body.meaning === "string" && body.meaning.trim()) {
          update.meaning = body.meaning.trim().slice(0, 1000);
        }
        if (typeof body.replyGuide === "string" && body.replyGuide.trim()) {
          update.replyGuide = body.replyGuide.trim().slice(0, 1000);
        }
        if (Array.isArray(body.aliases)) {
          update.aliases = body.aliases
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 10);
        }
        if (Array.isArray(body.tags)) {
          update.tags = body.tags
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 10);
        }
        if (Array.isArray(body.examples)) {
          update.examples = body.examples
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            .map((item) => ({
              input: typeof item.input === "string" ? item.input.trim() : "",
              reply: typeof item.reply === "string" ? item.reply.trim() : "",
            }))
            .filter((item) => item.input && item.reply)
            .slice(0, 5);
        }
        if (typeof body.heat === "number" && Number.isFinite(body.heat)) {
          update.heat = body.heat;
        }
        if (body.status === "active" || body.status === "outdated") {
          update.status = body.status;
        }

        const updated = await updateAdminMeme(keyword, update);
        if (!updated) throw new Error(`没有找到梗：${keyword}`);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      const imageContent = path.match(/^\/api\/images\/(\d+)\/content$/);
      if (imageContent && request.method === "GET") {
        const id = Number(imageContent[1]);
        const image = await getAdminImageContent(id);
        if (!image) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("not found");
          return;
        }
        response.writeHead(200, {
          "Content-Type": image.mime,
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(image.data);
        return;
      }

      if (path === "/api/settings" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify({
            settings: panelSettings(),
            session: { expiresAt: session, ttlSeconds: SESSION_MAX_AGE_SECONDS },
          }),
        );
        return;
      }

      if (path === "/api/settings" && request.method === "POST") {
        const raw = await readBody(request);
        const body = JSON.parse(raw) as unknown;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("请求体必须是对象");
        }
        const result = await saveRuntimeSettings(body as Record<string, unknown>);
        options.onApplied?.(result.changed);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify({
            ...result,
            session: { expiresAt: session, ttlSeconds: SESSION_MAX_AGE_SECONDS },
          }),
        );
        return;
      }

      if (path === "/api/settings" && request.method === "DELETE") {
        const key = parsedUrl.searchParams.get("key") ?? "";
        if (!key) throw new Error("缺少 key");
        const reset = await deleteRuntimeSetting(key);
        options.onApplied?.(reset ? [key] : []);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify({
            reset,
            key,
            session: { expiresAt: session, ttlSeconds: SESSION_MAX_AGE_SECONDS },
          }),
        );
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn("panel request failed", url, error);
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(options.port, options.host, () => {
    options.logger.info(`panel on http://${options.host}:${options.port}/admin`);
  });
  return server;
}

function loginPage(error?: string, notice?: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyBot · 登录</title>
<style>
:root{
  color-scheme:light dark;
  --bg:#f4f5f7;--fg:#171a1f;--muted:#68707c;--line:#dfe3e9;--card:#ffffff;
  --accent:#3056d3;--accent2:#7c3aed;--danger:#b42318;--danger-bg:#fef3f2;
  --ok:#18794e;--ok-bg:#ecfdf3;
  --shadow:0 24px 70px rgba(20,30,50,.13),0 4px 14px rgba(20,30,50,.06);
}
@media(prefers-color-scheme:dark){
  :root{--bg:#0d1015;--fg:#e7eaf0;--muted:#99a2ae;--line:#2a313b;--card:#151a22;
  --accent:#7c9cff;--accent2:#b38cff;--danger:#ff8a80;--danger-bg:#2a1517;
  --ok:#6ee7b7;--ok-bg:#10241d;--shadow:0 28px 80px rgba(0,0,0,.5)}
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:
  radial-gradient(760px 420px at 18% 0%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 70%),
  radial-gradient(680px 420px at 88% 12%,color-mix(in srgb,var(--accent2) 11%,transparent),transparent 70%),
  var(--bg);
  color:var(--fg);font:14px/1.55 var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);
  display:grid;place-items:center;padding:28px 18px;min-height:100vh}
.card{width:100%;max-width:372px;background:color-mix(in srgb,var(--card) 94%,transparent);
  border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);padding:30px 28px 24px;
  backdrop-filter:blur(18px)}
.brand{display:flex;flex-direction:column;align-items:center;gap:12px;margin-bottom:22px}
.logo{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,var(--accent),var(--accent2));
  box-shadow:0 10px 26px color-mix(in srgb,var(--accent) 30%,transparent);position:relative}
.logo:after{content:"";position:absolute;inset:12px;border:2px solid rgba(255,255,255,.94);border-radius:9px}
h1{font-size:19px;margin:0;letter-spacing:.01em}
.sub{margin:2px 0 0;color:var(--muted);font-size:12px}
.alert{border:1px solid var(--line);border-radius:10px;padding:9px 11px;font-size:12.5px;margin:0 0 15px}
.alert.error{color:var(--danger);background:var(--danger-bg);border-color:color-mix(in srgb,var(--danger) 26%,transparent)}
.alert.notice{color:var(--ok);background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 24%,transparent)}
label{display:flex;flex-direction:column;gap:7px;margin:0 0 14px;font-size:12px;color:var(--muted);font-weight:500}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--bg) 55%,transparent);
  color:var(--fg);font:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
button{width:100%;margin-top:4px;border:0;border-radius:10px;padding:11px 16px;font:inherit;font-weight:600;color:#fff;cursor:pointer;
  background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 10px 24px color-mix(in srgb,var(--accent) 26%,transparent)}
button:active{transform:translateY(1px)}
.foot{margin:18px 0 0;text-align:center;color:var(--muted);font-size:11.5px}
</style>
</head>
<body>
<form class="card" method="post" action="/login" autocomplete="on">
  <div class="brand">
    <div class="logo"></div>
    <div>
      <h1>MyBot</h1>
      <p class="sub">控制台登录</p>
    </div>
  </div>
  ${notice ? `<div class="alert notice">${escapeHtml(notice)}</div>` : ""}
  ${error ? `<div class="alert error">${escapeHtml(error)}</div>` : ""}
  <label>账号<input name="user" autocomplete="username" autofocus required></label>
  <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">登录</button>
  <p class="foot">登录有效期 10 分钟 超时后需要重新登录</p>
</form>
</body>
</html>`;
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyBot · 控制面板</title>
<style>
:root{
  color-scheme:light dark;
  --bg:#f4f5f7;--bg2:#eef1f5;--fg:#171a1f;--muted:#68707c;--line:#dfe3e9;--card:#ffffff;
  --soft:#f7f8fa;--accent:#3056d3;--accent2:#7c3aed;--ok:#18794e;--warn:#9a5b00;
  --danger:#b42318;--shadow:0 12px 34px rgba(20,30,50,.08),0 2px 6px rgba(20,30,50,.04);
}
@media(prefers-color-scheme:dark){
  :root{--bg:#0d1015;--bg2:#11151c;--fg:#e7eaf0;--muted:#99a2ae;--line:#262c36;--card:#151a22;
  --soft:#10151c;--accent:#7c9cff;--accent2:#b38cff;--ok:#6ee7b7;--warn:#f3c26b;--danger:#ff8a80;
  --shadow:0 18px 44px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.25)}
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:
  radial-gradient(900px 420px at 12% -10%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 70%),
  radial-gradient(700px 380px at 92% 0%,color-mix(in srgb,var(--accent2) 8%,transparent),transparent 70%),
  var(--bg);
  color:var(--fg);font:14px/1.5 var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif)}
header{position:sticky;top:0;z-index:5;backdrop-filter:blur(18px);background:color-mix(in srgb,var(--bg) 82%,transparent);border-bottom:1px solid var(--line)}
.top{max-width:1160px;margin:0 auto;padding:18px 26px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;min-width:190px}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 8px 20px color-mix(in srgb,var(--accent) 28%,transparent);position:relative}
.logo:after{content:"";position:absolute;inset:9px;border:2px solid rgba(255,255,255,.92);border-radius:7px}
h1{font-size:16px;margin:0;letter-spacing:.01em}.sub{font-size:12px;color:var(--muted);margin-top:1px}
.search{margin-left:auto;position:relative;width:min(330px,100%)}
.search input{width:100%;padding:9px 13px 9px 34px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--card) 78%,transparent);color:var(--fg);font:inherit;outline:none}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:var(--muted)}
.session{display:flex;align-items:center;gap:8px}
.session .pill.low{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 30%,transparent);background:color-mix(in srgb,var(--warn) 8%,transparent)}
.session .pill.low .dot{background:var(--warn)}
.logout-form{margin:0}
button.ghost.small{padding:6px 11px;font-size:12px}
main{max-width:1160px;margin:0 auto;padding:22px 26px 92px}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:2px 0 18px}
.hero h2{font-size:20px;margin:0}.hero p{margin:5px 0 0;color:var(--muted);font-size:12.5px;max-width:680px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:11.5px;background:color-mix(in srgb,var(--card) 65%,transparent)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
.group{border:1px solid var(--line);background:color-mix(in srgb,var(--card) 94%,transparent);border-radius:16px;box-shadow:var(--shadow);margin:14px 0;overflow:visible}
.group-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);border-radius:15px 15px 0 0;background:linear-gradient(180deg,color-mix(in srgb,var(--soft) 70%,transparent),transparent)}
.group-icon{width:27px;height:27px;border-radius:8px;display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--accent);background:color-mix(in srgb,var(--accent) 11%,transparent);border:1px solid color-mix(in srgb,var(--accent) 18%,transparent)}
.group h3{font-size:12.5px;margin:0;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px;padding:16px}
.field{display:flex;flex-direction:column;gap:7px;min-width:0}
.label{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px;color:var(--muted);font-weight:500}
.badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:10px;line-height:1.6;background:var(--soft);border:1px solid var(--line);color:var(--muted)}
.badge.restart{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 25%,transparent);background:color-mix(in srgb,var(--warn) 9%,transparent)}
.badge.secret{color:var(--accent2);border-color:color-mix(in srgb,var(--accent2) 24%,transparent);background:color-mix(in srgb,var(--accent2) 8%,transparent)}
.badge.reset{cursor:pointer;font:inherit;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 24%,transparent);background:color-mix(in srgb,var(--accent) 7%,transparent)}
.badge.reset:hover{color:var(--fg);border-color:var(--accent)}
.control,textarea,input[type=text],input[type=number]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--card) 88%,transparent);color:var(--fg);font:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.control:focus,textarea:focus,input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.hint{font-size:11px;color:var(--muted)}
.dropdown{position:relative;width:100%}
.dropdown .select{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--card) 88%,transparent);color:var(--fg);font:inherit;text-align:left;cursor:pointer;outline:none;transition:border-color .15s,box-shadow .15s}
.dropdown .select:hover{border-color:color-mix(in srgb,var(--muted) 42%,var(--line))}
.dropdown.open .select,.dropdown .select:focus-visible{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.select-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dropdown .select svg{width:14px;height:14px;flex:none;color:var(--muted);transition:transform .16s ease}
.dropdown.open .select svg{transform:rotate(180deg)}
.select-menu{position:absolute;z-index:30;top:calc(100% + 6px);left:0;right:0;padding:5px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 44px rgba(10,15,30,.18),0 3px 10px rgba(10,15,30,.08);max-height:260px;overflow:auto;animation:select-pop .13s ease-out}
@media(prefers-color-scheme:dark){.select-menu{box-shadow:0 20px 50px rgba(0,0,0,.55),0 3px 10px rgba(0,0,0,.35)}}
.select-menu[hidden]{display:none}
.dropdown.up .select-menu{top:auto;bottom:calc(100% + 6px)}
.select-option{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:8px 9px;border:0;border-radius:8px;background:transparent;color:var(--fg);font:inherit;text-align:left;cursor:pointer;outline:none}
.select-option:hover,.select-option:focus-visible{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.select-option.selected{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-weight:600}
.select-option.selected::after{content:"✓";font-size:11px;line-height:1}
@keyframes select-pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.dropdown.up .select-menu{animation-name:select-pop-up}
@keyframes select-pop-up{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.tags{display:flex;flex-wrap:wrap;gap:6px;min-height:39px;padding:6px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--card) 88%,transparent)}
.tags:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.chip{display:inline-flex;align-items:center;gap:5px;padding:3px 7px 3px 9px;border-radius:7px;background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid color-mix(in srgb,var(--accent) 18%,transparent);color:var(--fg);font-size:12px}
.chip button{border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0 1px}
.chip button:hover{color:var(--danger)}
.tags input{flex:1;min-width:100px;border:0;background:transparent;padding:4px 5px;outline:none;color:var(--fg);font:inherit}
footer{position:fixed;left:0;right:0;bottom:0;z-index:6;border-top:1px solid var(--line);background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(18px)}
.footer-inner{max-width:1160px;margin:0 auto;padding:11px 26px;display:flex;align-items:center;gap:12px}
.status{font-size:12px;color:var(--muted);margin-right:auto;min-height:18px}
.status.error{color:var(--danger)}.status.ok{color:var(--ok)}
button.primary{border:0;border-radius:10px;padding:9px 18px;font:inherit;font-weight:600;color:#fff;cursor:pointer;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 8px 20px color-mix(in srgb,var(--accent) 24%,transparent)}
button.primary:disabled{opacity:.42;cursor:default;box-shadow:none}
button.ghost{border:1px solid var(--line);border-radius:10px;padding:8px 14px;font:inherit;color:var(--muted);background:transparent;cursor:pointer}
button.ghost:hover{color:var(--fg);border-color:var(--muted)}
.empty{padding:50px 0;text-align:center;color:var(--muted)}
@media(max-width:640px){.top{padding:14px 16px}.search{width:100%;margin-left:0}.session{width:100%;justify-content:flex-end}.hero{display:block}main{padding:16px 16px 92px}.grid{padding:12px;gap:12px}.footer-inner{padding:10px 16px}h1{font-size:15px}}
</style>
</head>
<body>
<header>
  <div class="top">
    <div class="brand"><div class="logo"></div><div><h1>MyBot</h1><div class="sub">Control Center</div></div></div>
    <div class="search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
      <input id="search" placeholder="搜索配置项…" autocomplete="off">
    </div>
    <div class="session">
      <span id="session" class="pill"><span class="dot"></span><span id="session-text">登录中</span></span>
      <button class="ghost small" type="button" onclick="location.href='/admin/data'">数据</button>
      <form class="logout-form" method="post" action="/logout"><button class="ghost small" type="submit">退出</button></form>
    </div>
  </div>
</header>
<main>
  <div class="hero">
    <div><h2>配置中心</h2><p>运行配置保存在数据库，保存后立即应用。标记「重启」的项需要重启进程。</p></div>
    <div class="pill"><span class="dot"></span><span id="count">加载中</span></div>
  </div>
  <div id="app"></div>
</main>
<footer><div class="footer-inner"><span id="status" class="status"></span><button id="reset" class="ghost">还原</button><button id="save" class="primary" disabled>保存修改</button></div></footer>
<script>
const app = document.querySelector('#app');
const statusEl = document.querySelector('#status');
const saveBtn = document.querySelector('#save');
const resetBtn = document.querySelector('#reset');
const search = document.querySelector('#search');
const countEl = document.querySelector('#count');
const sessionEl = document.querySelector('#session');
const sessionText = document.querySelector('#session-text');
let settings = [];
let original = new Map();
let expiresAt = 0;

const serialize = (value) => JSON.stringify(value);
const getValue = (el) => {
  if (el._get) return el._get();
  if (el._tags) return [...el._tags];
  if (el.dataset.kind === 'boolean') return el.value === 'true';
  if (el.dataset.kind === 'number') return Number(el.value);
  return el.value;
};

function markDirty(){
  let dirty = false;
  for(const el of document.querySelectorAll('[data-key]')){
    if(el.dataset.secret === '1' && el.value === '') continue;
    if(original.get(el.dataset.key) !== serialize(getValue(el))){ dirty = true; break; }
  }
  saveBtn.disabled = !dirty;
  if(dirty){ statusEl.className = 'status'; statusEl.textContent = '有未保存的修改'; }
  else if(!statusEl.classList.contains('ok') && !statusEl.classList.contains('error')) statusEl.textContent = '';
}

function tagEditor(def, wrap){
  const tags = Array.isArray(def.value) ? [...def.value] : [];
  const box = document.createElement('div'); box.className = 'tags';
  const input = document.createElement('input'); input.placeholder = '输入后回车';
  const render = () => {
    box.querySelectorAll('.chip').forEach(node => node.remove());
    for(const tag of tags){
      const chip = document.createElement('span'); chip.className = 'chip';
      chip.append(document.createTextNode(tag));
      const remove = document.createElement('button'); remove.type='button'; remove.textContent='×';
      remove.onclick = () => { tags.splice(tags.indexOf(tag),1); render(); markDirty(); };
      chip.append(remove); box.insertBefore(chip, input);
    }
  };
  const add = () => {
    const value = input.value.trim().replace(/,$/,'');
    if(!value) return;
    for(const item of value.split(',').map(s=>s.trim()).filter(Boolean)){
      if(!tags.includes(item)) tags.push(item);
    }
    input.value=''; render(); markDirty();
  };
  input.onkeydown = (event) => {
    if(event.key === 'Enter' || event.key === ',' || event.key === '，'){ event.preventDefault(); add(); }
    if(event.key === 'Backspace' && !input.value && tags.length){ tags.pop(); render(); markDirty(); }
  };
  input.onblur = add;
  box.append(input); wrap.append(box);
  input._tags = tags;
  input._get = () => [...tags];
  input._tagsOwner = { get: () => tags };
  render();
  return input;
}

const SECRET_MASK = '∗';
const OPTION_LABELS = { debug: '调试', info: '信息', warn: '警告', error: '错误' };

function closeDropdowns(except){
  for(const root of document.querySelectorAll('.dropdown.open')){
    if(root === except) continue;
    root.classList.remove('open','up');
    const button = root.querySelector('.select');
    const menu = root.querySelector('.select-menu');
    if(button) button.setAttribute('aria-expanded','false');
    if(menu) menu.hidden = true;
  }
}

document.addEventListener('click', (event) => {
  if(event.target instanceof Element && event.target.closest('.dropdown')) return;
  closeDropdowns();
});

function dropdown(def, entries){
  const root = document.createElement('div');
  root.className = 'dropdown';
  root.dataset.key = def.key;
  root.dataset.kind = def.kind;
  root.dataset.secret = def.secret ? '1' : '0';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'select';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');

  const label = document.createElement('span');
  label.className = 'select-label';
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', 'currentColor');
  chevron.setAttribute('stroke-width', '2');
  chevron.setAttribute('stroke-linecap', 'round');
  chevron.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  chevron.append(path);
  button.append(label, chevron);

  const menu = document.createElement('div');
  menu.className = 'select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  let current = String(def.kind === 'boolean' ? Boolean(def.value) : def.value ?? '');
  if(!entries.some(entry => entry.value === current)) current = entries[0]?.value ?? '';
  let openedAt = 0;

  const items = entries.map((entry) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'select-option';
    item.setAttribute('role', 'option');
    item.dataset.value = entry.value;
    item.textContent = entry.label;
    item.onclick = (event) => {
      event.stopPropagation();
      const changed = current !== entry.value;
      current = entry.value;
      sync();
      close();
      button.focus();
      if(changed) markDirty();
    };
    menu.append(item);
    return item;
  });

  function sync(){
    const entry = entries.find(item => item.value === current);
    label.textContent = entry ? entry.label : current;
    for(const item of items){
      const selected = item.dataset.value === current;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  function close(){
    root.classList.remove('open', 'up');
    button.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
  }

  function open(focus = 'none'){
    closeDropdowns(root);
    openedAt = Date.now();
    root.classList.add('open');
    button.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    const target = focus === 'first'
      ? items[0]
      : focus === 'last'
        ? items[items.length - 1]
        : focus === 'selected'
          ? items.find(item => item.dataset.value === current) ?? items[0]
          : null;
    target?.focus();
    if(menu.getBoundingClientRect().bottom > window.innerHeight - 12) root.classList.add('up');
  }

  button.onclick = (event) => {
    event.stopPropagation();
    if(root.classList.contains('open')){
      if(Date.now() - openedAt < 250) return;
      close();
      button.focus();
    }
    else open();
  };
  button.onkeydown = (event) => {
    if(event.key === 'ArrowDown' || event.key === 'ArrowUp'){
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 'first' : 'last');
    }
    if(event.key === 'Escape'){ close(); }
  };
  menu.onclick = (event) => { event.stopPropagation(); };
  menu.onkeydown = (event) => {
    if(event.key === 'Escape'){ event.preventDefault(); close(); button.focus(); return; }
    if(event.key === 'ArrowDown' || event.key === 'ArrowUp'){
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
      items[next]?.focus();
    }
    if(event.key === 'Home'){ event.preventDefault(); items[0]?.focus(); }
    if(event.key === 'End'){ event.preventDefault(); items[items.length - 1]?.focus(); }
  };

  root._get = () => def.kind === 'boolean' ? current === 'true' : current;
  root.append(button, menu);
  sync();
  return root;
}

function field(def){
  const wrap = document.createElement('div'); wrap.className='field';
  const label = document.createElement('div'); label.className='label';
  label.append(document.createTextNode(def.label));
  if(def.restart){ const b=document.createElement('span'); b.className='badge restart'; b.textContent='重启'; label.append(b); }
  if(def.secret){ const b=document.createElement('span'); b.className='badge secret'; b.textContent='密钥'; label.append(b); }
  const defaultBtn = document.createElement('button');
  defaultBtn.type='button'; defaultBtn.className='badge reset'; defaultBtn.textContent='默认';
  defaultBtn.onclick = () => resetSetting(def.key);
  label.append(defaultBtn);
  wrap.append(label);

  if(def.hint){ const hint=document.createElement('div'); hint.className='hint'; hint.textContent=def.hint; wrap.append(hint); }

  if(def.kind === 'string[]'){
    const input = tagEditor(def, wrap);
    input.dataset.key = def.key;
    input.dataset.kind = def.kind;
    input.dataset.secret = def.secret ? '1' : '0';
    input.classList.add('tag-input-value');
    return wrap;
  }

  if(def.kind === 'boolean' || def.options){
    const entries = def.kind === 'boolean'
      ? [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]
      : (def.options || []).map(value => ({ value, label: OPTION_LABELS[value] || value }));
    wrap.append(dropdown(def, entries));
    return wrap;
  }

  const input = document.createElement('input');
  input.type = def.kind === 'number' ? 'number' : 'text';
  const secret = Boolean(def.secret);
  const masked = secret && def.configured ? SECRET_MASK.repeat(Number(def.length) || 0) : '';
  input.value = secret ? masked : (def.value ?? '');
  if(secret){
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    if(def.configured) input.title = '已配置，聚焦后输入新值覆盖；不输入则保持原值';
    else input.placeholder = '未配置';
    input.addEventListener('beforeinput', (event) => {
      const type = event.inputType || '';
      if(masked && input.value === masked && (type.startsWith('insert') || type.startsWith('delete'))){
        input.value = '';
      }
    });
    input.onblur = () => {
      const cleared = [...input.value].every(char => char === SECRET_MASK);
      if(masked && cleared){
        input.value = masked;
      }
      input.placeholder = def.configured ? '' : '未配置';
      markDirty();
    };
  }
  input.dataset.key = def.key;
  input.dataset.kind = def.kind;
  input.dataset.secret = def.secret ? '1' : '0';
  input.oninput = markDirty;
  input.onchange = markDirty;
  wrap.append(input);
  return wrap;
}

function render(){
  app.innerHTML='';
  const groups = new Map();
  for(const def of settings){
    if(!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def);
  }
  let count = 0;
  for(const [name, defs] of groups){
    const section = document.createElement('section'); section.className='group';
    const head = document.createElement('div'); head.className='group-head';
    const icon = document.createElement('div'); icon.className='group-icon'; icon.textContent=name.slice(0,1);
    const title = document.createElement('h3'); title.textContent=name;
    head.append(icon,title); section.append(head);
    const grid = document.createElement('div'); grid.className='grid';
    for(const def of defs){ const node=field(def); node.dataset.search=(def.label+' '+def.key).toLowerCase(); grid.append(node); count++; }
    section.append(grid); app.append(section);
  }
  original = new Map([...document.querySelectorAll('[data-key]')].map(el => [el.dataset.key, serialize(getValue(el))]));
  countEl.textContent = count + ' 项配置';
  saveBtn.disabled = true;
  applyFilter();
}

function applyFilter(){
  const q = search.value.trim().toLowerCase();
  for(const group of document.querySelectorAll('.group')){
    let visible = 0;
    for(const fieldNode of group.querySelectorAll('.field')){
      const show = !q || fieldNode.dataset.search.includes(q);
      fieldNode.style.display = show ? '' : 'none';
      if(show) visible++;
    }
    group.style.display = visible ? '' : 'none';
  }
}

function tickSession(){
  if(!expiresAt) return;
  const left = expiresAt - Date.now();
  if(left <= 0){
    expiresAt = 0;
    sessionText.textContent = '登录已过期';
    window.location.href = '/login?expired=1';
    return;
  }
  const total = Math.ceil(left / 1000);
  sessionText.textContent = '登录剩余 ' + Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  sessionEl.classList.toggle('low', left < 60000);
}
setInterval(tickSession, 1000);

async function load(){
  statusEl.textContent='加载中…'; statusEl.className='status';
  const res = await fetch(window.location.origin + '/api/settings');
  if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
  if(!res.ok) throw new Error('配置读取失败');
  const data = await res.json();
  settings = data.settings;
  expiresAt = Number(data.session?.expiresAt || 0);
  tickSession();
  render();
  statusEl.textContent=''; statusEl.className='status';
}

async function resetSetting(key){
  if(!confirm('恢复这一项的默认值？')) return;
  statusEl.className='status'; statusEl.textContent='恢复中…';
  try{
    const res = await fetch(window.location.origin + '/api/settings?key=' + encodeURIComponent(key), {method:'DELETE'});
    if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '恢复失败');
    await load();
    statusEl.className='status ok';
    statusEl.textContent = data.reset ? '已恢复默认值' : '这一项本来就用默认值';
  }catch(error){
    statusEl.className='status error'; statusEl.textContent=error.message;
  }
}

search.oninput = applyFilter;
resetBtn.onclick = () => { load().catch(error => { statusEl.className='status error'; statusEl.textContent=error.message; }); };
saveBtn.onclick = async () => {
  const payload = {};
  for(const el of document.querySelectorAll('[data-key]')){
    if(el.dataset.secret === '1' && el.value === '') continue;
    if(original.get(el.dataset.key) === serialize(getValue(el))) continue;
    payload[el.dataset.key] = getValue(el);
  }
  if(Object.keys(payload).length === 0){ statusEl.textContent='没有修改'; return; }
  saveBtn.disabled=true; statusEl.className='status'; statusEl.textContent='保存中…';
  try{
    const res = await fetch(window.location.origin + '/api/settings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(res.status === 401){ window.location.href = '/login?expired=1'; return; }
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '保存失败');
    const message = data.restartRequired?.length ? '已保存，需要重启：' + data.restartRequired.join('、') : '已保存并生效';
    await load();
    statusEl.className='status ok';
    statusEl.textContent = message;
  }catch(error){
    statusEl.className='status error'; statusEl.textContent=error.message; saveBtn.disabled=false;
  }
};
load().catch(error => { app.innerHTML='<div class="empty">'+error.message+'</div>'; });
</script>
</body>
</html>`;
