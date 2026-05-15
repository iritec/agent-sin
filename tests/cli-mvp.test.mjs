import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const cli = path.resolve("dist/cli/index.js");

function run(args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_SIN_LOCALE: "en",
      AGENT_SIN_HOME: home,
    },
    encoding: "utf8",
  });
}

function runWithFakeProvider(args, home, fakeTexts, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_SIN_LOCALE: "en",
      ...extraEnv,
      AGENT_SIN_HOME: home,
      AGENT_SIN_FAKE_PROVIDER: "1",
      ...(fakeTexts !== undefined ? { AGENT_SIN_FAKE_TEXTS: fakeTexts } : {}),
    },
    encoding: "utf8",
  });
}

function localDateParts(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return { yyyy, MM, dd, date: `${yyyy}-${MM}-${dd}` };
}

function builderFilesBlock(summary, files) {
  return `\`\`\`builder-files\n${JSON.stringify({ summary, files })}\n\`\`\``;
}

function generatedPythonSkillFiles(id, title = "生成スキル") {
  return {
    "skill.yaml": `
id: ${id}
name: ${title}
description: Builder generated skill
runtime: python
entry: main.py
handler: run
invocation:
  phrases:
    - ${id}
    - run ${id}
input:
  schema:
    type: object
    properties:
      text:
        type: string
outputs: []
ai_steps: []`,
    "main.py": `async def run(ctx, input):
    text = str(input["args"].get("text", ""))
    return {
        "status": "ok",
        "title": "${title}",
        "summary": text,
        "outputs": {},
        "data": {"text": text},
        "suggestions": [],
    }
`,
    "README.md": `# ${title}\n`,
    "fixtures/input.json": `{"text":"builder hello"}\n`,
  };
}

function testConfig(home) {
  return {
    version: 1,
    workspace: home,
    notes_dir: path.join(home, "notes"),
    skills_dir: path.join(home, "skills"),
    memory_dir: path.join(home, "memory"),
    index_dir: path.join(home, "index"),
    logs_dir: path.join(home, "logs"),
    log_retention_days: 14,
    event_log_retention_days: 90,
    defaults: {
      note_format: "daily_markdown",
    },
    chat_model_id: "chat",
    builder_model_id: "builder",
  };
}

test("setup installs memo-save and run writes a daily markdown note", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));

  const setup = run(["setup"], home);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Workspace ready/);

  const skills = run(["skills"], home);
  assert.equal(skills.status, 0, skills.stderr);
  assert.match(skills.stdout, /memo-save/);
  assert.match(skills.stdout, /memo-search/);
  assert.match(skills.stdout, /todo-add/);

  const save = run(["run", "memo-save", "--text", "Agent-Sin MVPを開始"], home);
  assert.equal(save.status, 0, save.stderr);
  assert.match(save.stdout, /(保存しました|Saved)/);
  assert.doesNotMatch(save.stdout, /saved:/);

  const today = localDateParts();
  const notePath = path.join(home, "notes", today.yyyy, today.MM, `${today.date}.md`);
  const note = readFileSync(notePath, "utf8");
  assert.match(note, /Agent-Sin MVPを開始/);
  assert.match(note, /tags: \["memo"\]/);
});

test("profile memory creates soul.md, user.md, memory.md and can append from CLI", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const soulPath = path.join(home, "memory", "profile", "soul.md");
  const userPath = path.join(home, "memory", "profile", "user.md");
  const memoryPath = path.join(home, "memory", "profile", "memory.md");
  assert.ok(existsSync(soulPath));
  assert.ok(existsSync(userPath));
  assert.ok(existsSync(memoryPath));

  const append = run(["profile", "append", "user", "短い報告を好む"], home);
  assert.equal(append.status, 0, append.stderr);
  assert.match(append.stdout, /saved:/);
  assert.match(readFileSync(userPath, "utf8"), /短い報告を好む/);

  const remember = run(["profile", "append", "memory", "重要な決定だけ長期記憶へ残す"], home);
  assert.equal(remember.status, 0, remember.stderr);
  assert.match(readFileSync(memoryPath, "utf8"), /重要な決定だけ長期記憶へ残す/);

  const show = run(["profile", "show", "user"], home);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /user\.md/);
  assert.match(show.stdout, /短い報告を好む/);
});

