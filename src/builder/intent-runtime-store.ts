import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntentRuntime } from "./build-flow.js";

type RuntimeRootKey = "channels" | "chats";

export async function loadIntentRuntimeMap(
  filePath: string,
  rootKey: RuntimeRootKey,
): Promise<Map<string, IntentRuntime>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as Record<RuntimeRootKey, Record<string, IntentRuntime> | undefined>;
    const entries = data[rootKey];
    const map = new Map<string, IntentRuntime>();
    if (entries && typeof entries === "object") {
      for (const [key, runtime] of Object.entries(entries)) {
        if (!runtime || typeof runtime !== "object") continue;
        map.set(key, restoreIntentRuntime(runtime));
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function saveIntentRuntimeMap(
  filePath: string,
  rootKey: RuntimeRootKey,
  runtimes: Map<string, IntentRuntime>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const values: Record<string, IntentRuntime> = {};
  for (const [key, runtime] of runtimes) {
    if (!isEmptyIntentRuntime(runtime)) {
      values[key] = runtime;
    }
  }
  await writeFile(filePath, `${JSON.stringify({ [rootKey]: values, saved_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function restoreIntentRuntime(runtime: IntentRuntime): IntentRuntime {
  const runtimeRecord = runtime as unknown as Record<string, unknown>;
  const restoredBuild = runtime.build
    ? {
        ...runtime.build,
        context_seed: [],
        context_consumed: true,
      }
    : null;
  return {
    enabled: runtime.enabled !== false,
    mode: runtime.mode === "build" ? "build" : "chat",
    pending: runtime.pending ?? null,
    pending_exit:
      runtimeRecord.pending_exit && typeof runtimeRecord.pending_exit === "object"
        ? (runtimeRecord.pending_exit as IntentRuntime["pending_exit"])
        : null,
    preferred_skill_id:
      typeof runtimeRecord.preferred_skill_id === "string" ? runtimeRecord.preferred_skill_id : null,
    progress_detail: runtimeRecord.progress_detail === true,
    build: restoredBuild,
  };
}

export function isEmptyIntentRuntime(runtime: IntentRuntime): boolean {
  return (
    runtime.mode === "chat" &&
    !runtime.pending &&
    !runtime.build &&
    !runtime.pending_exit &&
    !runtime.preferred_skill_id &&
    !runtime.progress_detail
  );
}
