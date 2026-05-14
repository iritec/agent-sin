import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const cli = path.resolve("dist/cli/index.js");

function run(args, home, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_SIN_LOCALE: "en",
      ...env,
      AGENT_SIN_HOME: home,
    },
    encoding: "utf8",
  });
}

function setupHome() {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-builtin-"));
  const result = run(["setup"], home);
  assert.equal(result.status, 0, result.stderr);
  return home;
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
    defaults: { note_format: "daily_markdown" },
    chat_model_id: "chat",
    builder_model_id: "builder",
  };
}

function builderFilesBlock(summary, files) {
  return `\`\`\`builder-files\n${JSON.stringify({ summary, files })}\n\`\`\``;
}

function simplePythonSkillFiles(id, name) {
  return {
    "skill.yaml": [
      `id: ${id}`,
      `name: ${name}`,
      "description: Customized builtin skill",
      "runtime: python",
      "entry: main.py",
      "handler: run",
      "invocation:",
      "  phrases:",
      `    - ${id}`,
      `    - run ${id}`,
      "input:",
      "  schema:",
      "    type: object",
      "",
    ].join("\n"),
    "main.py": [
      "async def run(ctx, input):",
      `    return {"status": "ok", "title": "${name}", "summary": "customized", "outputs": {}, "data": {}, "suggestions": []}`,
      "",
    ].join("\n"),
  };
}

test("builtin skills are listed without being copied into the workspace", () => {
  const home = setupHome();
  const skills = run(["skills"], home);
  assert.equal(skills.status, 0, skills.stderr);
  // Builtin skills are visible and tagged as such.
  assert.match(skills.stdout, /memo-save\t.*\tbuiltin/);
  assert.match(skills.stdout, /schedule-add\t.*\tbuiltin/);
  assert.match(skills.stdout, /profile-edit\t.*\tbuiltin/);
  // Workspace skills dir should be empty (no copy).
  const builtinCopy = path.join(home, "skills", "memo-save");
  assert.equal(existsSync(builtinCopy), false, "builtin must not be copied into workspace");
});

test("builtin skill metadata and result text follow locale", async () => {
  const home = setupHome();
  const registryUrl = pathToFileURL(path.resolve("dist/core/skill-registry.js")).href;
  const i18nUrl = pathToFileURL(path.resolve("dist/core/i18n.js")).href;
  const { listSkillManifests } = await import(registryUrl);
  const { setLocale } = await import(i18nUrl);

  try {
    setLocale("en");
    const english = await listSkillManifests(path.join(home, "skills"));
    const memoEn = english.find((skill) => skill.id === "memo-save");
    assert.equal(memoEn.name, "Memo Save");
    assert.equal(memoEn.description, "Save conversation text as a Markdown memo");
    assert.ok(memoEn.invocation.phrases.includes("save this memo"));
    const todoAddEn = english.find((skill) => skill.id === "todo-add");
    assert.match(todoAddEn.input.schema.properties.due.description, /Optional ISO8601/);

    setLocale("ja");
    const japanese = await listSkillManifests(path.join(home, "skills"));
    const memoJa = japanese.find((skill) => skill.id === "memo-save");
    assert.equal(memoJa.name, "メモ保存");
    assert.equal(memoJa.description, "会話内容をMarkdownメモとして保存する");
    assert.ok(memoJa.invocation.phrases.includes("メモして"));
  } finally {
    setLocale(null);
  }

  const enRun = run(["run", "memo-save", "--text", "hello"], home, { AGENT_SIN_LOCALE: "en" });
  assert.equal(enRun.status, 0, enRun.stderr);
  assert.match(enRun.stdout, /Saved/);
  assert.doesNotMatch(enRun.stdout, /保存しました/);

  const jaRun = run(["run", "memo-save", "--text", "こんにちは"], home, { AGENT_SIN_LOCALE: "ja" });
  assert.equal(jaRun.status, 0, jaRun.stderr);
  assert.match(jaRun.stdout, /保存しました/);
});

test("edit handoff shows todo candidates without internal override details", async () => {
  const home = setupHome();
  const buildFlowUrl = pathToFileURL(path.resolve("dist/builder/build-flow.js")).href;
  const { createIntentRuntime, enterBuildMode } = await import(buildFlowUrl);
  const runtime = createIntentRuntime(true);
  runtime.pending = {
    type: "edit",
    skill_id: "todo",
    original_text: "todoをTodoistにしたい",
    reason: "test",
  };

  const lines = await enterBuildMode(testConfig(home), [], runtime);
  const text = lines.join("\n");
  assert.match(text, /todo-add/);
  assert.match(text, /todo-list/);
  assert.doesNotMatch(text, /override|上書きコピー|workspace copy|packaged original/);
  assert.equal(existsSync(path.join(home, "skills", "todo")), false);
});

