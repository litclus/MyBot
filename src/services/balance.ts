import { config } from "../config.js";
import { usdToCny } from "./fx.js";
import { fetchSearchBalanceRmb } from "./websearch.js";

export type WindowKey = "rolling" | "weekly" | "monthly";

export type UsageWindow = { percent: number; resetsAt?: string };
export type PlanUsage = Record<WindowKey, UsageWindow>;

const WINDOW_KEYS: WindowKey[] = ["rolling", "weekly", "monthly"];
const WINDOW_LABEL: Record<WindowKey, string> = {
  rolling: "5小时",
  weekly: "本周",
  monthly: "本月",
};
/** 各窗口占月度额度的比例：5 小时 20%、本周 50%、本月 100% */
const WINDOW_SHARE: Record<WindowKey, number> = {
  rolling: 0.2,
  weekly: 0.5,
  monthly: 1,
};

/**
 * 大白饭的账本。
 *
 * 用量来自 OpenCode Go 的 /go/v1/usage（API key 可调），返回三个窗口的已用百分比。
 * 余额看本月额度：百分比 → 美元 → 人民币 → token（0.1 元 = 100 万）。
 * 另外算出最紧的窗口，那是眼下真正卡住节奏的那个。
 */
export async function fetchPlanUsage(): Promise<PlanUsage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(config.GO_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${config.OPENCODE_API_KEY}`,
        Accept: "application/json",
        "User-Agent": config.MYBOT_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`usage ${response.status}`);
    const data = (await response.json()) as {
      usage?: Partial<Record<WindowKey, { percent?: number; resetsAt?: string }>>;
    };
    const usage = data.usage;
    if (!usage?.monthly && !usage?.weekly && !usage?.rolling) throw new Error("usage missing");

    const read = (key: WindowKey): UsageWindow => {
      const raw = usage[key];
      const percent = typeof raw?.percent === "number" ? raw.percent : 0;
      return raw?.resetsAt ? { percent, resetsAt: raw.resetsAt } : { percent };
    };
    return { rolling: read("rolling"), weekly: read("weekly"), monthly: read("monthly") };
  } finally {
    clearTimeout(timer);
  }
}

export type Balance = {
  usage: PlanUsage;
  /** 本月还剩多少（0-100） */
  remainingPercent: number;
  remainingUsd: number;
  remainingRmb: number;
  remainingTokens: number;
  resetsAt?: string;
  /** 三个窗口里最先撑不住的那个 */
  tightest: WindowKey;
  tightestPercent: number;
};

export function computeBalance(
  usage: PlanUsage,
  monthlyLimitUsd: number,
  usdCny: number,
): Balance {
  const remainingPercent = clampPercent(100 - usage.monthly.percent);
  const remainingUsd = (remainingPercent / 100) * monthlyLimitUsd;
  const remainingRmb = remainingUsd * usdCny;

  let tightest: WindowKey = "rolling";
  let tightestLeft = Number.POSITIVE_INFINITY;
  for (const key of WINDOW_KEYS) {
    const left = (1 - usage[key].percent / 100) * monthlyLimitUsd * WINDOW_SHARE[key];
    if (left < tightestLeft) {
      tightestLeft = left;
      tightest = key;
    }
  }

  const monthlyReset = usage.monthly.resetsAt;
  return {
    usage,
    remainingPercent,
    remainingUsd,
    remainingRmb,
    remainingTokens: tokensForRmb(remainingRmb),
    tightest,
    tightestPercent: usage[tightest].percent,
    ...(monthlyReset ? { resetsAt: monthlyReset } : {}),
  };
}

/** 0.1 元 = 100 万 token，也就是 1 元 = 1000 万。 */
export function tokensForRmb(rmb: number): number {
  return (rmb / config.RMB_PER_MILLION_TOKENS) * 1_000_000;
}

/** 工具返回给模型的一段话：三个窗口用量 + 本月余额 + 眼下最紧的窗口，搜索额度也计入总量 */
export async function describeBalance(): Promise<string> {
  const usage = await fetchPlanUsage();
  const windows = WINDOW_KEYS.map((key) => `${WINDOW_LABEL[key]} ${usage[key].percent}%`).join("，");
  const remainingPercent = Math.max(0, 100 - usage.monthly.percent);
  const remainingUsd = (remainingPercent / 100) * config.GO_MONTHLY_LIMIT_USD;
  const reset = usage.monthly.resetsAt
    ? `，约 ${hoursUntil(usage.monthly.resetsAt)} 小时后重置`
    : "";

  let rate: number | null = null;
  try {
    rate = await usdToCny();
  } catch {
    rate = null;
  }
  if (rate === null) {
    return (
      `套餐用量：${windows}。` +
      `本月还剩 ${remainingPercent}%（约 ${remainingUsd.toFixed(2)} 美元${reset}）。` +
      `汇率查不到，人民币和 token 先算不了`
    );
  }

  const balance = computeBalance(usage, config.GO_MONTHLY_LIMIT_USD, rate);
  const searchRmb = await searchBalanceOrZero();
  const totalRmb = balance.remainingRmb + searchRmb;
  return (
    `套餐用量：${windows}。` +
    `本月还剩 ${balance.remainingPercent}%（约 ${balance.remainingUsd.toFixed(2)} 美元${reset}）。` +
    `合计 ${totalRmb.toFixed(2)} 元，` +
    `按每百万 token ${config.RMB_PER_MILLION_TOKENS} 元算，大约还能吃 ${formatTokens(tokensForRmb(totalRmb))} token。` +
    `眼下最紧的是${WINDOW_LABEL[balance.tightest]}窗口，已用 ${balance.tightestPercent}%`
  );
}

/** 搜索额度查不到时按 0 处理，不影响套餐那部分 */
async function searchBalanceOrZero(): Promise<number> {
  try {
    return await fetchSearchBalanceRmb();
  } catch {
    return 0;
  }
}

/** 查不到就明说，不要编一个数字。 */
export async function describeBalanceSafe(): Promise<string> {
  try {
    return await describeBalance();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `查不到套餐用量（${reason}）`;
  }
}

/** 把 token 数写成人话：亿 / 万 / 个。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return "未知";
  if (tokens >= 100_000_000) return `${Math.round(tokens / 1_000_000) / 100} 亿`;
  if (tokens >= 10_000) return `${Math.round(tokens / 10_000)} 万`;
  return `${Math.round(tokens)}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function hoursUntil(iso: string): number {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 3_600_000));
}
