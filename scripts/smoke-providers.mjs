#!/usr/bin/env node
// Smoke test for AI providers in chat and builder modes.
// Usage: node scripts/smoke-providers.mjs [--all] [model-id ...]
//
// Exit code 0 = all attempted models succeeded.
// AGENT_SIN_HOME must point at the workspace whose models.yaml/.env you want to test.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.AGENT_SIN_HOME = process.env.AGENT_SIN_HOME || resolve(root, ".local/agent-sin");

const { loadDotenv } = await import(resolve(root, "dist/core/secrets.js"));
const { loadConfig, loadModels } = await import(resolve(root, "dist/core/config.js"));
const { runChatCompletion } = await import(resolve(root, "dist/core/ai-provider.js"));
const { getSharedCodexAppServer } = await import(resolve(root, "dist/runtimes/codex-app-server.js"));

await loadDotenv(process.env.AGENT_SIN_HOME);
const config = await loadConfig();
const models = await loadModels();

const allIds = Object.keys(models.models);
const args = process.argv.slice(2);
const includeAll = args.includes("--all");
const wanted = args.filter((arg) => arg !== "--all");
const targets = wanted.length
  ? wanted
  : includeAll
    ? allIds
    : allIds.filter((id) => models.models[id]?.enabled !== false);

const ROLES = [
  {
    role: "chat",
    label: "chat",
    messages: [{ role: "user", content: "Reply with exactly one short word: pong" }],
  },
  {
    role: "builder",
    label: "build",
    messages: [
      {
        role: "user",
        content:
          "You are a builder. Reply with exactly one short word and nothing else: built",
      },
    ],
  },
];

const TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label} ${ms}ms`)), ms)),
  ]);
}

const results = [];

for (const id of targets) {
  const entry = models.models[id];
  if (!entry) {
    results.push({ id, role: "-", status: "MISS", note: "no entry" });
    continue;
  }
  for (const r of ROLES) {
    const startedAt = Date.now();
    try {
      const res = await withTimeout(
        runChatCompletion(config, {
          model_id: id,
          role: r.role,
          messages: r.messages,
        }),
        TIMEOUT_MS,
        `${id}:${r.label}`,
      );
      const text = (res.text || "").trim().replace(/\s+/g, " ").slice(0, 80);
      results.push({
        id,
        role: r.label,
        status: text ? "PASS" : "EMPTY",
        ms: Date.now() - startedAt,
        provider: res.provider,
        sample: text,
      });
    } catch (error) {
      const msg = (error && error.message) || String(error);
      results.push({
        id,
        role: r.label,
        status: "FAIL",
        ms: Date.now() - startedAt,
        note: msg.slice(0, 200),
      });
    }
  }
}

try {
  const session = getSharedCodexAppServer && getSharedCodexAppServer();
  await session?.dispose?.();
} catch {
  // ignore
}

console.log("");
console.log("== Smoke results ==");
for (const r of results) {
  const tag = r.status === "PASS" ? "OK  " : r.status === "EMPTY" ? "EMPTY" : r.status === "MISS" ? "MISS" : "FAIL";
  const tail = r.sample ? ` :: ${r.sample}` : r.note ? ` :: ${r.note}` : "";
  console.log(`[${tag}] ${r.id.padEnd(14)} ${r.role.padEnd(6)} ${(r.ms ?? "-") + "ms"}${tail}`);
}

const failed = results.filter((r) => r.status !== "PASS").length;
process.exit(failed === 0 ? 0 : 1);
