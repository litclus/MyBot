export type QqAttachment = {
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
  voice_wav_url?: string;
  asr_refer_text?: string;
};

export type QqUser = {
  id?: string;
  username?: string;
  bot?: boolean;
  union_openid?: string;
  user_openid?: string;
  member_openid?: string;
  member_role?: string;
};

export type QqMsgElement = {
  content?: string;
  author?: QqUser;
  message_type?: number;
  msg_idx?: string;
  attachments?: QqAttachment[];
  msg_elements?: QqMsgElement[];
};

export type QqGroupMember = {
  member_openid?: string;
  username?: string;
  member_role?: string;
  bot?: boolean;
  joined_at?: string;
  union_openid?: string;
};

export type QqMessageScene = {
  source?: string;
  ext?: string[];
};

export type QqGroupAtEvent = {
  id?: string;
  content?: string;
  group_openid?: string;
  author?: QqUser;
  timestamp?: string;
  attachments?: QqAttachment[];
  mentions?: QqUser[];
  message_type?: number;
  message_scene?: QqMessageScene;
  msg_elements?: QqMsgElement[];
};

export type QqC2CEvent = {
  id?: string;
  content?: string;
  author?: QqUser;
  timestamp?: string;
  attachments?: QqAttachment[];
  message_type?: number;
  message_scene?: QqMessageScene;
  msg_elements?: QqMsgElement[];
};

export type InboundAttachment = {
  url: string;
  contentType: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
};

export type InboundMention = {
  externalId: string;
  personKey: string;
  name: string;
  bot: boolean;
};

export type InboundPart =
  | { type: "text"; text: string }
  | { type: "emoji"; description: string }
  | { type: "sticker"; description: string };

export type InboundMessage = {
  platform: "qq";
  messageId: string;
  conversation: {
    externalId: string;
    kind: "group" | "dm";
    title?: string;
  };
  sender: {
    externalId: string;
    personKey: string;
    name: string;
    role?: string;
  };
  /** 纯文字部分，表情和表情包在 parts 里 */
  text: string;
  /** 按顺序保留文字、表情、表情包 */
  parts?: InboundPart[];
  attachments: InboundAttachment[];
  /** 消息里 @ 到的人，用于补全成员和别名 */
  mentions?: InboundMention[];
  /** 用户引用的消息（message_type=103） */
  quoted?: {
    author?: string;
    text: string;
    attachments?: InboundAttachment[];
  };
  /** 是否 @ 了机器人：@ 必回；否则走选择性回复 */
  isMention: boolean;
  receivedAt: Date;
  raw: unknown;
};