test("profile-save skill writes to memory.md", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const saved = run(["run", "profile-save", "--target", "memory", "--text", "次回もこの前提を使う"], home);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /(保存しました|Saved)/);
  assert.match(saved.stdout, /saved:/);

  const memoryPath = path.join(home, "memory", "profile", "memory.md");
  assert.match(readFileSync(memoryPath, "utf8"), /次回もこの前提を使う/);
});

test("profile promote lets the model promote daily memory into memory.md", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const dailyDir = path.join(home, "memory", "daily", "2026", "05");
  mkdirSync(dailyDir, { recursive: true });
  writeFileSync(
    path.join(dailyDir, "2026-05-07.md"),
    [
      "# 2026-05-07",
      "",
      "## 2026-05-07T10:00:00.000Z chat user",
      "",
      "今後、報告は短く実務的にしてほしい。APIキーは長期記憶に保存しない。",
    ].join("\n"),
    "utf8",
  );

  const promoted = runWithFakeProvider(
    ["profile", "promote", "--date", "2026-05-07"],
    home,
    JSON.stringify({ items: [{ text: "ユーザーは短く実務的な報告を好む" }] }),
  );
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.match(promoted.stdout, /promoted: 2026-05-07/);

  const memoryPath = path.join(home, "memory", "profile", "memory.md");
  const memory = readFileSync(memoryPath, "utf8");
  assert.match(memory, /自動昇格: 2026-05-07|Auto promotion: from daily conversation memory on 2026-05-07/);
  assert.match(memory, /ユーザーは短く実務的な報告を好む/);
  assert.doesNotMatch(memory, /APIキーは長期記憶に保存しない/);

  const skipped = runWithFakeProvider(
    ["profile", "promote", "--date", "2026-05-07"],
    home,
    JSON.stringify({ items: [{ text: "重複してはいけない" }] }),
  );
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /skipped: 2026-05-07/);
  assert.doesNotMatch(readFileSync(memoryPath, "utf8"), /重複してはいけない/);
});

test("chat writes daily conversation markdown outside normal notes", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const chat = runWithFakeProvider(["chat", "今日の会話を日別に残す"], home, "日別に残します");
  assert.equal(chat.status, 0, chat.stderr);

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dailyPath = path.join(home, "memory", "daily", yyyy, MM, `${yyyy}-${MM}-${dd}.md`);
  const daily = readFileSync(dailyPath, "utf8");
  assert.match(daily, /今日の会話を日別に残す/);
  assert.match(daily, /日別に残します/);
});

test("memo-search finds saved markdown notes", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const save = run(["run", "memo-save", "--text", "検索用キーワードを含むメモ"], home);
  assert.equal(save.status, 0, save.stderr);

  const search = run(["run", "memo-search", "--query", "検索用キーワード", "--limit", "1"], home);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /(1件見つかりました|1 matches)/);
  assert.match(search.stdout, /検索用キーワード/);
});

test("chat sends free-form input to the configured chat model", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const chat = runWithFakeProvider(["chat", "こんにちは"], home);
  assert.equal(chat.status, 0, chat.stderr);
  // 新形式では chat の role は実体モデル ID (codex-low) に解決される。
  assert.match(chat.stdout, /\[fake:codex-low\]/);
  assert.match(chat.stdout, /こんにちは/);
});

