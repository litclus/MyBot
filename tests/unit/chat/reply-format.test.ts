import assert from "node:assert/strict";
import test from "node:test";
import { humanDelayMs, parseReplyMessages } from "../../../src/chat/reply-format.js";

test("parseReplyMessages 解析文字和媒体", () => {
  assert.deepEqual(
    parseReplyMessages(
      '{"messages":[{"plainText":"看这个","images":[1],"stickers":[2,3]}]}',
    ),
    [{ plainText: "看这个", voiceText: "", images: [1], stickers: [2, 3] }],
  );
});

test("parseReplyMessages 解析语音文本", () => {
  assert.deepEqual(
    parseReplyMessages(
      '{"messages":[{"plainText":"我在呢","voiceText":"(温柔)我在呢","images":[],"stickers":[]}]}',
    ),
    [{ plainText: "我在呢", voiceText: "(温柔)我在呢", images: [], stickers: [] }],
  );
});

test("parseReplyMessages 只有语音文本也保留", () => {
  assert.deepEqual(parseReplyMessages('{"messages":[{"voiceText":"(开心)好耶"}]}'), [
    { plainText: "", voiceText: "(开心)好耶", images: [], stickers: [] },
  ]);
});

test("parseReplyMessages 解析只有媒体", () => {
  assert.deepEqual(parseReplyMessages('{"messages":[{"stickers":[4]}]}'), [
    { plainText: "", voiceText: "", images: [], stickers: [4] },
  ]);
});

test("parseReplyMessages 空 messages 表示不回复", () => {
  assert.deepEqual(parseReplyMessages('{"messages":[]}'), []);
});

test("parseReplyMessages 坏 JSON 返回空", () => {
  assert.deepEqual(parseReplyMessages(""), []);
  assert.deepEqual(parseReplyMessages('{"messages":['), []);
  assert.deepEqual(parseReplyMessages('[]'), []);
});

test("parseReplyMessages 裸文本兜底成一条", () => {
  assert.deepEqual(parseReplyMessages("直接说话"), [
    { plainText: "直接说话", voiceText: "", images: [], stickers: [] },
  ]);
});

test("parseReplyMessages 裸文本也过清洗", () => {
  assert.deepEqual(parseReplyMessages("**你好**\n- 在的"), [
    { plainText: "你好\n在的", voiceText: "", images: [], stickers: [] },
  ]);
});

test("parseReplyMessages 单对象也认", () => {
  assert.deepEqual(parseReplyMessages('{"plainText":"在","stickers":[7]}'), [
    { plainText: "在", voiceText: "", images: [], stickers: [7] },
  ]);
});

test("parseReplyMessages 旧的 text 字段不再兼容", () => {
  assert.deepEqual(parseReplyMessages('{"messages":[{"text":"旧字段"}]}'), []);
});

test("parseReplyMessages 围栏里的 JSON 照常解析", () => {
  assert.deepEqual(
    parseReplyMessages('```json\n{"messages":[{"plainText":"在"}]}\n```'),
    [{ plainText: "在", voiceText: "", images: [], stickers: [] }],
  );
});

test("parseReplyMessages 过滤非法 id 和空对象", () => {
  assert.deepEqual(
    parseReplyMessages(
      '{"messages":[{"plainText":"看","images":[0,-1,"2",3.5,5],"stickers":[6]},{"plainText":""}]}',
    ),
    [{ plainText: "看", voiceText: "", images: [5], stickers: [6] }],
  );
});

test("parseReplyMessages 最多保留三条，多出的合并", () => {
  const messages = parseReplyMessages(
    '{"messages":[{"plainText":"1"},{"plainText":"2"},{"plainText":"3"},{"plainText":"4"}]}',
    3,
  );
  assert.equal(messages.length, 3);
  assert.equal(messages[2]?.plainText, "3\n4");
});

test("parseReplyMessages 合并语音文本", () => {
  const messages = parseReplyMessages(
    '{"messages":[{"plainText":"1","voiceText":"一"},{"plainText":"2","voiceText":"二"},{"plainText":"3","voiceText":"三"},{"plainText":"4","voiceText":"四"}]}',
    3,
  );
  assert.equal(messages[2]?.plainText, "3\n4");
  assert.equal(messages[2]?.voiceText, "三\n四");
});

test("parseReplyMessages 清洗 Markdown", () => {
  assert.deepEqual(parseReplyMessages('{"messages":[{"plainText":"**你好**。"}]}'), [
    { plainText: "你好", voiceText: "", images: [], stickers: [] },
  ]);
});

test("parseReplyMessages 读 gap 并夹到 0-15 秒", () => {
  const parsed = parseReplyMessages(
    '{"messages":[{"plainText":"a","gap":1.5},{"plainText":"b","gap":99},{"plainText":"c","gap":-3},{"plainText":"d","gap":"2"}]}',
    4,
  );
  assert.deepEqual(
    parsed.map((item) => item.gapSeconds),
    [1.5, 15, 0, undefined],
  );
});

test("parseReplyMessages 兜底文本没有 gap", () => {
  const [message] = parseReplyMessages("在，说事");
  assert.equal(message?.gapSeconds, undefined);
});

test("humanDelayMs 在合理范围", () => {
  for (const text of ["", "短", "长".repeat(500)]) {
    const delay = humanDelayMs(text);
    assert.ok(delay >= 300 && delay <= 2500);
  }
});
