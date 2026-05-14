import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  MODELS_YAML_TEMPLATE,
  PROVIDER_CATALOG,
  deriveSetupChoiceId,
  loadModels,
  renderModelsYamlFromChoices,
  setupWorkspace,
  writeModelsYaml,
} from "../dist/core/config.js";

function freshWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "agent-sin-models-tmpl-"));
}

test("setupWorkspace writes a commented template on first run", async () => {
  const workspace = freshWorkspace();
  await setupWorkspace({ workspace });

  const content = readFileSync(path.join(workspace, "models.yaml"), "utf8");

  assert.match(content, /^# agent-sin model registry/, "should keep header comment");
  assert.match(content, /# Google Gemini API/, "should keep gemini example comment");
  assert.match(content, /# Anthropic Claude API/, "should keep anthropic example comment");
  assert.match(content, /# OpenAI API/, "should keep openai example comment");
  assert.match(content, /# Ollama/, "should keep ollama example comment");
  assert.match(content, /# Claude Code CLI/, "should keep claude-code example comment");
  assert.match(content, /^roles:\s*$/m, "roles block should be uncommented");
  assert.match(content, /^\s*chat:\s+codex-low\b/m, "roles.chat should point to codex-low");
  assert.match(content, /^\s*builder:\s+codex-xhigh\b/m, "roles.builder should point to codex-xhigh");
  assert.match(content, /^\s*codex-low:\s*$/m, "codex-low entry should be uncommented");
  assert.match(content, /^\s*codex-xhigh:\s*$/m, "codex-xhigh entry should be uncommented");
  assert.match(content, /^\s*# gemini:/m, "gemini entry should remain commented");
});

test("writeModelsYaml preserves comments on subsequent updates", async () => {
  const workspace = freshWorkspace();
  await setupWorkspace({ workspace });

  const file = path.join(workspace, "models.yaml");
  const before = readFileSync(file, "utf8");
  assert.ok(before.includes("# Google Gemini API"));

  await writeModelsYaml(file, {
    roles: { chat: "codex-low", builder: "codex-xhigh" },
    models: {
      "codex-low": { type: "cli", provider: "codex", model: "gpt-5.5", effort: "medium", enabled: true },
      "codex-xhigh": { type: "cli", provider: "codex", model: "gpt-5.5", effort: "xhigh", enabled: true },
    },
  });

  const after = readFileSync(file, "utf8");
  assert.match(after, /# Google Gemini API/, "gemini example comment must survive update");
  assert.match(after, /# Anthropic Claude API/, "anthropic example comment must survive update");
  assert.match(after, /effort:\s*medium/, "codex-low.effort should be updated");
  assert.match(after, /^\s*# gemini:/m, "gemini block should still be commented out");
});

test("setupWorkspace can reconfigure an existing models.yaml", async () => {
  const workspace = freshWorkspace();
  await setupWorkspace({ workspace });

  const config = await setupWorkspace({
    workspace,
    initialModels: {
      chat: { provider: "openai", model: "gpt-5.5" },
      builder: { provider: "claude-code", model: "opus", effort: "high" },
    },
  });

  const loaded = await loadModels(workspace);
  const content = readFileSync(path.join(workspace, "models.yaml"), "utf8");
  const backups = readdirSync(workspace).filter((name) => name.startsWith("models.yaml.bak-"));

  assert.equal(config.chat_model_id, "openai");
  assert.equal(config.builder_model_id, "claude-code-high");
  assert.equal(loaded.roles?.chat, "openai");
  assert.equal(loaded.roles?.builder, "claude-code-high");
  assert.equal(loaded.models.openai.enabled, true);
  assert.equal(loaded.models["claude-code-high"].effort, "high");
  assert.match(content, /# Google Gemini API/, "existing comments should be preserved");
  assert.equal(backups.length, 0, "reconfigure must not leave .bak-* files in the workspace");
});

test("writeModelsYaml leaves user-added comments intact", async () => {
  const workspace = freshWorkspace();
  const file = path.join(workspace, "models.yaml");
  writeFileSync(
    file,
    `# my personal config
models:
  chat:
    type: login
    provider: codex
    model: gpt-5.5
    effort: low
    enabled: true
  # comment between entries
  openai:
    type: api
    provider: openai
    model: gpt-5.5
    enabled: true
`,
    "utf8",
  );

  await writeModelsYaml(file, {
    models: {
      chat: { type: "login", provider: "codex", model: "gpt-5.5", effort: "low", enabled: true },
      openai: { type: "api", provider: "openai", model: "gpt-5.5", enabled: false },
    },
  });

  const out = readFileSync(file, "utf8");
  assert.match(out, /# my personal config/, "header comment must survive");
  assert.match(out, /# comment between entries/, "in-line comment must survive");
  assert.match(out, /enabled:\s*false/, "openai.enabled should be updated to false");
});

test("migrateModelsYamlIfLegacy renames legacy IDs and login→cli, preserving comments", async () => {
  const workspace = freshWorkspace();
  const file = path.join(workspace, "models.yaml");
  writeFileSync(
    file,
    `# user notes
models:
  chat:
    type: login
    provider: codex
    model: gpt-5.5
    effort: low
    enabled: true
  builder:
    type: login
    provider: codex
    model: gpt-5.5
    effort: xhigh
    enabled: true
  # my ollama tag
  gemma4:
    type: ollama
    model: gemma4:26b
    enabled: true
`,
    "utf8",
  );

  const { migrateModelsYamlIfLegacy } = await import("../dist/core/config.js");
  const result = await migrateModelsYamlIfLegacy(workspace);
  assert.equal(result.changed, true);
  assert.deepEqual(result.renamed, { chat: "codex-low", builder: "codex-xhigh" });

  const after = readFileSync(file, "utf8");
  assert.match(after, /# user notes/, "header comment preserved");
  assert.match(after, /# my ollama tag/, "inline comment preserved");
  assert.doesNotMatch(after, /type:\s*login/, "no remaining type: login");
  assert.match(after, /^\s*codex-low:\s*$/m, "renamed codex-low entry");
  assert.match(after, /^\s*codex-xhigh:\s*$/m, "renamed codex-xhigh entry");
  assert.match(after, /^roles:/m, "roles block added");
  assert.match(after, /chat:\s*codex-low/, "roles.chat points to renamed id");
  assert.match(after, /builder:\s*codex-xhigh/, "roles.builder points to renamed id");
});

test("migrateModelsYamlIfLegacy respects preferredRoles (user's existing choice)", async () => {
  const workspace = freshWorkspace();
  const file = path.join(workspace, "models.yaml");
  writeFileSync(
    file,
    `models:
  chat:
    type: login
    provider: codex
    enabled: true
  builder:
    type: login
    provider: codex
    enabled: true
  openai:
    type: api
    provider: openai
    model: gpt-5.5
    enabled: true
`,
    "utf8",
  );

  const { migrateModelsYamlIfLegacy } = await import("../dist/core/config.js");
  await migrateModelsYamlIfLegacy(workspace, {
    preferredRoles: { chat: "openai", builder: "builder" },
  });

  const after = readFileSync(file, "utf8");
  // user explicitly chose openai for chat → roles.chat should still be openai
  assert.match(after, /chat:\s*openai/, "preferredRoles.chat must win over renamed legacy id");
  // builder was the legacy literal → should resolve to renamed codex-xhigh
  assert.match(after, /builder:\s*codex-xhigh/, "legacy builder id should resolve to renamed");
});

test("migrateModelsYamlIfLegacy is a no-op on already-migrated files", async () => {
  const workspace = freshWorkspace();
  const file = path.join(workspace, "models.yaml");
  writeFileSync(file, MODELS_YAML_TEMPLATE, "utf8");

  const { migrateModelsYamlIfLegacy } = await import("../dist/core/config.js");
  const result = await migrateModelsYamlIfLegacy(workspace);
  assert.equal(result.changed, false);
});

test("renderModelsYamlFromChoices builds a valid YAML with chosen chat/builder", async () => {
  const yaml = renderModelsYamlFromChoices(
    { provider: "codex", model: "gpt-5.5", effort: "low" },
    { provider: "openai", model: "gpt-5.5" },
  );
  // roles points to the derived ids
  assert.match(yaml, /^roles:\s*\n\s*chat:\s+codex-low/m);
  assert.match(yaml, /^\s*builder:\s+openai/m);
  // both active entries present
  assert.match(yaml, /^\s*codex-low:\s*$/m);
  assert.match(yaml, /^\s*openai:\s*$/m);
  // openai must NOT appear in commented examples (already active)
  const exampleBlock = yaml.split("以下は例")[1] || "";
  assert.doesNotMatch(exampleBlock, /^\s*#\s+openai:/m, "active openai must not be duplicated as a comment");
  // codex also active (codex-low), so not in commented examples either
  assert.doesNotMatch(exampleBlock, /^\s*#\s+codex:/m, "active codex must not be duplicated as a comment");
  // other providers should be present as commented examples
  assert.match(yaml, /^\s*#\s+gemini:/m);
  assert.match(yaml, /^\s*#\s+anthropic:/m);
  assert.match(yaml, /^\s*#\s+ollama:/m);
});

test("renderModelsYamlFromChoices collapses duplicate chat/builder into one entry", async () => {
  const yaml = renderModelsYamlFromChoices(
    { provider: "codex", model: "gpt-5.5", effort: "medium" },
    { provider: "codex", model: "gpt-5.5", effort: "medium" },
  );
  const matches = yaml.match(/^\s*codex-medium:\s*$/gm) || [];
  assert.equal(matches.length, 1, "same chat/builder choice must produce one active entry");
});

test("deriveSetupChoiceId produces stable ids for chat/builder", () => {
  assert.equal(
    deriveSetupChoiceId({ provider: "codex", effort: "low" }, "chat"),
    "codex-low",
  );
  assert.equal(
    deriveSetupChoiceId({ provider: "codex", effort: "xhigh" }, "builder"),
    "codex-xhigh",
  );
  assert.equal(deriveSetupChoiceId({ provider: "openai" }, "chat"), "openai");
  assert.equal(deriveSetupChoiceId({ provider: "gemini" }, "builder"), "gemini");
  assert.equal(deriveSetupChoiceId({ provider: "ollama" }, "chat"), "ollama");
});

test("same provider but different models keep distinct chat/builder entries", async () => {
  const workspace = freshWorkspace();
  const config = await setupWorkspace({
    workspace,
    initialModels: {
      chat: { provider: "openai", model: "gpt-5.4-mini" },
      builder: { provider: "openai", model: "gpt-5.5" },
    },
  });

  const loaded = await loadModels(workspace);
  assert.equal(config.chat_model_id, "openai-chat");
  assert.equal(config.builder_model_id, "openai-builder");
  assert.equal(loaded.roles?.chat, "openai-chat");
  assert.equal(loaded.roles?.builder, "openai-builder");
  assert.equal(loaded.models["openai-chat"].model, "gpt-5.4-mini");
  assert.equal(loaded.models["openai-builder"].model, "gpt-5.5");
});

test("PROVIDER_CATALOG covers all dispatcher branches", () => {
  const ids = PROVIDER_CATALOG.map((p) => p.id);
  for (const required of ["codex", "claude-code", "openai", "gemini", "anthropic", "ollama"]) {
    assert.ok(ids.includes(required), `PROVIDER_CATALOG must include ${required}`);
  }
});

test("MODELS_YAML_TEMPLATE parses to a valid config with chat & builder active", async () => {
  const workspace = freshWorkspace();
  const file = path.join(workspace, "models.yaml");
  writeFileSync(file, MODELS_YAML_TEMPLATE, "utf8");

  const { loadModels } = await import("../dist/core/config.js");
  const loaded = await loadModels(workspace);
  assert.equal(loaded.models["codex-low"].enabled, true);
  assert.equal(loaded.models["codex-xhigh"].enabled, true);
  assert.equal(loaded.models["codex-low"].provider, "codex");
  assert.equal(loaded.roles?.chat, "codex-low");
  assert.equal(loaded.roles?.builder, "codex-xhigh");
  // commented-out examples should NOT appear as live entries
  assert.ok(!loaded.models.gemini, "gemini example must remain commented out");
  assert.ok(!loaded.models.openai, "openai example must remain commented out");
});