test("chat system prompt includes profile memory", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  assert.equal(run(["profile", "append", "user", "返答は短く実務的にする"], home).status, 0);
  assert.equal(run(["profile", "append", "memory", "長期記憶はmemory.mdに集約する"], home).status, 0);

  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const chatUrl = pathToFileURL(path.resolve("dist/core/chat-engine.js")).href;
  const { setAiProviderOverride } = await import(providerUrl);
  const { chatRespond } = await import(chatUrl);
  let capturedMessages = [];
  setAiProviderOverride(async (_config, request) => {
    capturedMessages = request.messages;
    return { text: "了解しました", model_id: request.model_id, provider: "test" };
  });

  try {
    const lines = await chatRespond(testConfig(home), "こんにちは", []);
    assert.deepEqual(lines, ["了解しました"]);
    const system = capturedMessages.find((message) => message.role === "system")?.content || "";
    assert.match(system, /<user\.md>/);
    assert.match(system, /返答は短く実務的にする/);
    assert.match(system, /<memory\.md>/);
    assert.match(system, /長期記憶はmemory\.mdに集約する/);
  } finally {
    setAiProviderOverride(null);
  }
});

test("chat captures build suggestion without showing the control block", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const chatUrl = pathToFileURL(path.resolve("dist/core/chat-engine.js")).href;
  const { setAiProviderOverride } = await import(providerUrl);
  const { chatRespond } = await import(chatUrl);
  let suggestion = null;
  setAiProviderOverride(async (_config, request) => {
    return {
      text: [
        "毎朝の処理ならスキルにできます。",
        "スキルとして作りますか？",
        "```agent-sin-build-suggestion",
        '{"type":"create","skill_id":"morning-check","reason":"daily automation"}',
        "```",
      ].join("\n"),
      model_id: request.model_id,
      provider: "test",
    };
  });

  try {
    const lines = await chatRespond(testConfig(home), "毎朝チェックして", [], {
      onBuildSuggestion: (value) => {
        suggestion = value;
      },
    });
    const text = lines.join("\n");
    assert.match(text, /スキルとして作りますか？/);
    assert.doesNotMatch(text, /agent-sin-build-suggestion/);
    assert.deepEqual(suggestion, {
      type: "create",
      skill_id: "morning-check",
      reason: "daily automation",
    });
  } finally {
    setAiProviderOverride(null);
  }
});

test("chat hidden-only build suggestion still returns a visible reply", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const chatUrl = pathToFileURL(path.resolve("dist/core/chat-engine.js")).href;
  const { setAiProviderOverride } = await import(providerUrl);
  const { chatRespond } = await import(chatUrl);
  let suggestion = null;
  setAiProviderOverride(async (_config, request) => ({
    text: [
      "```agent-sin-build-suggestion",
      '{"type":"edit","skill_id":"todo-list","reason":"test"}',
      "```",
    ].join("\n"),
    model_id: request.model_id,
    provider: "test",
  }));

  try {
    const lines = await chatRespond(testConfig(home), "直して", [], {
      onBuildSuggestion: (value) => {
        suggestion = value;
      },
    });
    const text = lines.join("\n");
    assert.match(text, /ビルドモード|build mode/i);
    assert.deepEqual(suggestion, {
      type: "edit",
      skill_id: "todo-list",
      reason: "test",
    });
  } finally {
    setAiProviderOverride(null);
  }
});

test("chat retries a blank model response before falling back", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const chatUrl = pathToFileURL(path.resolve("dist/core/chat-engine.js")).href;
  const { setAiProviderOverride } = await import(providerUrl);
  const { chatRespond } = await import(chatUrl);
  let calls = 0;
  setAiProviderOverride(async (_config, request) => ({
    text: ++calls === 1 ? "   " : "意味を汲み取りました",
    model_id: request.model_id,
    provider: "test",
  }));

  try {
    const lines = await chatRespond(testConfig(home), "返事して", []);
    const text = lines.join("\n");
    assert.equal(calls, 2);
    assert.match(text, /意味を汲み取りました/);
  } finally {
    setAiProviderOverride(null);
  }
});

test("chat repeatedly blank model response still returns a visible fallback", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const chatUrl = pathToFileURL(path.resolve("dist/core/chat-engine.js")).href;
  const { setAiProviderOverride } = await import(providerUrl);
  const { chatRespond } = await import(chatUrl);
  let calls = 0;
  setAiProviderOverride(async (_config, request) => {
    calls += 1;
    return {
      text: "   ",
      model_id: request.model_id,
      provider: "test",
    };
  });

  try {
    const lines = await chatRespond(testConfig(home), "返事して", []);
    const text = lines.join("\n");
    assert.equal(calls, 2);
    assert.match(text, /返答を作れませんでした|could not produce a reply/i);
  } finally {
    setAiProviderOverride(null);
  }
});

