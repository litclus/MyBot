/** 只有最后一条是用户消息、且没超过补回复窗口，才允许主动回复 */
export function canProactivelyReply(
  last: { role: string; createdAt: Date } | undefined,
  now = Date.now(),
  maxAgeMs = 5 * 60_000,
): boolean {
  if (!last || last.role !== "user") return false;
  const age = now - last.createdAt.getTime();
  return age >= 0 && age <= maxAgeMs;
}
