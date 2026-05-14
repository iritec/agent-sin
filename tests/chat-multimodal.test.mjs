import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { chatRespond } from "../dist/core/chat-engine.js";
import { messageContentToText, setAiProviderOverride } from "../dist/core/ai-provider.js";
import { setLocale } from "../dist/core/i18n.js";

function testConfig() {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-multimodal-"));
  const skillsDir = path.join(home, "skills");
  const logsDir = path.join(home, "logs");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return {
    version: 1,
    workspace: home,
    notes_dir: path.join(home, "notes"),
    skills_dir: skillsDir,
    memory_dir: path.join(home, "memory"),
    index_dir: path.join(home, "index"),
    logs_dir: logsDir,
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

function echoSkillFiles(id, title = "Echo") {
  return {
    "skill.yaml": `
id: ${id}
name: ${title}
description: Echo skill
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
    required:
      - text
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
    "fixtures/input.json": `{"text":"fixture"}\n`,
  };
}

function seedBrokenEchoSkill(home, id) {
  const skillDir = path.join(home, "skills", id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "skill.yaml"), echoSkillFiles(id, "Broken Echo")["skill.yaml"], "utf8");
  writeFileSync(
    path.join(skillDir, "main.py"),
    `async def run(ctx, input):
    raise RuntimeError("boom")
`,
    "utf8",
  );
  return skillDir;
}

test("chatRespond attaches current-turn images to the AI request", async () => {
  const requests = [];
  setAiProviderOverride(async (_config, request) => {
    requests.push(request);
    return { text: "画像を確認しました。", model_id: request.model_id, provider: "test" };
  });
  try {
    const history = [];
    const lines = await chatRespond(testConfig(), "この画像を見て", history, {
      userImages: [
        {
          type: "image",
          image_url: "data:image/png;base64,AAAA",
          mime_type: "image/png",
          filename: "screen.png",
        },
      ],
    });

    assert.deepEqual(lines, ["画像を確認しました。"]);
    const userMessage = requests[0].messages.findLast((message) => message.role === "user");
    assert.ok(Array.isArray(userMessage.content));
    assert.deepEqual(userMessage.content[0], { type: "text", text: "この画像を見て" });
    assert.equal(userMessage.content[1].type, "image");
    assert.equal(userMessage.content[1].filename, "screen.png");
    assert.equal(history[0].content, "この画像を見て");
  } finally {
    setAiProviderOverride(null);
  }
});

test("messageContentToText keeps a readable fallback for image parts", () => {
  const text = messageContentToText([
    { type: "text", text: "画像です" },
    {
      type: "image",
      image_url: "data:image/jpeg;base64,AAAA",
      mime_type: "image/jpeg",
      filename: "photo.jpg",
    },
  ]);

  assert.match(text, /画像です/);
  assert.match(text, /\[image: photo\.jpg image\/jpeg data-url\]/);
});

test("chat repairs a failed skill once and reruns it", async () => {
  const config = testConfig();
  const skillDir = seedBrokenEchoSkill(config.workspace, "broken-echo");
  const firstResponse = '```skill-call\n{"id":"broken-echo","args":{"text":"repair me"}}\n```';
  const repairResponse = builderFilesBlock("直しました", echoSkillFiles("broken-echo", "Fixed Echo"));
  const finalResponse = "直して実行しました。";
  const replies = [firstResponse, repairResponse, finalResponse];
  const requests = [];

  setAiProviderOverride(async (_config, request) => {
    requests.push(request);
    return { text: replies.shift() || "done", model_id: request.model_id, provider: "test" };
  });
  setLocale("ja");
  try {
    const lines = await chatRespond(config, "壊れたechoを実行して", [], { eventSource: "chat" });

    assert.deepEqual(lines, [
      "→ broken-echo を実行します",
      "→ broken-echo が失敗したため修正します",
      "修正してもう一度実行しました。",
      "repair me",
      "直して実行しました。",
    ]);
    assert.equal(requests.length, 3);
    assert.match(readFileSync(path.join(skillDir, "main.py"), "utf8"), /Fixed Echo/);
  } finally {
    setAiProviderOverride(null);
    setLocale(null);
  }
});
