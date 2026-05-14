import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildOpenAIChatBody,
  formatProviderApiError,
  openAIModelAcceptsTemperature,
  runChatCompletion,
} from "../dist/core/ai-provider.js";

function withWorkspace(modelsYaml) {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-ai-provider-"));
  writeFileSync(path.join(home, "models.yaml"), modelsYaml, "utf8");
  mkdirSync(path.join(home, "logs"), { recursive: true });
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

function captureFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });
    return responder(String(url), body);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function okOpenAI(text = "ok") {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function okGemini(text = "ok") {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function okAnthropic(text = "ok") {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("openAIModelAcceptsTemperature allows only legacy gpt-4*/gpt-3.5* families", () => {
  for (const id of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4o-2024-08-06",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4-turbo",
    "gpt-4",
    "gpt-3.5-turbo",
    "GPT-4o",
    "ft:gpt-4o-mini-2024-07-18:org::abc123",
  ]) {
    assert.equal(openAIModelAcceptsTemperature(id), true, `should accept temperature for ${id}`);
  }
  for (const id of [
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.1",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5",
    "gpt-5.5-pro",
    "GPT-5.5",
    "gpt-6",
    "gpt-6-mini",
    "gpt-7",
    "o1",
    "o1-mini",
    "o3",
    "o3-mini",
    "o4-mini",
    "ft:gpt-5.4-mini:org::abc",
    undefined,
    "",
  ]) {
    assert.equal(
      openAIModelAcceptsTemperature(id),
      false,
      `should NOT send temperature for ${id}`,
    );
  }
});

test("buildOpenAIChatBody omits temperature for reasoning / future models", () => {
  const request = {
    model_id: "openai",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
  };
  for (const model of ["gpt-5.5", "gpt-5.4-mini", "o3-mini", "gpt-6", "gpt-7-mini"]) {
    const body = buildOpenAIChatBody(request, { type: "api", provider: "openai", model });
    assert.equal(body.model, model);
    assert.ok(!("temperature" in body), `${model} must not send temperature`);
  }
  const legacy = buildOpenAIChatBody(request, { type: "api", provider: "openai", model: "gpt-4o-mini" });
  assert.equal(legacy.temperature, 0.7);
});

test("buildOpenAIChatBody falls back to default temperature only for legacy models", () => {
  const legacy = buildOpenAIChatBody(
    { model_id: "openai", messages: [{ role: "user", content: "hi" }] },
    { type: "api", provider: "openai", model: "gpt-4o-mini" },
  );
  assert.equal(legacy.temperature, 0.7);

  const noModelEntry = buildOpenAIChatBody(
    { model_id: "openai", messages: [{ role: "user", content: "hi" }] },
    { type: "api", provider: "openai" },
  );
  assert.equal(noModelEntry.model, "gpt-5.4-mini");
  assert.ok(!("temperature" in noModelEntry), "default fallback (gpt-5.4-mini) must not send temperature");
});

test("runChatCompletion does not send temperature when calling gpt-5 series", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const config = withWorkspace(
    "models:\n  openai:\n    type: api\n    provider: openai\n    model: gpt-5.5\n    enabled: true\n",
  );
  const captured = captureFetch(() => okOpenAI("pong"));
  try {
    const res = await runChatCompletion(config, {
      model_id: "openai",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.2,
    });
    assert.equal(res.text, "pong");
    assert.equal(captured.calls.length, 1);
    assert.ok(captured.calls[0].url.startsWith("https://api.openai.com/"));
    assert.ok(!("temperature" in captured.calls[0].body), "gpt-5.5 request must not include temperature");
    assert.equal(captured.calls[0].body.model, "gpt-5.5");
  } finally {
    captured.restore();
    delete process.env.OPENAI_API_KEY;
  }
});

test("runChatCompletion keeps temperature for non-reasoning OpenAI models", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const config = withWorkspace(
    "models:\n  openai:\n    type: api\n    provider: openai\n    model: gpt-4o-mini\n    enabled: true\n",
  );
  const captured = captureFetch(() => okOpenAI("pong"));
  try {
    await runChatCompletion(config, {
      model_id: "openai",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.2,
    });
    assert.equal(captured.calls[0].body.temperature, 0.2);
    assert.equal(captured.calls[0].body.model, "gpt-4o-mini");
  } finally {
    captured.restore();
    delete process.env.OPENAI_API_KEY;
  }
});

test("runChatCompletion still sends temperature to Gemini when requested", async () => {
  process.env.GEMINI_API_KEY = "k-gemini";
  const config = withWorkspace(
    "models:\n  gemini:\n    type: api\n    provider: gemini\n    model: gemini-2.5-flash\n    enabled: true\n",
  );
  const captured = captureFetch(() => okGemini("pong"));
  try {
    await runChatCompletion(config, {
      model_id: "gemini",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.3,
    });
    const body = captured.calls[0].body;
    assert.equal(body.generationConfig.temperature, 0.3);
    assert.ok(captured.calls[0].url.includes("gemini-2.5-flash"));
  } finally {
    captured.restore();
    delete process.env.GEMINI_API_KEY;
  }
});