test("builder prompt allows direct .env edits for skill-required settings only", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const builderUrl = pathToFileURL(path.resolve("dist/builder/builder-session.js")).href;
  const { setAiProviderOverride } = await import(providerUrl);
  const { buildDraftWithAgent } = await import(builderUrl);
  let system = "";
  setAiProviderOverride(async (_config, request) => {
    system = request.messages.find((message) => message.role === "system")?.content || "";
    return {
      text: builderFilesBlock("env prompt test", generatedPythonSkillFiles("env-edit-prompt")),
      model_id: request.model_id,
      provider: "test",
    };
  });

  try {
    await buildDraftWithAgent(
      testConfig(home),
      "env-edit-prompt",
      "APIトークンを受け取ったら設定して",
    );
    assert.match(system, /\.env \(update only the env vars this skill needs\)/);
    assert.match(system, /required_env.*you may update `~\/\.agent-sin\/\.env` directly/s);
    assert.doesNotMatch(system, /\.env[^\n]*(?:must not edit|you must not write)/);
  } finally {
    setAiProviderOverride(null);
  }
});

test("chat invokes a registered skill when the model emits a skill-call block", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const firstResponse = '```skill-call\n{"id":"memo-save","args":{"text":"toolcall test"}}\n```';
  const secondResponse = "保存しました。";
  const chat = runWithFakeProvider(
    ["chat", "次のメモを残しておいて: toolcall test"],
    home,
    `${firstResponse}|||${secondResponse}`,
    { AGENT_SIN_LOCALE: "ja" },
  );
  assert.equal(chat.status, 0, chat.stderr);
  assert.match(chat.stdout, /→ memo-save を実行します/);
  assert.match(chat.stdout, /保存しました/);
  assert.doesNotMatch(chat.stdout, /saved:/);
});

test("chat invokes a skill when the skill-call label is split onto its own line", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const firstResponse = '```\nskill-call\n{"id":"memo-save","args":{"text":"split label toolcall"}}\n```';
  const secondResponse = "Saved.";
  const chat = runWithFakeProvider(
    ["chat", "save this memo: split label toolcall"],
    home,
    `${firstResponse}|||${secondResponse}`,
    { AGENT_SIN_LOCALE: "en" },
  );
  assert.equal(chat.status, 0, chat.stderr);
  assert.match(chat.stdout, /Calling memo-save/);
  assert.match(chat.stdout, /Memo saved/);
  assert.doesNotMatch(chat.stdout, /skill-call/);
});

test("chat runs exact read-only skill triggers without waiting for the model to emit a skill-call", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const chat = runWithFakeProvider(
    ["chat", "todolist"],
    home,
    "[fake model should not be visible]",
    { AGENT_SIN_LOCALE: "en" },
  );
  assert.equal(chat.status, 0, chat.stderr);
  assert.match(chat.stdout, /There are no open ToDos|No ToDos/);
  assert.doesNotMatch(chat.stdout, /fake model should not be visible/);
  assert.doesNotMatch(chat.stdout, /skill-call/);
});

test("Japanese chat turn localizes framework text and skill results even with English config", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  const setup = runWithFakeProvider(["setup"], home, undefined, { AGENT_SIN_LOCALE: "en" });
  assert.equal(setup.status, 0, setup.stderr);

  const firstResponse = '```skill-call\n{"id":"memo-save","args":{"text":"日本語ターンロケール"}}\n```';
  const secondResponse = "保存しました。";
  const chat = runWithFakeProvider(
    ["chat", "次のメモを残しておいて: 日本語ターンロケール"],
    home,
    `${firstResponse}|||${secondResponse}`,
    { AGENT_SIN_LOCALE: "" },
  );
  assert.equal(chat.status, 0, chat.stderr);
  assert.match(chat.stdout, /→ memo-save を実行します/);
  assert.match(chat.stdout, /メモを保存しました/);
  assert.doesNotMatch(chat.stdout, /→ Calling memo-save/);
  assert.doesNotMatch(chat.stdout, /Memo saved\./);
});

