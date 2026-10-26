import assert from "node:assert/strict";
import test from "node:test";
import { PanelSessions } from "../../../src/app/panel-session.js";

test("新建会话在有效期内可用", () => {
  let now = 1_000;
  const sessions = new PanelSessions(600_000, () => now);
  const session = sessions.create();
  assert.equal(session.expiresAt, 601_000);
  assert.equal(sessions.expiresAt(session.token), 601_000);
});

test("会话到 10 分钟整点过期", () => {
  let now = 0;
  const sessions = new PanelSessions(600_000, () => now);
  const session = sessions.create();
  now = 599_999;
  assert.equal(sessions.expiresAt(session.token), 600_000);
  now = 600_000;
  assert.equal(sessions.expiresAt(session.token), null);
  assert.equal(sessions.expiresAt(session.token), null);
});

test("删除和未知 token 都拿不到会话", () => {
  const sessions = new PanelSessions();
  const session = sessions.create();
  sessions.delete(session.token);
  assert.equal(sessions.expiresAt(session.token), null);
  assert.equal(sessions.expiresAt("missing"), null);
  assert.equal(sessions.expiresAt(null), null);
});
