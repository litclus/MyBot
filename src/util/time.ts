const DAY_MS = 24 * 3600_000;
/** Asia/Shanghai 固定 UTC+8，没有夏令时 */
const SHANGHAI_OFFSET_MS = 8 * 3600_000;

/** 距离下一个上海时间 0 点还有多少毫秒；正好 0 点时返回一整天 */
export function msUntilShanghaiMidnight(now = Date.now()): number {
  const shifted = now + SHANGHAI_OFFSET_MS;
  const nextMidnight = Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS;
  return nextMidnight - shifted;
}