test("chat self-repair sends the failed run log to the builder and retries", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  const skillDir = path.join(home, "skills", "repair-me");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: repair-me
name: Repair Me
description: Self repair test skill
runtime: python
entry: main.py
handler: run
invocation:
  command: repair.me
  phrases:
    - repair me
input:
  schema:
    type: object
    properties:
      text:
        type: string
outputs: []`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.py"),
    `async def run(ctx, input):
    ctx.log.error("repair target detail: " + str(input["args"].get("text", "")))
    return {
        "status": "error",
        "title": "実行失敗",
        "summary": "RuntimeError: repair target failed",
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
`,
    "utf8",
  );

  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const chatUrl = pathToFileURL(path.resolve("dist/core/chat-engine.js")).href;
  const { setAiProviderOverride } = await import(providerUrl);
  const { chatRespond } = await import(chatUrl);
  let chatCalls = 0;
  let builderContext = "";
  setAiProviderOverride(async (_config, request) => {
    if (request.role === "builder") {
      builderContext = request.messages.map((message) => String(message.content)).join("\n");
      return {
        text: builderFilesBlock("repaired", generatedPythonSkillFiles("repair-me", "修復済み")),
        model_id: request.model_id,
        provider: "test",
      };
    }
    chatCalls += 1;
    return {
      text:
        chatCalls === 1
          ? '```skill-call\n{"id":"repair-me","args":{"text":"run log check"}}\n```'
          : "直りました",
      model_id: request.model_id,
      provider: "test",
    };
  });

  try {
    const lines = await chatRespond(testConfig(home), "repair me", []);
    const text = lines.join("\n");
    assert.match(text, /修正|Repair/);
    assert.match(text, /run log check/);
    assert.match(builderContext, /実行ログ・診断情報|Run logs and diagnostics/);
    assert.match(builderContext, /repair target detail: run log check/);
    assert.match(builderContext, /ctx_logs/);
  } finally {
    setAiProviderOverride(null);
  }
});

test("build footer is shown for every build-mode reply", async () => {
  const moduleUrl = pathToFileURL(path.resolve("dist/builder/build-flow.js")).href;
  const i18nUrl = pathToFileURL(path.resolve("dist/core/i18n.js")).href;
  const { createIntentRuntime, renderBuildFooter, shouldShowBuildFooter } = await import(moduleUrl);
  const { setLocale } = await import(i18nUrl);
  const runtime = createIntentRuntime(true);
  runtime.mode = "build";
  runtime.build = {
    type: "create",
    skill_id: "sample",
    context_seed: [],
    context_consumed: true,
    original_text: "sample",
  };

  assert.equal(
    shouldShowBuildFooter({
      intentRuntime: runtime,
      userText: "修正して",
      replyLines: ["追加で確認しますか？"],
    }),
    true,
  );
  assert.match(renderBuildFooter(runtime, { exitPrefix: "/" }), /\/back/);
  try {
    setLocale("en");
    const footer = renderBuildFooter(runtime, {
      exitPrefix: "/",
      languageHint: ["ニューススキルをチャットから呼び出せるように修正しました。"],
    });
    assert.match(footer, /ビルドモード/);
    assert.doesNotMatch(footer, /Currently in build mode/);
  } finally {
    setLocale(null);
  }
});

test("pending handoff approval enters build mode and forwards carry-over text", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const buildFlowUrl = pathToFileURL(path.resolve("dist/builder/build-flow.js")).href;
  const classifierUrl = pathToFileURL(
    path.resolve("dist/builder/build-action-classifier.js"),
  ).href;
  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const { createIntentRuntime, enterBuildMode, classifyPendingHandoff } = await import(
    buildFlowUrl
  );
  const { classifyHandoffApproval } = await import(classifierUrl);
  const { setAiProviderOverride } = await import(providerUrl);

  let builderText = "";
  setAiProviderOverride(async (_config, request) => {
    if (request.role === "builder") {
      builderText = request.messages.map((m) => String(m.content)).join("\n");
      return {
        text: builderFilesBlock("テキストを返せます", generatedPythonSkillFiles("auto-built")),
        model_id: request.model_id,
        provider: "test",
      };
    }
    return {
      text: JSON.stringify({
        decision: "approve",
        carry_over_text: "Codex GPT-5.5 と Claude Code Opus を使う",
        reason: "approval with extra reqs",
      }),
      model_id: request.model_id,
      provider: "test",
    };
  });

  try {
    const runtime = createIntentRuntime(true);
    runtime.pending = {
      type: "create",
      skill_id: "auto-built",
      original_text: "テキストを返すスキルを作って",
      reason: "manual",
    };
    const approval = await classifyPendingHandoff(
      testConfig(home),
      "つくって。Codex GPT-5.5 と Claude Code Opus を使う",
      [],
      runtime,
    );
    assert.equal(approval.decision, "approve");
    assert.match(approval.carry_over_text, /Codex/);
    const lines = await enterBuildMode(
      testConfig(home),
      [],
      runtime,
      {},
      approval.carry_over_text,
    );
    assert.ok(lines.length > 0);
    assert.equal(runtime.mode, "build");
    assert.equal(runtime.pending, null);
    assert.match(builderText, /テキストを返すスキルを作って/);
    assert.match(builderText, /Codex GPT-5\.5/);
    assert.ok(existsSync(path.join(home, "skills", "auto-built", "skill.yaml")));
  } finally {
    setAiProviderOverride(null);
  }
});

test("pending handoff classifier returns reject for explicit cancellation", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const buildFlowUrl = pathToFileURL(path.resolve("dist/builder/build-flow.js")).href;
  const providerUrl = pathToFileURL(path.resolve("dist/core/ai-provider.js")).href;
  const { createIntentRuntime, classifyPendingHandoff } = await import(buildFlowUrl);
  const { setAiProviderOverride } = await import(providerUrl);

  setAiProviderOverride(async (_config, request) => ({
    text: JSON.stringify({ decision: "reject", reason: "user cancelled" }),
    model_id: request.model_id,
    provider: "test",
  }));

  try {
    const runtime = createIntentRuntime(true);
    runtime.pending = {
      type: "create",
      skill_id: "auto-built",
      original_text: "テキストを返すスキルを作って",
      reason: "manual",
    };
    const approval = await classifyPendingHandoff(
      testConfig(home),
      "やっぱりキャンセル",
      [],
      runtime,
    );
    assert.equal(approval.decision, "reject");
  } finally {
    setAiProviderOverride(null);
  }
});

test("build mode auto-saves a missing env value embedded in natural text", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  const skillDir = path.join(home, "skills", "todoist-test");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: todoist-test
name: Todoist Test
description: Todoist env save test skill
runtime: python
entry: main.py
handler: run
invocation:
  phrases:
    - todoist-test
required_env:
  - name: TODOIST_API_TOKEN
    description: Todoist API token
input:
  schema:
    type: object
`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.py"),
    `async def run(ctx, input):
    return {"status": "ok", "summary": "ok", "outputs": {}, "data": {}, "suggestions": []}
`,
    "utf8",
  );

  const moduleUrl = pathToFileURL(path.resolve("dist/builder/build-flow.js")).href;
  const { createIntentRuntime, extractAutoSaveSecretValue, handleBuildModeMessage } = await import(moduleUrl);
  const token = "6c2224102d7ecacc84c87953c5d4efc421252a72a";
  assert.equal(extractAutoSaveSecretValue(`これです。いれて ${token}`, "TODOIST_API_TOKEN"), token);
  assert.equal(extractAutoSaveSecretValue("https://api.todoist.com/rest/v2", "TODOIST_API_TOKEN"), null);

  const runtime = createIntentRuntime(true);
  runtime.mode = "build";
  runtime.build = {
    type: "edit",
    skill_id: "todoist-test",
    skill_name: "Todoist Test",
    context_seed: [],
    context_consumed: true,
    original_text: "Todoistにする",
  };
  const lines = await handleBuildModeMessage(
    testConfig(home),
    `これです。いれて ${token}`,
    runtime,
  );
  assert.ok(lines);
  assert.match(lines.join("\n"), /TODOIST_API_TOKEN.*保存|Saved TODOIST_API_TOKEN/);
  assert.match(readFileSync(path.join(home, ".env"), "utf8"), new RegExp(`TODOIST_API_TOKEN=${token}`));
});

