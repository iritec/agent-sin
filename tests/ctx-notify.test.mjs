import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const cli = path.resolve("dist/cli/index.js");

function run(args, home, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
      AGENT_SIN_HOME: home,
      AGENT_SIN_NOTIFY_BACKEND: "stderr",
    },
    encoding: "utf8",
  });
}

function writeSkill(home, id, runtime, files) {
  const skillDir = path.join(home, "skills", id);
  mkdirSync(skillDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(skillDir, name), content);
  }
}

const skillYaml = (id, runtime, entry) => `
id: ${id}
name: ${id}
runtime: ${runtime}
entry: ${entry}
handler: run
input:
  schema:
    type: object
    properties:
      body:
        type: string
outputs: []
ai_steps: []
`;

test("ctx.notify works from a Python skill via runner protocol", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-notify-py-"));
  assert.equal(run(["setup"], home).status, 0);

  writeSkill(home, "notify-py", "python", {
    "skill.yaml": skillYaml("notify-py", "python", "main.py"),
    "main.py": `async def run(ctx, input):
    body = str(input["args"].get("body", ""))
    outcome = await ctx.notify({"title": "テスト", "body": body, "channel": "stderr"})
    return {
        "status": "ok",
        "title": "done",
        "summary": f"ok={outcome.get('ok')} channel={outcome.get('channel')}",
        "outputs": {},
        "data": {"outcome": outcome},
        "suggestions": [],
    }
`,
  });

  const result = run(["run", "notify-py", "--body", "hello-py"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok=True/);
  assert.match(result.stdout, /channel=stderr/);
  assert.match(result.stderr, /\[notify\] テスト: hello-py/);
});

test("ctx.notify works from a TypeScript skill in-process", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-notify-ts-"));
  assert.equal(run(["setup"], home).status, 0);

  writeSkill(home, "notify-ts", "typescript", {
    "skill.yaml": skillYaml("notify-ts", "typescript", "main.ts"),
    "main.ts": `export async function run(ctx, input) {
  const body = String(input.args?.body ?? "");
  const outcome = await ctx.notify({ title: "テスト", body, channel: "stderr" });
  return {
    status: "ok",
    title: "done",
    summary: \`ok=\${outcome.ok} channel=\${outcome.channel}\`,
    outputs: {},
    data: { outcome },
    suggestions: [],
  };
}
`,
  });

  const result = run(["run", "notify-ts", "--body", "hello-ts"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok=true/);
  assert.match(result.stdout, /channel=stderr/);
  assert.match(result.stderr, /\[notify\] テスト: hello-ts/);
});