test("builtin edits keep override true even if builder rewrites skill.yaml", () => {
  const home = setupHome();
  const built = run(["build", "memo-save", "--prompt", "customize memo"], home, {
    AGENT_SIN_FAKE_PROVIDER: "1",
    AGENT_SIN_FAKE_TEXTS: builderFilesBlock(
      [
        'ビルトイン "memo-save" は本体を直接変更せず、ユーザー側の上書きコピーとして編集します。',
        "コピーには override: true を付けます。",
        "memo customized",
      ].join("\n"),
      simplePythonSkillFiles("memo-save", "Custom Memo"),
    ),
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  assert.doesNotMatch(built.stdout, /override|上書きコピー|ビルトイン.*本体/);
  assert.match(built.stdout, /memo customized/);

  const manifest = readFileSync(path.join(home, "skills", "memo-save", "skill.yaml"), "utf8");
  assert.match(manifest, /^override:\s*true$/m);

  const skills = run(["skills"], home);
  assert.equal(skills.status, 0, skills.stderr);
  assert.match(skills.stdout, /memo-save\tCustom Memo\tenabled\toverride/);
});

test("legacy workspace copy of a builtin is archived on next startup if modified", () => {
  const home = setupHome();
  const legacyPath = path.join(home, "skills", "memo-save");
  mkdirSync(legacyPath, { recursive: true });
  writeFileSync(
    path.join(legacyPath, "skill.yaml"),
    "id: memo-save\nname: legacy\nruntime: python\nentry: main.py\nhandler: run\ninput:\n  schema: {}\n",
  );
  writeFileSync(path.join(legacyPath, "main.py"), "# tampered\n");

  // any command that triggers ensureWorkspaceInitialized
  const after = run(["skills"], home);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(existsSync(legacyPath), false, "legacy copy should be moved away");
  const archiveRoot = path.join(home, "skills", ".archived-builtin-overrides", "memo-save");
  assert.ok(existsSync(archiveRoot), "archive directory should exist");
});

test("workspace builtin override with `override: true` is preserved", () => {
  const home = setupHome();
  const overridePath = path.join(home, "skills", "memo-save");
  mkdirSync(overridePath, { recursive: true });
  writeFileSync(
    path.join(overridePath, "skill.yaml"),
    [
      "id: memo-save",
      "name: Custom Memo",
      "description: User customised override",
      "runtime: python",
      "entry: main.py",
      "handler: run",
      "override: true",
      "input:",
      "  schema:",
      "    type: object",
      "    properties:",
      "      text:",
      "        type: string",
      "    required:",
      "      - text",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(overridePath, "main.py"),
    [
      "async def run(ctx, input):",
      '    return {"status": "ok", "title": "override", "summary": "user override", "outputs": {}, "data": {}, "suggestions": []}',
      "",
    ].join("\n"),
  );

  const skills = run(["skills"], home);
  assert.equal(skills.status, 0, skills.stderr);
  assert.match(skills.stdout, /memo-save\tCustom Memo\tenabled\toverride/);
  // override files survive migration:
  assert.ok(existsSync(path.join(overridePath, "skill.yaml")));
});

test("schedule-add / schedule-list / schedule-toggle / schedule-remove round trip", () => {
  const home = setupHome();

  const add = run(
    [
      "run",
      "schedule-add",
      "--payload",
      JSON.stringify({
        id: "test-daily",
        cron: "0 9 * * *",
        skill: "memo-save",
        description: "test entry",
        args: { text: "daily" },
      }),
    ],
    home,
  );
  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /test-daily/);

  const yamlPath = path.join(home, "schedules.yaml");
  let yaml = readFileSync(yamlPath, "utf8");
  assert.match(yaml, /id: test-daily/);
  assert.match(yaml, /cron: 0 9 \* \* \*/);
  assert.match(yaml, /skill: memo-save/);
  assert.match(yaml, /text: daily/);

  // duplicate id should fail
  const dup = run(
    [
      "run",
      "schedule-add",
      "--payload",
      JSON.stringify({ id: "test-daily", cron: "0 8 * * *", skill: "memo-save" }),
    ],
    home,
  );
  assert.notEqual(dup.status, 0, "duplicate id should fail");

  // invalid cron should fail
  const bad = run(
    [
      "run",
      "schedule-add",
      "--payload",
      JSON.stringify({ id: "bad", cron: "0 9 *", skill: "memo-save" }),
    ],
    home,
  );
  assert.notEqual(bad.status, 0, "invalid cron should fail");

  const list = run(["run", "schedule-list", "--payload", "{}"], home);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /test-daily/);

  const toggleOff = run(
    [
      "run",
      "schedule-toggle",
      "--payload",
      JSON.stringify({ id: "test-daily", enabled: false }),
    ],
    home,
  );
  assert.equal(toggleOff.status, 0, toggleOff.stderr);
  yaml = readFileSync(yamlPath, "utf8");
  assert.match(yaml, /enabled: false/);

  const remove = run(
    ["run", "schedule-remove", "--payload", JSON.stringify({ id: "test-daily" })],
    home,
  );
  assert.equal(remove.status, 0, remove.stderr);
  yaml = readFileSync(yamlPath, "utf8");
  assert.doesNotMatch(yaml, /id: test-daily/);
});

test("profile-edit and profile-delete operate on existing entries", () => {
  const home = setupHome();
  // seed two entries via profile-save
  run(["run", "profile-save", "--target", "memory", "--text", "最初のエントリ"], home);
  run(["run", "profile-save", "--target", "memory", "--text", "ふたつめのエントリ"], home);

  const file = path.join(home, "memory", "profile", "memory.md");
  let raw = readFileSync(file, "utf8");
  assert.match(raw, /最初のエントリ/);
  assert.match(raw, /ふたつめのエントリ/);

  const edit = run(
    [
      "run",
      "profile-edit",
      "--payload",
      JSON.stringify({ target: "memory", index: 1, text: "編集後の本文" }),
    ],
    home,
  );
  assert.equal(edit.status, 0, edit.stderr);
  raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /最初のエントリ/);
  assert.match(raw, /編集後の本文/);
  assert.match(raw, /ふたつめのエントリ/);

  const del = run(
    [
      "run",
      "profile-delete",
      "--payload",
      JSON.stringify({ target: "memory", index: 2 }),
    ],
    home,
  );
  assert.equal(del.status, 0, del.stderr);
  raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /ふたつめのエントリ/);
  assert.match(raw, /編集後の本文/);
});

