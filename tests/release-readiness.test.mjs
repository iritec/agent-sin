import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const cli = path.resolve("dist/cli/index.js");

function run(args, home, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_SIN_LOCALE: "en",
      ...extraEnv,
      AGENT_SIN_HOME: home,
    },
    encoding: "utf8",
  });
}

function setupHome(prefix = "agent-sin-release-") {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  const setup = run(["setup", "--yes"], home);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
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
    defaults: {
      note_format: "daily_markdown",
    },
    chat_model_id: "chat",
    builder_model_id: "builder",
  };
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

function builderFilesBlock(summary, files) {
  return `\`\`\`builder-files\n${JSON.stringify({ summary, files })}\n\`\`\``;
}

function generatedPythonSkillFiles(id) {
  return {
    "skill.yaml": `
id: ${id}
name: ${id}
description: Release smoke skill
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
outputs: []`,
    "main.py": `async def run(ctx, input):
    text = str(input["args"].get("text", ""))
    return {
        "status": "ok",
        "title": "${id}",
        "summary": text,
        "outputs": {},
        "data": {"text": text},
        "suggestions": [],
    }
`,
    "fixtures/input.json": `{"text":"release"}\n`,
  };
}

function fakeChromaEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-sin-fake-chroma-"));
  mkdirSync(path.join(root, "chromadb", "utils"), { recursive: true });
  writeFileSync(
    path.join(root, "chromadb", "__init__.py"),
    `
import json
import os

class PersistentClient:
    def __init__(self, path):
        self.path = path
        os.makedirs(path, exist_ok=True)

    def get_or_create_collection(self, name, embedding_function=None):
        return Collection(self.path, name)

class Collection:
    def __init__(self, root, name):
        self.file = os.path.join(root, f"{name}.json")
        self.items = []
        if os.path.exists(self.file):
            with open(self.file, "r", encoding="utf-8") as f:
                self.items = json.load(f)

    def _save(self):
        os.makedirs(os.path.dirname(self.file), exist_ok=True)
        with open(self.file, "w", encoding="utf-8") as f:
            json.dump(self.items, f, ensure_ascii=False)

    def get(self):
        return {"ids": [item["id"] for item in self.items]}

    def add(self, documents, ids, metadatas):
        known = {item["id"] for item in self.items}
        for doc, doc_id, meta in zip(documents, ids, metadatas):
            if doc_id not in known:
                self.items.append({"id": doc_id, "document": doc, "metadata": meta or {}})
        self._save()

    def query(self, query_texts, n_results=5):
        query = str((query_texts or [""])[0]).lower()
        tokens = [part for part in query.split() if part]
        scored = []
        for item in self.items:
            doc = str(item.get("document", ""))
            lower = doc.lower()
            hit = query in lower or any(token in lower for token in tokens)
            scored.append((0.0 if hit else 1.0, item))
        scored.sort(key=lambda pair: pair[0])
        top = scored[:n_results]
        return {
            "documents": [[item["document"] for _, item in top]],
            "metadatas": [[item.get("metadata", {}) for _, item in top]],
            "distances": [[distance for distance, _ in top]],
        }
`,
    "utf8",
  );
  writeFileSync(path.join(root, "chromadb", "utils", "__init__.py"), "", "utf8");
  writeFileSync(
    path.join(root, "chromadb", "utils", "embedding_functions.py"),
    `
class SentenceTransformerEmbeddingFunction:
    def __init__(self, model_name=None):
        self.model_name = model_name
`,
    "utf8",
  );
  return {
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
}