test("typescript runtime executes a registered TypeScript skill", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  const skillDir = path.join(home, "skills", "ts-echo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: ts-echo
name: TS Echo
description: TypeScript runtime test skill
runtime: typescript
entry: main.ts
handler: run
input:
  schema:
    type: object
    properties:
      text:
        type: string
    required:
      - text
outputs: []
ai_steps: []`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.ts"),
    `export async function run(ctx: any, input: any) {
  return {
    status: "ok",
    title: "TS完了",
    summary: String(input.args.text).toUpperCase(),
    outputs: {},
    data: { now: ctx.now() },
    suggestions: [],
  };
}
`,
    "utf8",
  );

  const result = run(["run", "ts-echo", "--text", "hello"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TS完了/);
  assert.match(result.stdout, /HELLO/);
});

test("typescript hybrid skill receives provider response from ctx.ai.run", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  const skillDir = path.join(home, "skills", "ts-ai-echo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: ts-ai-echo
name: TS AI Echo
description: TypeScript hybrid runtime test skill
runtime: typescript
entry: main.ts
handler: run
input:
  schema:
    type: object
    properties:
      text:
        type: string
    required:
      - text
outputs: []
ai_steps:
  - id: echo
    purpose: テスト用エコー
    model: codex`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.ts"),
    `export async function run(ctx: any, input: any) {
  const response = await ctx.ai.run("echo", input.args.text);
  return {
    status: "ok",
    title: "AI完了",
    summary: response.text,
    outputs: {},
    data: { provider: response.provider },
    suggestions: [],
  };
}
`,
    "utf8",
  );

  const result = runWithFakeProvider(["run", "ts-ai-echo", "--text", "hello-ai"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[fake:codex\] hello-ai/);
});