test("memo-delete removes a matching line from today's note", () => {
  const home = setupHome();
  run(["run", "memo-save", "--text", "MeMo-One alpha"], home);
  run(["run", "memo-save", "--text", "MeMo-Two beta"], home);

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const note = path.join(home, "notes", yyyy, mm, `${yyyy}-${mm}-${dd}.md`);
  let raw = readFileSync(note, "utf8");
  assert.match(raw, /MeMo-One/);
  assert.match(raw, /MeMo-Two/);

  const del = run(
    [
      "run",
      "memo-delete",
      "--payload",
      JSON.stringify({ match: "MeMo-One" }),
    ],
    home,
  );
  assert.equal(del.status, 0, del.stderr);
  raw = readFileSync(note, "utf8");
  assert.doesNotMatch(raw, /MeMo-One/);
  assert.match(raw, /MeMo-Two/);
});

test("agent-sin skills restore reports clean state when no legacy copies exist", () => {
  const home = setupHome();
  const restore = run(["skills", "restore"], home);
  assert.equal(restore.status, 0, restore.stderr);
  assert.match(restore.stdout, /整合済み|Already in sync/);
});

test("skills enable/disable toggles a builtin without touching the package files", () => {
  const home = setupHome();

  // 初期状態: schedule-add は有効
  const before = run(["skills"], home);
  assert.match(before.stdout, /schedule-add\t.*\tenabled\tbuiltin/);

  const off = run(["skills", "disable", "schedule-add"], home);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /無効化|Disabled/);

  const afterOff = run(["skills"], home);
  assert.match(afterOff.stdout, /schedule-add\t.*\tdisabled\tbuiltin/);

  // skill-settings.yaml にエントリが書かれる
  const settingsPath = path.join(home, "skill-settings.yaml");
  const settings = readFileSync(settingsPath, "utf8");
  assert.match(settings, /schedule-add/);

  // 無効化した builtin は実行できない
  const blocked = run(
    [
      "run",
      "schedule-add",
      "--payload",
      JSON.stringify({ id: "x", cron: "0 0 * * *", skill: "memo-save" }),
    ],
    home,
  );
  assert.notEqual(blocked.status, 0, "disabled skill should refuse to run");

  // 再有効化
  const on = run(["skills", "enable", "schedule-add"], home);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /有効化|Enabled/);

  const afterOn = run(["skills"], home);
  assert.match(afterOn.stdout, /schedule-add\t.*\tenabled\tbuiltin/);

  // 二度目の disable→enable はno-op
  run(["skills", "disable", "schedule-add"], home);
  const dup = run(["skills", "disable", "schedule-add"], home);
  assert.match(dup.stdout, /既に無効|already disabled/);
});

test("tampered legacy copies are migrated away by the next CLI invocation", () => {
  const home = setupHome();
  const legacy = path.join(home, "skills", "todo-add");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(
    path.join(legacy, "skill.yaml"),
    "id: todo-add\nname: tampered\nruntime: python\nentry: main.py\nhandler: run\ninput:\n  schema: {}\n",
  );
  writeFileSync(path.join(legacy, "main.py"), "# tampered\n");

  const after = run(["skills"], home);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(existsSync(legacy), false, "tampered legacy copy should be moved away");
  const archiveRoot = path.join(home, "skills", ".archived-builtin-overrides", "todo-add");
  assert.ok(existsSync(archiveRoot), "archive directory should exist for the legacy todo-add");
});
