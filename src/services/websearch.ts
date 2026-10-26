import { config } from "../config.js";

/**
 * 网页搜索与搜索额度
 *
 * 搜索走 DeepSeek 的 /v1/tools/search，额度走 /user/balance
 * 两者用同一个 key，和模型调用无关
 */

const SEARCH_TIMEOUT_MS = 15_000;
const BALANCE_TIMEOUT_MS = 10_000;
const MAX_RESULT_CHARS = 1_400;
const MAX_ITEM_SUMMARY = 150;

export type SearchHit = {
  title: string;
  url: string;
  summary?: string;
  snippet?: string;
  siteName?: string | null;
  date?: string | null;
  authority?: number;
};

export function isSearchConfigured(): boolean {
  return config.DEEPSEEK_API_KEY.trim().length > 0;
}

/** 搜索网页，返回按相关度排好的结果；空数组表示没搜到 */
export async function searchWeb(query: string, count: number): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("query 为空");
  if (!isSearchConfigured()) throw new Error("没有配置搜索 key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.DEEPSEEK_BASE_URL}/v1/tools/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.MYBOT_USER_AGENT,
      },
      body: JSON.stringify({
        query: trimmed.slice(0, 128),
        count: Math.min(Math.max(Math.trunc(count), 1), 10),
        need_content: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`search ${response.status}`);
    const data = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        summary?: string;
        snippet?: string;
        site_name?: string | null;
        date?: string | null;
        authority?: number;
      }>;
    };
    const rows = Array.isArray(data.results) ? data.results : [];
    return rows.map((row) => ({
      title: (row.title ?? "").trim(),
      url: (row.url ?? "").trim(),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.snippet ? { snippet: row.snippet } : {}),
      siteName: row.site_name ?? null,
      date: row.date ?? null,
      ...(typeof row.authority === "number" ? { authority: row.authority } : {}),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** 把结果压成给模型看的一段话，总长有上限 */
export function formatSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "没有搜到结果";
  const blocks: string[] = [];
  let used = 0;
  for (const [index, hit] of hits.entries()) {
    const rawText = hit.snippet ?? hit.summary ?? "";
    const title = hit.title || firstSegment(rawText) || "(无标题)";
    const head = [`${index + 1}. ${title}`, metaLine(hit)].filter(Boolean).join(" — ");
    const body = stripLeadingTitle(trimText(rawText, MAX_ITEM_SUMMARY), title);
    const block = [head, body, hit.url].filter(Boolean).join("\n");
    if (used + block.length > MAX_RESULT_CHARS) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}

/** 标题缺失时，拿摘要的第一段顶上 */
function firstSegment(text: string): string {
  const first = trimText(text, 80).split(" / ")[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/** 摘要常以标题开头，重复的部分去掉 */
function stripLeadingTitle(body: string, title: string): string {
  if (!body.startsWith(title)) return body;
  return body.slice(title.length).replace(/^[\s·|｜:：—-]+/, "").replace(/^\/\s*/, "");
}

function metaLine(hit: SearchHit): string {
  const parts: string[] = [];
  if (hit.siteName) parts.push(hit.siteName);
  const day = hit.date?.slice(0, 10);
  if (day) parts.push(day);
  if (typeof hit.authority === "number" && hit.authority >= 3) parts.push("权威");
  return parts.join(" ");
}

/** 摘要里常混着 Markdown 和 "..." 分隔符，这里洗干净再截断 */
function trimText(text: string, max: number): string {
  const clean = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s*\.\.\.\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 搜索额度：返回人民币，查不到就抛错 */
export async function fetchSearchBalanceRmb(): Promise<number> {
  if (!isSearchConfigured()) throw new Error("没有配置搜索 key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.DEEPSEEK_BASE_URL}/user/balance`, {
      headers: {
        Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
        Accept: "application/json",
        "User-Agent": config.MYBOT_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`balance ${response.status}`);
    const data = (await response.json()) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info =
      data.balance_infos?.find((item) => item.currency === "CNY") ?? data.balance_infos?.[0];
    const value = Number(info?.total_balance);
    if (!Number.isFinite(value)) throw new Error("balance 格式不对");
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** 每次搜索的人民币成本 */
export function searchPriceRmbPerCall(): number {
  return config.SEARCH_PRICE_RMB_PER_1K / 1000;
}

/** 把剩余额度说成状态，不报次数也不报金额 */
export function fuzzyQuota(times: number): string {
  if (!Number.isFinite(times) || times <= 0) return "网页搜索额度已经用完了";
  if (times < 100) return "网页搜索额度快见底了";
  if (times < 500) return "网页搜索额度勉强够用";
  if (times < 2_000) return "网页搜索额度还够用";
  return "网页搜索额度很宽裕";
}

/** 工具返回的一句话：只说大概还剩多少，不报具体额度 */
export async function describeSearchBalance(): Promise<string> {
  const rmb = await fetchSearchBalanceRmb();
  const perCall = searchPriceRmbPerCall();
  const times = perCall > 0 ? Math.floor(rmb / perCall) : 0;
  return fuzzyQuota(times);
}

/** 查不到就明说，不编数字 */
export async function describeSearchBalanceSafe(): Promise<string> {
  try {
    return await describeSearchBalance();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `查不到搜索额度（${reason}）`;
  }
}

/** 搜索失败也给模型一句能看的说明 */
export async function describeSearchSafe(query: string, count: number): Promise<string> {
  try {
    return formatSearchHits(await searchWeb(query, count));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `搜索失败（${reason}）`;
  }
}