test("python hybrid skill round-trips ctx.ai.run via stderr/stdin RPC", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  const skillDir = path.join(home, "skills", "py-ai-echo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: py-ai-echo
name: PY AI Echo
description: Python hybrid runtime test skill
runtime: python
entry: main.py
handler: run
invocation:
  phrases:
    - py-ai-echo
    - run py-ai-echo
input:
  schema:
    type: object
    properties:
      text:
        type: string
    required:
      - text
outputs: []
ai_steps:
  - id: echo
    purpose: テスト用エコー
    model: codex`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.py"),
    `async def run(ctx, input):
    response = await ctx.ai.run("echo", input["args"]["text"])
    return {
        "status": "ok",
        "title": "AI完了",
        "summary": response.get("text", ""),
        "outputs": {},
        "data": {"provider": response.get("provider")},
        "suggestions": [],
    }
`,
    "utf8",
  );

  const result = runWithFakeProvider(["run", "py-ai-echo", "--text", "py-hello"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[fake:codex\] py-hello/);
});

test("skill memory persists through runtime-managed ctx.memory", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  const skillDir = path.join(home, "skills", "memory-counter");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: memory-counter
name: Memory Counter
description: Runtime memory persistence test skill
runtime: python
entry: main.py
handler: run
invocation:
  phrases:
    - memory-counter
    - run memory-counter
input:
  schema:
    type: object
    properties: {}
    required: []
outputs: []
ai_steps: []
memory:
  namespace: memory-counter
  read: true
  write: true`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.py"),
    `async def run(ctx, input):
    count = await ctx.memory.get("count") or 0
    count = int(count) + 1
    await ctx.memory.set("count", count)
    return {
        "status": "ok",
        "title": "カウント",
        "summary": str(count),
        "outputs": {},
        "data": {"count": count},
        "suggestions": [],
    }
`,
    "utf8",
  );

  const first = run(["run", "memory-counter"], home);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /memory:/);
  assert.match(first.stdout, /1/);

  const second = run(["run", "memory-counter"], home);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /2/);

  const memory = JSON.parse(readFileSync(path.join(home, "memory", "skill-memory", "memory-counter.json"), "utf8"));
  assert.equal(memory.count, 2);
});

