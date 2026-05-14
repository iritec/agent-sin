import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runTelegramBot,
  parseTelegramIdList,
  classifyTelegramMessage,
  shouldRespond,
  chunkTelegramMessage,
} from "../dist/telegram/bot.js";

test("parseTelegramIdList: comma, semicolon, whitespace separated; keeps negative chat ids", () => {
  const ids = parseTelegramIdList("123, -100456;789 abc 12-3");
  assert.deepEqual([...ids].sort(), ["-100456", "123", "789"].sort());
});

test("classifyTelegramMessage: private message from allowed user responds", () => {
  const message = {
    message_id: 1,
    chat: { id: 111, type: "private" },
    from: { id: 111, first_name: "me" },
    text: "hello",
  };
  const ctx = classifyTelegramMessage(message, "999", "agent_sin_bot", new Set(["111"]));
  assert.equal(ctx.isPrivate, true);
  assert.equal(ctx.isAllowed, true);
  assert.equal(shouldRespond(ctx), true);
});

test("classifyTelegramMessage: group plain message does not respond", () => {
  const message = {
    message_id: 1,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 111, first_name: "me" },
    text: "予定を見て",
  };
  const ctx = classifyTelegramMessage(message, "999", "agent_sin_bot", new Set(["111"]));
  assert.equal(ctx.isMentioned, false);
  assert.equal(ctx.isReplyToBot, false);
  assert.equal(shouldRespond(ctx), false);
});

test("classifyTelegramMessage: reply to bot is detected", () => {
  const message = {
    message_id: 2,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 111, first_name: "me" },
    text: "続けて",
    reply_to_message: {
      message_id: 1,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 999, first_name: "bot", is_bot: true },
      text: "前の返答",
    },
  };
  const ctx = classifyTelegramMessage(message, "999", "agent_sin_bot", new Set(["111"]));
  assert.equal(ctx.isReplyToBot, true);
  assert.equal(shouldRespond(ctx), true);
});

test("chunkTelegramMessage splits long replies", () => {
  const chunks = chunkTelegramMessage("a".repeat(10), 4);
  assert.deepEqual(chunks, ["aaaa", "aaaa", "aa"]);
});

test("runTelegramBot refuses to start without allowed user IDs", async () => {
  const previousToken = process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS;
  process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN = "telegram-token";
  delete process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS;
  try {
    assert.equal(await runTelegramBot({ workspace: "" }), 1);
  } finally {
    if (previousToken === undefined) delete process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN;
    else process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined) delete process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS;
    else process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});