test("every configured model can answer in chat and build mode with the provider facade", async () => {
  const home = setupHome("agent-sin-models-");
  const configUrl = pathToFileURL(path.resolve("dist/core/config.js")).href;
  const { loadModels, defaultModels, writeModelsYaml, modelsPath } = await import(configUrl);

  // 初回 setup ではテンプレ（chat / builder のみ active）が書かれる。
  // 旧テストが期待していた「全プロバイダで facade を呼べる」カバレッジを
  // 維持するため、各プロバイダ種別を一旦明示的に書き込んでから検証する。
  await writeModelsYaml(modelsPath(home), defaultModels());

  const models = await loadModels(home);
  const modelIds = Object.keys(models.models);
  assert.ok(modelIds.includes("anthropic"), "default models should include the direct Anthropic API provider");
  assert.ok(modelIds.includes("gemini"), "default models should include the Gemini API provider");
  assert.ok(modelIds.includes("openai"), "default models should include the OpenAI API provider");

  for (const modelId of modelIds) {
    assertOk(run(["model", "set", "chat", modelId], home), `model set chat ${modelId}`);
    const chat = run(["chat", `ping ${modelId}`], home, { AGENT_SIN_FAKE_PROVIDER: "1" });
    assertOk(chat, `chat ${modelId}`);
    assert.match(chat.stdout, new RegExp(`\\[fake:${escapeRegExp(modelId)}\\]`));

    assertOk(run(["model", "set", "builder", modelId], home), `model set builder ${modelId}`);
    const skillId = `model-${modelId.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const built = run(["build", skillId, "--prompt", "textを返すスキルを作って"], home, {
      AGENT_SIN_FAKE_PROVIDER: "1",
      AGENT_SIN_FAKE_TEXTS: builderFilesBlock("release smoke", generatedPythonSkillFiles(skillId)),
    });
    assertOk(built, `build ${modelId}`);
    assert.match(built.stdout, /Build draft updated/);

    const tested = run(["build", "test", skillId], home, { AGENT_SIN_FAKE_PROVIDER: "1" });
    assertOk(tested, `build test ${modelId}`);
    assert.match(tested.stdout, /登録できます|Ready to use/);
  }
});

test("every packaged builtin skill is valid and discoverable", async () => {
  const home = setupHome("agent-sin-builtin-valid-");
  const registryUrl = pathToFileURL(path.resolve("dist/core/skill-registry.js")).href;
  const scaffoldUrl = pathToFileURL(path.resolve("dist/core/skill-scaffold.js")).href;
  const { builtinSkillsDir, listSkillManifests } = await import(registryUrl);
  const { validateSkillDirectory, loadKnownModelIds } = await import(scaffoldUrl);
  const builtinRoot = builtinSkillsDir();
  const ids = readdirSync(builtinRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(builtinRoot, entry.name, "skill.yaml")))
    .map((entry) => entry.name)
    .sort();
  assert.ok(ids.length > 0, "builtin skills should be packaged");

  const config = testConfig(home);
  const knownModelIds = await loadKnownModelIds(config);
  for (const id of ids) {
    const validation = await validateSkillDirectory(path.join(builtinRoot, id), id, { knownModelIds });
    assert.equal(validation.ok, true, `${id}: ${validation.errors.join("\n")}`);
    assert.ok(validation.manifest.description, `${id} should describe when it is useful`);
    const phrases = validation.manifest.invocation?.phrases || [];
    assert.ok(
      validation.manifest.invocation?.command || phrases.length > 0,
      `${id} should have invocation hints`,
    );
  }

  const manifests = await listSkillManifests(config.skills_dir);
  const discovered = manifests
    .filter((manifest) => manifest.source === "builtin")
    .map((manifest) => manifest.id)
    .sort();
  assert.deepEqual(discovered, ids);
});

test("builtin skills cover memo, semantic search, profile, schedule, and todo flows", () => {
  const home = setupHome("agent-sin-builtins-");
  const chromaEnv = fakeChromaEnv();
  const expected = [
    "memo-delete",
    "memo-index",
    "memo-save",
    "memo-search",
    "memo-vector-search",
    "profile-delete",
    "profile-edit",
    "profile-save",
    "schedule-add",
    "schedule-list",
    "schedule-remove",
    "schedule-toggle",
    "skills-disable",
    "skills-enable",
    "todo-add",
    "todo-delete",
    "todo-done",
    "todo-list",
    "todo-tick",
  ];

  const listed = run(["skills"], home);
  assertOk(listed, "skills");
  for (const id of expected) {
    assert.match(listed.stdout, new RegExp(`^${id}\\t`, "m"), `${id} should be listed`);
  }

  assertOk(run(["run", "memo-save", "--text", "意味検索テストの散歩メモ"], home), "memo-save");
  assertOk(run(["run", "memo-search", "--query", "散歩"], home), "memo-search");
  assertOk(run(["run", "memo-index"], home, chromaEnv), "memo-index");
  const vector = run(["run", "memo-vector-search", "--query", "散歩", "--limit", "1"], home, chromaEnv);
  assertOk(vector, "memo-vector-search");
  assert.match(vector.stdout, /(1件見つかりました|1 matches)/);
  assert.match(vector.stdout, /散歩メモ/);
  assertOk(
    run(["run", "memo-delete", "--payload", JSON.stringify({ match: "意味検索テスト" })], home),
    "memo-delete",
  );

  assertOk(
    run(["run", "profile-save", "--target", "memory", "--text", "初期プロフィール"], home),
    "profile-save",
  );
  assertOk(
    run(
      ["run", "profile-edit", "--payload", JSON.stringify({ target: "memory", index: 1, text: "更新プロフィール" })],
      home,
    ),
    "profile-edit",
  );
  assertOk(
    run(["run", "profile-delete", "--payload", JSON.stringify({ target: "memory", index: 1 })], home),
    "profile-delete",
  );

  assertOk(
    run(
      [
        "run",
        "schedule-add",
        "--payload",
        JSON.stringify({ id: "release-smoke", cron: "0 9 * * *", skill: "memo-save", args: { text: "scheduled" } }),
      ],
      home,
    ),
    "schedule-add",
  );
  assertOk(run(["run", "schedule-list", "--payload", "{}"], home), "schedule-list");
  assertOk(
    run(["run", "schedule-toggle", "--payload", JSON.stringify({ id: "release-smoke", enabled: false })], home),
    "schedule-toggle",
  );
  assertOk(
    run(["run", "schedule-remove", "--payload", JSON.stringify({ id: "release-smoke" })], home),
    "schedule-remove",
  );

  assertOk(run(["run", "todo-add", "--text", "リリース確認"], home), "todo-add");
  const todoMemory = JSON.parse(readFileSync(path.join(home, "memory", "skill-memory", "todo.json"), "utf8"));
  const todoId = String(todoMemory.items[0].id);
  assertOk(run(["run", "todo-list", "--payload", JSON.stringify({ status: "all" })], home), "todo-list");
  assertOk(run(["run", "todo-done", "--id", todoId.slice(0, 4)], home), "todo-done");
  assertOk(run(["run", "todo-delete", "--id", todoId.slice(0, 4)], home), "todo-delete");

  const disableResult = run(["run", "skills-disable", "--payload", JSON.stringify({ id: "todo-add" })], home);
  assertOk(disableResult, "skills-disable");
  const settingsPath = path.join(home, "skill-settings.yaml");
  assert.match(readFileSync(settingsPath, "utf8"), /todo-add/);
  const skillsAfterDisable = run(["skills"], home);
  assertOk(skillsAfterDisable, "skills list after disable");
  assert.match(skillsAfterDisable.stdout, /todo-add\t.*\tdisabled|todo-add\t.*\t無効/);

  const enableResult = run(["run", "skills-enable", "--payload", JSON.stringify({ id: "todo-add" })], home);
  assertOk(enableResult, "skills-enable");
  assert.doesNotMatch(readFileSync(settingsPath, "utf8"), /^\s*-\s*todo-add\s*$/m);
});

test("skill scaffolding, validation, dry-run, and direct run work for Python and TypeScript", () => {
  const home = setupHome("agent-sin-skill-new-");
  for (const [id, runtime] of [
    ["release-py", "python"],
    ["release-ts", "typescript"],
  ]) {
    assertOk(run(["skill", "new", id, "--runtime", runtime, "--name", id], home), `skill new ${id}`);
    assert.ok(existsSync(path.join(home, "skills", id, "skill.yaml")));
    const validate = run(["skill", "validate", id], home);
    assertOk(validate, `skill validate ${id}`);
    assert.match(validate.stdout, new RegExp(`\\[ok\\] ${id}`));
    const tested = run(["skill", "test", id, "--payload", JSON.stringify({ text: "hello" })], home);
    assertOk(tested, `skill test ${id}`);
    assert.match(tested.stdout, /\[dry-run\] ok/);
    const direct = run(["run", id, "--text", "hello"], home);
    assertOk(direct, `run ${id}`);
    assert.match(direct.stdout, /処理しました|Processed/);
  }
});

test("safe terminal command surface responds without starting long-lived integrations", () => {
  const home = setupHome("agent-sin-commands-");
  const manifestCommand = process.platform === "win32" ? ["service", "manifest"] : ["service", "plist"];
  const commands = [
    ["help"],
    ["setup", "--help"],
    ["skills"],
    ["skills", "list"],
    ["skills", "restore"],
    ["models"],
    ["models", "keys", "--provider", "openai"],
    ["config"],
    ["profile", "init"],
    ["profile", "path"],
    ["profile", "append", "user", "短い報告を好む"],
    ["profile", "show", "user"],
    ["logs"],
    ["logs", "--events"],
    ["schedules"],
    ["daemon", "--once"],
    ["gateway", "--no-discord", "--no-telegram", "--once"],
    ["service", "status"],
    ["service", "help"],
    manifestCommand,
    ["discord", "--help"],
    ["telegram", "--help"],
    ["notify", "--channel", "stderr", "--title", "release", "--body", "ok"],
  ];

  for (const args of commands) {
    assertOk(run(args, home), args.join(" "));
  }
});

test("Python virtualenv lookup covers macOS/Linux and Windows layouts", async () => {
  const url = pathToFileURL(path.resolve("dist/runtimes/python-runner.js")).href;
  const { candidatePythonInterpreters } = await import(url);
  const config = { workspace: path.join(tmpdir(), "agent-sin-venv") };

  const darwin = candidatePythonInterpreters(config, "darwin");
  assert.equal(darwin[0], path.join(config.workspace, ".venv", "bin", "python"));
  assert.equal(darwin.at(-1), "python3");

  const win32 = candidatePythonInterpreters(config, "win32");
  assert.equal(win32[0], path.join(config.workspace, ".venv", "Scripts", "python.exe"));
  assert.equal(win32[1], path.join(config.workspace, ".venv", "Scripts", "python"));
  assert.equal(win32.at(-1), "python");
});

test("service manifests render for macOS and Windows without platform-specific side effects", async () => {
  const url = pathToFileURL(path.resolve("dist/core/service.js")).href;
  const { renderServiceManifestForPlatform } = await import(url);
  const workspace = path.join(tmpdir(), "agent sin & workspace");
  const config = {
    workspace,
    logs_dir: path.join(workspace, "logs"),
  };

  const mac = renderServiceManifestForPlatform(config, "darwin");
  assert.equal(mac.label, "com.agent-sin.gateway");
  assert.equal(mac.manifestKind, "plist");
  assert.match(mac.text, /<key>Label<\/key>/);
  assert.match(mac.text, /<string>com\.agent-sin\.gateway<\/string>/);
  assert.match(mac.text, /<key>AGENT_SIN_HOME<\/key>/);
  assert.match(mac.text, /service<\/string>\s*<string>run<\/string>/);

  const win = renderServiceManifestForPlatform(config, "win32");
  assert.equal(win.label, "Agent-Sin Gateway");
  assert.equal(win.manifestKind, "schtasks");
  assert.match(win.text, /<Task version="1\.4"/);
  assert.match(win.text, /Agent-Sin Gateway: scheduler \+ Discord\/Telegram bots/);
  assert.match(win.text, /service&quot; &quot;run/);
  assert.match(win.text, /agent sin &amp; workspace/);
});

test("Discord and Telegram bot entrypoints fail closed without required allowlists", async () => {
  const home = setupHome("agent-sin-bots-");
  const discordUrl = pathToFileURL(path.resolve("dist/discord/bot.js")).href;
  const telegramUrl = pathToFileURL(path.resolve("dist/telegram/bot.js")).href;
  const { runDiscordBot } = await import(discordUrl);
  const { runTelegramBot } = await import(telegramUrl);
  const previous = {
    discordToken: process.env.AGENT_SIN_DISCORD_BOT_TOKEN,
    discordAllowed: process.env.AGENT_SIN_DISCORD_ALLOWED_USER_IDS,
    telegramToken: process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN,
    telegramAllowed: process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS,
  };
  try {
    process.env.AGENT_SIN_DISCORD_BOT_TOKEN = "discord-token";
    delete process.env.AGENT_SIN_DISCORD_ALLOWED_USER_IDS;
    assert.equal(await runDiscordBot({ workspace: home }), 1);

    process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN = "telegram-token";
    delete process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS;
    assert.equal(await runTelegramBot({ workspace: home }), 1);
  } finally {
    restoreEnv("AGENT_SIN_DISCORD_BOT_TOKEN", previous.discordToken);
    restoreEnv("AGENT_SIN_DISCORD_ALLOWED_USER_IDS", previous.discordAllowed);
    restoreEnv("AGENT_SIN_TELEGRAM_BOT_TOKEN", previous.telegramToken);
    restoreEnv("AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS", previous.telegramAllowed);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
