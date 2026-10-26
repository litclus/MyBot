import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGroupAt } from "../../../../src/adapters/qq/normalize.js";

test("normalizeGroupAt 解析引用消息", () => {
  const inbound = normalizeGroupAt({
    id: "msg-1",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: " ",
    message_type: 103,
    msg_elements: [
      {
        content: "被引用的原文",
        author: { username: "小明" },
      },
    ],
  });

  assert.equal(inbound?.quoted?.author, "小明");
  assert.equal(inbound?.quoted?.text, "被引用的原文");
});

test("normalizeGroupAt 解析引用消息里的图片", () => {
  const inbound = normalizeGroupAt({
    id: "msg-3",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: "这是什么",
    message_type: 103,
    msg_elements: [
      {
        author: { username: "小明" },
        attachments: [
          { url: "https://example.com/a.png", content_type: "image/png", size: 123 },
        ],
      },
    ],
  });

  assert.equal(inbound?.quoted?.text, "");
  assert.equal(inbound?.quoted?.attachments?.length, 1);
  assert.equal(inbound?.quoted?.attachments?.[0]?.contentType, "image/png");
});

test("表情包不当成 emoji 文本", () => {
  const inbound = normalizeGroupAt({
    id: "msg-face",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: '<faceType=6,faceId="0",ext="W+eJm+mAvF0=">',
    message_type: 0,
    attachments: [{ url: "https://example.com/a.jpg", content_type: "image/jpeg" }],
  });

  assert.equal(inbound?.text, "");
  assert.deepEqual(inbound?.parts, []);
  assert.equal(inbound?.attachments.length, 1);
});

test("faceType=3 的 QQ 大表情不会消失", () => {
  const inbound = normalizeGroupAt({
    id: "msg-face-3",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: '<faceType=3,faceId="509",ext="eyJ0ZXh0Ijoi5p2O55m9In0=">',
    message_type: 0,
  });

  assert.equal(inbound?.text, "");
  assert.deepEqual(inbound?.parts, [{ type: "sticker", description: "李白" }]);
});

test("图片消息的 {text:''} 包装不会变成正文", () => {
  const inbound = normalizeGroupAt({
    id: "msg-image",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: '{"text":""}',
    message_type: 0,
    attachments: [{ url: "https://example.com/a.jpg", content_type: "image/jpeg" }],
  });
  assert.equal(inbound?.text, "");
  assert.equal(inbound?.attachments.length, 1);
});

test("零宽字符包着的 {text:''} 也能拆干净", () => {
  const inbound = normalizeGroupAt({
    id: "msg-image-2",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: '\u200b{"text":""}\u200b',
    message_type: 0,
    attachments: [{ url: "https://example.com/a.jpg", content_type: "image/jpeg" }],
  });
  assert.equal(inbound?.text, "");
});

test("带正文的 text 包装会拆出来", () => {
  const inbound = normalizeGroupAt({
    id: "msg-text",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: '{"text":"看图"}',
    message_type: 0,
  });
  assert.equal(inbound?.text, "看图");
});

test("ext 里是 JSON 文本时也能解析", () => {
  const inbound = normalizeGroupAt({
    id: "msg-face-json",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content:
      '<faceType=1,faceId="272",ext="eyJ0ZXh0Ijoi5ZG15ZG15ZOSIn0=">',
    message_type: 0,
  });
  assert.equal(inbound?.text, "");
  assert.deepEqual(inbound?.parts, [{ type: "emoji", description: "呵呵哒" }]);
});

test("没有 ext 的 QQ 表情给通用占位", () => {
  const inbound = normalizeGroupAt({
    id: "msg-face-2",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: '<faceType=1,faceId="1">',
    message_type: 0,
  });
  assert.equal(inbound?.text, "");
  assert.deepEqual(inbound?.parts, [{ type: "emoji", description: "表情" }]);
});

test("normalizeGroupAt 记录 @ 到的成员", () => {
  const inbound = normalizeGroupAt({
    id: "msg-mention",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: "<@u2> 你好",
    message_type: 0,
    mentions: [{ member_openid: "u2", username: "李小春" }],
  });

  assert.equal(inbound?.text, "@李小春 你好");
  assert.deepEqual(inbound?.mentions, [
    {
      externalId: "u2",
      personKey: "u2",
      name: "李小春",
      bot: false,
    },
  ]);
});

test("normalizeGroupAt 普通消息没有 quoted", () => {
  const inbound = normalizeGroupAt({
    id: "msg-2",
    group_openid: "group-1",
    author: { member_openid: "u1", username: "小红" },
    content: "普通消息",
    message_type: 0,
  });

  assert.equal(inbound?.quoted, undefined);
});
