import assert from "node:assert/strict";
import test from "node:test";
import { resolveMentions } from "../../../src/chat/mentions.js";

const candidates = [
  { token: "u1", openid: "openid-1", name: "小明", role: "member" },
  { token: "u2", openid: "openid-2", name: "小红", role: "member" },
];

test("群聊把 token 换成 QQ @ 标签", () => {
  const result = resolveMentions("问 [[mention:u1]] 和 [[mention:u2]]", candidates, "group");
  assert.equal(
    result.content,
    '问 <qqbot-at-user id="openid-1" /> 和 <qqbot-at-user id="openid-2" />',
  );
  assert.equal(result.display, "问 @小明 和 @小红");
});

test("私聊降级成 @名字", () => {
  const result = resolveMentions("[[mention:u1]]", candidates, "dm");
  assert.equal(result.content, "@小明");
  assert.equal(result.display, "@小明");
});

test("token 后面重复写名字或别名会被去掉", () => {
  const withAlias = [
    {
      token: "u1",
      openid: "openid-1",
      name: "待你",
      role: "admin",
      aliases: ["刘俊艺"],
    },
  ];
  const result = resolveMentions(
    "[[mention:u1]] 刘俊艺 有人叫你去 B8-C321",
    withAlias,
    "group",
  );
  assert.equal(
    result.content,
    '<qqbot-at-user id="openid-1" /> 有人叫你去 B8-C321',
  );
  assert.equal(result.display, "@待你 有人叫你去 B8-C321");
});

test("未知 token 被剥掉", () => {
  const result = resolveMentions("看 [[mention:nope]] 这个", candidates, "group");
  assert.equal(result.content, "看  这个");
  assert.equal(result.display, "看  这个");
});
