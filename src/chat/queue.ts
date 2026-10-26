export type PreviousTaskState = "thinking" | "sending";

/** 新消息是否要取消同一个人上一条还在 thinking 的任务 */
export function shouldCancelPrevious(input: {
  state: PreviousTaskState;
  conversationKind: "group" | "dm";
  isMention: boolean;
  gapMs: number;
  cancelWindowMs: number;
}): boolean {
  if (input.state !== "thinking") return false;
  // 群里的 @ 不受 3 秒窗口限制
  if (input.conversationKind === "group" && input.isMention) return true;
  return input.gapMs < input.cancelWindowMs;
}
