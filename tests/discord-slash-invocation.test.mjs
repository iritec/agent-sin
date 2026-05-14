import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const registryUrl = pathToFileURL(path.resolve("dist/core/skill-registry.js")).href;
const builderUrl = pathToFileURL(path.resolve("dist/builder/builder-session.js")).href;

async function withSkillDir(yamlBody, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sin-slash-"));
  try {
    await mkdir(path.join(dir, "skill"), { recursive: true });
    await writeFile(path.join(dir, "skill", "skill.yaml"), yamlBody, "utf8");
    await writeFile(path.join(dir, "skill", "main.py"), "async def run(ctx, input):\n    return {\"status\": \"ok\"}\n", "utf8");
    await fn(path.join(dir, "skill"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadSkillManifest accepts a valid invocation.discord_slash block", async () => {
  const { loadSkillManifest } = await import(registryUrl);
  const yaml = `id: flip-coin\nruntime: python\nname: コイントス\ndescription: コインを投げる\ninvocation:\n  phrases: ["コイントス"]\n  discord_slash:\n    description: Flip a coin\n    options:\n      - name: count\n        type: integer\n        description: How many\n        required: true\n        choices:\n          - { name: "1回", value: 1 }\n          - { name: "5回", value: 5 }\n`;
  await withSkillDir(yaml, async (skillDir) => {
    const manifest = await loadSkillManifest(skillDir);
    assert.equal(manifest.invocation.discord_slash.description, "Flip a coin");
    assert.equal(manifest.invocation.discord_slash.options[0].type, "integer");
    assert.equal(manifest.invocation.discord_slash.options[0].choices[0].value, 1);
  });
});

test("loadSkillManifest rejects unknown discord_slash option type", async () => {
  const { loadSkillManifest } = await import(registryUrl);
  const yaml = `id: bad-opt\nruntime: python\nname: bad\ndescription: bad\ninvocation:\n  phrases: ["bad"]\n  discord_slash:\n    options:\n      - { name: x, type: object }\n`;
  await withSkillDir(yaml, async (skillDir) => {
    await assert.rejects(() => loadSkillManifest(skillDir), /options\[\*\]\.type/);
  });
});

test("loadSkillManifest rejects discord_slash boolean option with choices", async () => {
  const { loadSkillManifest } = await import(registryUrl);
  const yaml = `id: bad-bool\nruntime: python\nname: bad\ndescription: bad\ninvocation:\n  phrases: ["bad"]\n  discord_slash:\n    options:\n      - name: flag\n        type: boolean\n        choices:\n          - { name: "yes", value: "yes" }\n`;
  await withSkillDir(yaml, async (skillDir) => {
    await assert.rejects(() => loadSkillManifest(skillDir), /boolean option/);
  });
});

test("loadSkillManifest rejects discord_slash option with invalid name", async () => {
  const { loadSkillManifest } = await import(registryUrl);
  const yaml = `id: bad-name\nruntime: python\nname: bad\ndescription: bad\ninvocation:\n  phrases: ["bad"]\n  discord_slash:\n    options:\n      - { name: "Bad Name!", type: string }\n`;
  await withSkillDir(yaml, async (skillDir) => {
    await assert.rejects(() => loadSkillManifest(skillDir), /options\[\*\]\.name/);
  });
});

test("formatDiscordSlashGuidance injects guidance only for discord event_source", async () => {
  const { formatDiscordSlashGuidance } = await import(builderUrl);
  assert.deepEqual(formatDiscordSlashGuidance(undefined), []);
  assert.deepEqual(formatDiscordSlashGuidance({}), []);
  assert.deepEqual(formatDiscordSlashGuidance({ event_source: "telegram" }), []);
  assert.deepEqual(formatDiscordSlashGuidance({ event_source: "cli" }), []);
  const discord = formatDiscordSlashGuidance({ event_source: "discord" });
  assert.ok(discord.length > 0);
  assert.ok(discord.some((line) => line.includes("discord_slash")));
  assert.ok(discord.some((line) => line.includes("phrases")), "guidance must remind that phrases stays required");
});
