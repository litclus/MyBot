export type ProactiveSlotKey =
  | "late_night"
  | "early_morning"
  | "morning"
  | "noon"
  | "afternoon"
  | "evening"
  | "night";

export type ProactiveSlot = {
  key: ProactiveSlotKey;
  label: string;
  /** 给模型的时段要求，直接进 prompt */
  hint: string;
};

/** 按上海时间划分，主动消息的说话方式跟着时段走 */
export function proactiveSlotAt(date: Date): ProactiveSlot {
  const hour = (date.getUTCHours() + 8) % 24;
  if (hour < 5) {
    return {
      key: "late_night",
      label: "深夜",
      hint: "群里基本没人，别主动开话题；只有别人刚说话且明显没睡时，才短接一句",
    };
  }
  if (hour < 9) {
    return {
      key: "early_morning",
      label: "清晨",
      hint: "可以问早、提早饭、上班上学，语气轻一点，别连着追问",
    };
  }
  if (hour < 12) {
    return {
      key: "morning",
      label: "上午",
      hint: "适合接工作、学习、犯困这类话题，别太热络",
    };
  }
  if (hour < 14) {
    return {
      key: "noon",
      label: "中午",
      hint: "吃饭和午休时间，可以问吃没吃、睡没睡",
    };
  }
  if (hour < 18) {
    return {
      key: "afternoon",
      label: "下午",
      hint: "容易犯困和摸鱼，可以聊下午茶、下班倒计时",
    };
  }
  if (hour < 22) {
    return {
      key: "evening",
      label: "晚上",
      hint: "群里最活跃，可以多接一句，但别刷屏",
    };
  }
  return {
    key: "night",
    label: "夜深",
    hint: "准备睡了，语气收着，别开新话题，也别问早",
  };
}
