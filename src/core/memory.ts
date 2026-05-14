import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { SkillManifest } from "./skill-registry.js";

export interface SkillMemoryAccess {
  namespace: string;
  canRead: boolean;
  canWrite: boolean;
}

const VERSION_KEY = "__version";
const CURRENT_SCHEMA_VERSION = 1;

export function skillMemoryAccess(manifest: SkillManifest): SkillMemoryAccess {
  return {
    namespace: manifest.memory?.namespace || manifest.id,
    canRead: manifest.memory?.read === true,
    canWrite: manifest.memory?.write === true,
  };
}

export async function loadSkillMemory(config: AppConfig, manifest: SkillManifest): Promise<Record<string, unknown>> {
  const access = skillMemoryAccess(manifest);
  if (!access.canRead) {
    return {};
  }
  const stored = await loadExistingMemory(memoryFile(config, access.namespace));
  return stripVersion(stored);
}

export async function saveSkillMemoryUpdates(
  config: AppConfig,
  manifest: SkillManifest,
  updates: Record<string, unknown>,
): Promise<string | undefined> {
  const access = skillMemoryAccess(manifest);
  if (!access.canWrite || Object.keys(updates).length === 0) {
    return undefined;
  }

  const file = memoryFile(config, access.namespace);
  const current = await loadExistingMemory(file);
  const next: Record<string, unknown> = {
    [VERSION_KEY]: CURRENT_SCHEMA_VERSION,
    ...stripVersion(current),
    ...updates,
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2), "utf8");
  return file;
}

function memoryFile(config: AppConfig, namespace: string): string {
  return path.join(config.memory_dir, "skill-memory", `${safeName(namespace)}.json`);
}

async function loadExistingMemory(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!isPlainObject(parsed)) {
      return {};
    }
    return migrateSkillMemory(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function migrateSkillMemory(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw[VERSION_KEY] === "number" ? (raw[VERSION_KEY] as number) : 1;
  // Future migrations branch on `version` here. For now we only support v1.
  if (version > CURRENT_SCHEMA_VERSION) {
    // Newer-than-known data: pass through untouched so we don't lose fields.
    return raw;
  }
  return { [VERSION_KEY]: CURRENT_SCHEMA_VERSION, ...stripVersion(raw) };
}

function stripVersion(value: Record<string, unknown>): Record<string, unknown> {
  if (!(VERSION_KEY in value)) {
    return value;
  }
  const { [VERSION_KEY]: _omit, ...rest } = value;
  return rest;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
