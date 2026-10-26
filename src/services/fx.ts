import { config } from "../config.js";

/**
 * 汇率查询
 *
 * 数据源是 Frankfurter（欧洲央行参考汇率），一天最多更新一次
 * 按货币对做内存缓存 + 单飞；美元兑人民币拉失败时先用旧值，再不行用配置兜底
 */

const FETCH_TIMEOUT_MS = 5_000;

export type CachedRate = {
  rate: number;
  /** 数据源给的日期，例如 2026-10-25 */
  date?: string;
  fetchedAt: number;
};

const cache = new Map<string, CachedRate>();
const inflight = new Map<string, Promise<CachedRate>>();

/** 常见货币的中文名，没收录的直接显示代码 */
const CURRENCY_NAMES: Record<string, string> = {
  USD: "美元",
  CNY: "人民币",
  EUR: "欧元",
  JPY: "日元",
  GBP: "英镑",
  HKD: "港币",
  KRW: "韩元",
  TWD: "新台币",
  AUD: "澳元",
  CAD: "加元",
  SGD: "新加坡元",
  CHF: "瑞士法郎",
  RUB: "卢布",
  THB: "泰铢",
  MYR: "林吉特",
  NZD: "新西兰元",
};

export function currencyName(code: string): string {
  const normalized = code.trim().toUpperCase();
  return CURRENCY_NAMES[normalized] ?? normalized;
}

/** 取某个货币对的汇率；缓存命中直接返回，拉不到就抛错 */
export async function getRate(base: string, quote: string): Promise<CachedRate> {
  const from = normalizeCode(base);
  const to = normalizeCode(quote);
  if (from === to) throw new Error("两个货币一样");

  const key = `${from}:${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < config.FX_CACHE_TTL_MINUTES * 60_000) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = fetchRate(from, to)
    .then((fresh) => {
      cache.set(key, fresh);
      return fresh;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/** 美元兑人民币：余额换算用，直接按 USD→CNY 取，不做倒数免得丢精度 */
export async function usdToCny(): Promise<number> {
  return (await getRate("USD", "CNY")).rate;
}

/** 工具返回的一句话：1 人民币 = 0.1500 美元（2026-10-25） */
export async function describeRate(base = "CNY", quote = "USD"): Promise<string> {
  const from = normalizeCode(base);
  const to = normalizeCode(quote);
  const rate = await getRate(from, to);
  return formatRate(from, to, rate);
}

/** 查不到就说查不到，不拿兜底值冒充实时价 */
export async function describeRateSafe(base = "CNY", quote = "USD"): Promise<string> {
  try {
    return await describeRate(base, quote);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) return "没有这个货币，检查一下代码";
    return `查不到汇率（${message}）`;
  }
}

export function formatRate(from: string, to: string, rate: CachedRate): string {
  const value = trimRate(rate.rate);
  const day = rate.date ? `（${rate.date}）` : "";
  return `1 ${currencyName(from)} = ${value} ${currencyName(to)}${day}`;
}

/** 小数位按量级给：大额货币留两位，小额货币多给几位 */
function trimRate(rate: number): string {
  if (rate >= 100) return rate.toFixed(2);
  if (rate >= 1) return rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return rate.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new Error("货币代码要三个字母");
  return normalized;
}

async function fetchRate(base: string, quote: string): Promise<CachedRate> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${config.FX_API_URL}?base=${base}&quotes=${quote}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": config.MYBOT_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`fx ${response.status}`);
    const rate = parseRate(await response.json(), base, quote);
    if (rate === null) throw new Error("fx 格式不对");
    return rate;
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 Frankfurter v2 的返回：[{date,base,quote,rate}] */
export function parseRate(payload: unknown, base = "CNY", quote = "USD"): CachedRate | null {
  if (!Array.isArray(payload)) return null;
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const row = item as { base?: unknown; quote?: unknown; rate?: unknown; date?: unknown };
    if (row.base !== base || row.quote !== quote) continue;
    const rate = Number(row.rate);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return {
      rate,
      fetchedAt: Date.now(),
      ...(typeof row.date === "string" ? { date: row.date } : {}),
    };
  }
  return null;
}
