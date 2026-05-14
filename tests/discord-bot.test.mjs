import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseAllowedUserIds,
  classifyMessage,
  shouldRespond,
  chunkMessage,
  parseTodoSlashCommand,
  parseModelSlashCommand,
  manifestToSlashDefinition,
} from "../dist/discord/bot.js";

const baseCtx = {
  isDirect: false,
  isMentioned: false,
  isAllowed: true,
  isListenChannel: false,
  isBotThread: false,
};

test("parseAllowedUserIds: comma, semicolon, whitespace separated; rejects non-numeric", () => {
  const ids = parseAllowedUserIds("123, 456;789  101 abc 12-3");
  assert.deepEqual([...ids].sort(), ["101", "123", "456", "789"].sort());
});

test("classifyMessage: DM from allowed user is direct + allowed", () => {
  const ctx = classifyMessage(
    {
      id: "m1",
      channel_id: "c1",
      author: { id: "111", username: "me" },
      content: "hello",
      mentions: [],
    },
    "999",
    new Set(["111"]),
  );
  assert.equal(ctx.isDirect, true);
  assert.equal(ctx.isAllowed, true);
});

test("classifyMessage: guild message with bot mention is mentioned", () => {
  const ctx = classifyMessage(
    {
      id: "m1",
      channel_id: "c1",
      guild_id: "g1",
      author: { id: "111", username: "me" },
      content: "<@999> please",
      mentions: [{ id: "999", username: "bot" }],
    },
    "999",
    new Set(["111"]),
  );
  assert.equal(ctx.isDirect, false);
  assert.equal(ctx.isMentioned, true);
});

test("classifyMessage: disallowed user is not allowed", () => {
  const ctx = classifyMessage(
    {
      id: "m1",
      channel_id: "c1",
      author: { id: "222", username: "stranger" },
      content: "hi",
      mentions: [],
    },
    "999",
    new Set(["111"]),
  );
  assert.equal(ctx.isAllowed, false);
});

test("shouldRespond: DM from allowed user → true", () => {
  assert.equal(shouldRespond({ ...baseCtx, isDirect: true }), true);
});

test("shouldRespond: mention from allowed user → true", () => {
  assert.equal(shouldRespond({ ...baseCtx, isMentioned: true }), true);
});

test("shouldRespond: random guild message → false", () => {
  assert.equal(shouldRespond({ ...baseCtx }), false);
});

test("chunkMessage: long message is split, prefers newlines", () => {
  const text = "abc\ndef\nghi\njkl";
  const chunks = chunkMessage(text, 7);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 7, `chunk too long: ${chunk}`);
  }
  assert.equal(chunks.join("\n"), text.split("\n").join("\n"));
});

test("parseTodoSlashCommand: returns null for non-todo text", () => {
  assert.equal(parseTodoSlashCommand("hello"), null);
  assert.equal(parseTodoSlashCommand("/todos"), null);
  assert.equal(parseTodoSlashCommand("/skills"), null);
});

test("parseTodoSlashCommand: bare /todo shows help", () => {
  const parsed = parseTodoSlashCommand("/todo");
  assert.equal(parsed?.kind, "help");
  assert.ok(parsed.lines.length > 0);
});

test("parseTodoSlashCommand: /todo add parses text and optional --due", () => {
  const plain = parseTodoSlashCommand("/todo add Buy milk");
  assert.equal(plain?.kind, "run");
  assert.equal(plain.skillId, "todo-add");
  assert.deepEqual(plain.args, { text: "Buy milk" });

  const withDue = parseTodoSlashCommand("/todo add Buy milk --due 2026-05-17T18:00:00+09:00");
  assert.equal(withDue?.kind, "run");
  assert.equal(withDue.skillId, "todo-add");
  assert.deepEqual(withDue.args, { text: "Buy milk", due: "2026-05-17T18:00:00+09:00" });
});

test("parseTodoSlashCommand: /todo add without body returns error", () => {
  const parsed = parseTodoSlashCommand("/todo add");
  assert.equal(parsed?.kind, "error");
});

test("parseTodoSlashCommand: /todo list defaults to open and validates filter", () => {
  const def = parseTodoSlashCommand("/todo list");
  assert.equal(def?.kind, "run");
  assert.equal(def.skillId, "todo-list");
  assert.deepEqual(def.args, { status: "open" });

  const done = parseTodoSlashCommand("/todo list done");
  assert.deepEqual(done.args, { status: "done" });

  const bad = parseTodoSlashCommand("/todo list bogus");
  assert.equal(bad?.kind, "error");
});