test("runChatCompletion omits Gemini generationConfig when no temperature set", async () => {
  process.env.GEMINI_API_KEY = "k-gemini";
  const config = withWorkspace(
    "models:\n  gemini:\n    type: api\n    provider: gemini\n    model: gemini-2.5-flash\n    enabled: true\n",
  );
  const captured = captureFetch(() => okGemini("pong"));
  try {
    await runChatCompletion(config, {
      model_id: "gemini",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.ok(!("generationConfig" in captured.calls[0].body));
  } finally {
    captured.restore();
    delete process.env.GEMINI_API_KEY;
  }
});

test("runChatCompletion converts skill 'tool' messages to user for OpenAI", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const config = withWorkspace(
    "models:\n  openai:\n    type: api\n    provider: openai\n    model: gpt-5.5\n    enabled: true\n",
  );
  const captured = captureFetch(() => okOpenAI("done"));
  try {
    await runChatCompletion(config, {
      model_id: "openai",
      messages: [
        { role: "user", content: "todoリスト見せて" },
        { role: "assistant", content: '```skill-call\n{"id":"todo-list"}\n```' },
        { role: "tool", content: '{"tool_use_id":"x","result":{"status":"ok","title":"todos"}}' },
      ],
    });
    const body = captured.calls[0].body;
    assert.equal(body.messages.length, 3);
    const roles = body.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant", "user"], "tool role must be flattened to user");
    assert.ok(!roles.includes("tool"), "no raw tool role can reach OpenAI");
    assert.match(body.messages[2].content, /^\[tool-result\]\n/);
    assert.match(body.messages[2].content, /"status":"ok"/);
  } finally {
    captured.restore();
    delete process.env.OPENAI_API_KEY;
  }
});

test("runChatCompletion sends temperature to Anthropic only when set", async () => {
  process.env.ANTHROPIC_API_KEY = "k-anthropic";
  const config = withWorkspace(
    "models:\n  anthropic:\n    type: api\n    provider: anthropic\n    model: claude-haiku-4-5-20251001\n    enabled: true\n",
  );

  const withTemp = captureFetch(() => okAnthropic("pong"));
  try {
    await runChatCompletion(config, {
      model_id: "anthropic",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.5,
    });
    assert.equal(withTemp.calls[0].body.temperature, 0.5);
  } finally {
    withTemp.restore();
  }

  const without = captureFetch(() => okAnthropic("pong"));
  try {
    await runChatCompletion(config, {
      model_id: "anthropic",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.ok(!("temperature" in without.calls[0].body));
  } finally {
    without.restore();
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("formatProviderApiError surfaces a model-not-found message for OpenAI 404", () => {
  const msg = formatProviderApiError({
    provider: "openai",
    modelEntryId: "openai",
    modelName: "gpt5.5",
    status: 404,
    rawBody: JSON.stringify({
      error: { message: "The model `gpt5.5` does not exist.", code: "model_not_found" },
    }),
  });
  assert.match(msg, /モデル "gpt5\.5" は openai に存在しません|Model "gpt5\.5" does not exist on openai/);
  assert.match(msg, /models\.openai\.model/);
  assert.match(msg, /does not exist/);
  // 生 JSON を丸ごと埋め込まないこと
  assert.doesNotMatch(msg, /\{\s*"error"/);
});

test("formatProviderApiError detects code: model_not_found even with non-404 status", () => {
  const msg = formatProviderApiError({
    provider: "openai",
    modelEntryId: "openai",
    modelName: "gpt-bogus",
    status: 400,
    rawBody: JSON.stringify({
      error: { message: "Invalid model.", code: "model_not_found" },
    }),
  });
  assert.match(msg, /モデル "gpt-bogus" は openai に存在しません|Model "gpt-bogus" does not exist on openai/);
});

test("formatProviderApiError detects Anthropic not_found_error", () => {
  const msg = formatProviderApiError({
    provider: "anthropic",
    modelEntryId: "anthropic",
    modelName: "claude-typo",
    status: 404,
    rawBody: JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "model: claude-typo" },
    }),
  });
  assert.match(msg, /モデル "claude-typo" は anthropic に存在しません|Model "claude-typo" does not exist on anthropic/);
});

test("formatProviderApiError detects Gemini 404 with provider hint", () => {
  const msg = formatProviderApiError({
    provider: "gemini",
    modelEntryId: "gemini",
    modelName: "gemini-typo",
    status: 404,
    rawBody: JSON.stringify({
      error: { code: 404, message: "models/gemini-typo is not found for API version v1beta", status: "NOT_FOUND" },
    }),
  });
  assert.match(msg, /モデル "gemini-typo" は gemini に存在しません|Model "gemini-typo" does not exist on gemini/);
});

test("formatProviderApiError surfaces auth failure on 401", () => {
  const msg = formatProviderApiError({
    provider: "openai",
    modelEntryId: "openai",
    modelName: "gpt-5.5",
    status: 401,
    rawBody: JSON.stringify({ error: { message: "Incorrect API key provided." } }),
  });
  assert.match(msg, /openai の認証に失敗|openai authentication failed/);
  assert.match(msg, /\.env の API キー|API key in ~\/\.agent-sin\/\.env/);
});

test("formatProviderApiError falls back to message-only for other errors (no raw JSON dump)", () => {
  const msg = formatProviderApiError({
    provider: "openai",
    modelEntryId: "openai",
    modelName: "gpt-5.5",
    status: 500,
    rawBody: JSON.stringify({ error: { message: "Internal server error." } }),
  });
  assert.match(msg, /openai HTTP 500/);
  assert.match(msg, /Internal server error/);
  assert.doesNotMatch(msg, /\{\s*"error"/);
});