test("runtime retries skill error results when retry is configured", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  const skillDir = path.join(home, "skills", "retry-once");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: retry-once
name: Retry Once
description: Retry policy test skill
runtime: python
entry: main.py
handler: run
input:
  schema:
    type: object
    properties: {}
    required: []
outputs: []
ai_steps: []
retry:
  max_attempts: 1
`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.py"),
    `from pathlib import Path

async def run(ctx, input):
    marker = Path(input["sources"]["workspace"]) / "retry-marker"
    if not marker.exists():
        marker.write_text("seen", encoding="utf-8")
        return {
            "status": "error",
            "title": "一時失敗",
            "summary": "retry",
            "outputs": {},
            "data": {},
            "suggestions": [],
        }
    return {
        "status": "ok",
        "title": "リトライ成功",
        "summary": "ok",
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
`,
    "utf8",
  );

  const retried = run(["run", "retry-once"], home);
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /リトライ成功/);
  assert.match(retried.stdout, /attempts: 2/);
});

test("build creates a session and review file under skills/<id>/.builder", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const build = run(["build", "sample-skill"], home);
  assert.equal(build.status, 0, build.stderr);

  const review = readFileSync(
    path.join(home, "skills", "sample-skill", ".builder", "review.md"),
    "utf8",
  );
  assert.match(review, /Registration Review/);
});

test("skills written into skills/<id>/ are immediately runnable", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);
  assert.equal(run(["build", "sample-register"], home).status, 0);
  const skillDir = path.join(home, "skills", "sample-register");

  writeFileSync(
    path.join(skillDir, "skill.yaml"),
    `
id: sample-register
name: Sample Register
description: Registration test skill
runtime: python
entry: main.py
handler: run
invocation:
  phrases:
    - sample-register
    - run sample-register
input:
  schema:
    type: object
    properties: {}
    required: []
outputs: []
ai_steps: []`,
    "utf8",
  );
  writeFileSync(
    path.join(skillDir, "main.py"),
    `async def run(ctx, input):
    return {
        "status": "ok",
        "title": "登録済み",
        "summary": "Build draftから実行しました",
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
`,
    "utf8",
  );
  mkdirSync(path.join(skillDir, "fixtures"), { recursive: true });
  writeFileSync(
    path.join(skillDir, "fixtures", "input.json"),
    `{}\n`,
    "utf8",
  );

  const tested = runWithFakeProvider(["build", "test", "sample-register"], home);
  assert.equal(tested.status, 0, tested.stderr || tested.stdout);
  assert.match(tested.stdout, /登録できます|Ready to use/);

  // Builder writes straight into skills/<id>/, so there is no separate register step.
  const result = run(["run", "sample-register"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /登録済み/);
});

test("builder chat writes a skill into skills/ and it runs immediately", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-"));
  assert.equal(run(["setup"], home).status, 0);

  const fakeDraft = builderFilesBlock("created echo skill", generatedPythonSkillFiles("agent-built"));
  const built = runWithFakeProvider(["build", "agent-built", "--prompt", "textを返すスキルを作って"], home, fakeDraft);
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /Build draft updated: agent-built/);
  assert.match(built.stdout, /\+ skill\.yaml/);

  const status = run(["build", "status", "agent-built"], home);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /agent-built: (登録済み|ready)/);

  const tested = run(["build", "test", "agent-built"], home);
  assert.equal(tested.status, 0, tested.stderr);
  assert.match(tested.stdout, /登録できます|Ready to use/);

  // No register step. The skill is already live in skills/<id>/.
  const result = run(["run", "agent-built", "--text", "production"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /生成スキル/);
  assert.match(result.stdout, /production/);
});