test("parseTodoSlashCommand: /todo done and /todo delete require id", () => {
  const ok = parseTodoSlashCommand("/todo done abc123");
  assert.equal(ok?.kind, "run");
  assert.equal(ok.skillId, "todo-done");
  assert.deepEqual(ok.args, { id: "abc123" });

  const del = parseTodoSlashCommand("/todo delete abc123");
  assert.equal(del?.kind, "run");
  assert.equal(del.skillId, "todo-delete");
  assert.deepEqual(del.args, { id: "abc123" });

  const missing = parseTodoSlashCommand("/todo done");
  assert.equal(missing?.kind, "error");
});

test("parseTodoSlashCommand: unknown subcommand reports error with help", () => {
  const parsed = parseTodoSlashCommand("/todo wat");
  assert.equal(parsed?.kind, "error");
  assert.ok(parsed.lines.length >= 2);
});

test("parseModelSlashCommand: returns null for non-model text", () => {
  assert.equal(parseModelSlashCommand("hello"), null);
  assert.equal(parseModelSlashCommand("/models"), null);
  assert.equal(parseModelSlashCommand("/modelfoo"), null);
});

test("parseModelSlashCommand: bare /model returns list", () => {
  const parsed = parseModelSlashCommand("/model");
  assert.equal(parsed?.kind, "list");
});

test("parseModelSlashCommand: /model <id> returns set with id", () => {
  const parsed = parseModelSlashCommand("/model codex-xhigh");
  assert.equal(parsed?.kind, "set");
  assert.equal(parsed.id, "codex-xhigh");
});

test("parseModelSlashCommand: extra whitespace and trailing tokens are tolerated", () => {
  const parsed = parseModelSlashCommand("  /model   openai   noise  ");
  assert.equal(parsed?.kind, "set");
  assert.equal(parsed.id, "openai");
});

test("parseModelSlashCommand: /model help shows help lines", () => {
  const parsed = parseModelSlashCommand("/model help");
  assert.equal(parsed?.kind, "help");
  assert.ok(parsed.lines.length > 0);
});

test("manifestToSlashDefinition: returns null when discord_slash is absent", () => {
  const definition = manifestToSlashDefinition({
    id: "flip-coin",
    name: "コイントス",
    description: "コインを投げる",
    runtime: "python",
    entry: "main.py",
    handler: "run",
    invocation: { phrases: ["コイントス"] },
    input: { schema: {} },
    outputs: [],
    dir: "/tmp",
    source: "user",
  });
  assert.equal(definition, null);
});

test("manifestToSlashDefinition: maps option types and choices", () => {
  const definition = manifestToSlashDefinition({
    id: "flip-coin",
    name: "コイントス",
    description: "コインを投げる",
    runtime: "python",
    entry: "main.py",
    handler: "run",
    invocation: {
      phrases: ["コイントス"],
      discord_slash: {
        description: "Flip a coin",
        description_ja: "コインを投げる",
        options: [
          {
            name: "count",
            type: "integer",
            description: "How many",
            description_ja: "回数",
            required: true,
            choices: [
              { name: "1回", value: 1 },
              { name: "5回", value: 5 },
            ],
          },
          { name: "loud", type: "boolean" },
        ],
      },
    },
    input: { schema: {} },
    outputs: [],
    dir: "/tmp",
    source: "user",
  });
  assert.ok(definition, "expected non-null definition");
  assert.equal(definition.name, "flip-coin");
  assert.equal(definition.description, "Flip a coin");
  assert.deepEqual(definition.description_localizations, { ja: "コインを投げる" });
  assert.equal(definition.type, 1);
  assert.equal(definition.dm_permission, true);
  const options = definition.options;
  assert.equal(options[0].type, 4); // integer
  assert.equal(options[0].name, "count");
  assert.equal(options[0].required, true);
  assert.deepEqual(options[0].description_localizations, { ja: "回数" });
  assert.deepEqual(options[0].choices, [
    { name: "1回", value: 1 },
    { name: "5回", value: 5 },
  ]);
  assert.equal(options[1].type, 5); // boolean
  assert.equal(options[1].name, "loud");
  assert.equal(options[1].required, false);
});

test("manifestToSlashDefinition: falls back to manifest description when slash description omitted", () => {
  const definition = manifestToSlashDefinition({
    id: "noop",
    name: "Noop",
    description: "Manifest level description",
    runtime: "python",
    entry: "main.py",
    handler: "run",
    invocation: { phrases: ["noop"], discord_slash: {} },
    input: { schema: {} },
    outputs: [],
    dir: "/tmp",
    source: "user",
  });
  assert.equal(definition.description, "Manifest level description");
  assert.equal(definition.options, undefined);
});
