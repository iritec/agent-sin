import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { builtinSkillsDir, listBuiltinSkillIds } from "./skill-registry.js";

export interface BuiltinMigrationReport {
  /** ids whose workspace copy matched the packaged version and was silently removed. */
  deleted: string[];
  /** ids whose workspace copy differed from the packaged version and was moved aside. */
  archived: Array<{ id: string; archivePath: string }>;
  /** ids whose workspace copy is kept as an explicit override (`override: true`). */
  retained: string[];
}

/**
 * Migrate legacy in-workspace copies of builtin skills.
 *
 * Builtin skills are now loaded directly from the packaged `builtin-skills/`
 * directory; the user's workspace `skills/` is for user-authored skills only.
 * Existing installs may still have stale copies of builtin skills under
 * `<skills_dir>/<builtin-id>/`. For each such directory we:
 *
 *   - Skip it if its `skill.yaml` has `override: true` (deliberate override).
 *   - Delete it silently if every file matches the packaged version byte-for-byte.
 *   - Move it to `<skills_dir>/.archived-builtin-overrides/<id>/<timestamp>/`
 *     otherwise, so user customisation is never silently lost.
 *
 * Safe to call repeatedly; returns a report describing what happened.
 */
export async function migrateLegacyBuiltinCopies(skillsDir: string): Promise<BuiltinMigrationReport> {
  const report: BuiltinMigrationReport = { deleted: [], archived: [], retained: [] };
  const builtinIds = await listBuiltinSkillIds();
  if (builtinIds.size === 0) {
    return report;
  }
  const builtinRoot = builtinSkillsDir();

  for (const id of builtinIds) {
    const workspacePath = path.join(skillsDir, id);
    const workspaceManifest = path.join(workspacePath, "skill.yaml");
    try {
      await stat(workspaceManifest);
    } catch {
      continue;
    }

    if (await hasOverrideFlag(workspaceManifest)) {
      report.retained.push(id);
      continue;
    }

    const builtinPath = path.join(builtinRoot, id);
    const identical = await directoriesIdentical(workspacePath, builtinPath);
    if (identical) {
      await rm(workspacePath, { recursive: true, force: true });
      report.deleted.push(id);
      continue;
    }

    const archiveRoot = path.join(skillsDir, ".archived-builtin-overrides", id);
    await mkdir(archiveRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = path.join(archiveRoot, stamp);
    await rename(workspacePath, archivePath);
    report.archived.push({ id, archivePath });
  }

  return report;
}

async function hasOverrideFlag(manifestPath: string): Promise<boolean> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = YAML.parse(raw) as { override?: unknown } | null;
    return parsed?.override === true;
  } catch {
    return false;
  }
}

async function directoriesIdentical(a: string, b: string): Promise<boolean> {
  let filesA: string[];
  let filesB: string[];
  try {
    filesA = (await collectFiles(a)).sort();
    filesB = (await collectFiles(b)).sort();
  } catch {
    return false;
  }
  if (filesA.length !== filesB.length) {
    return false;
  }
  for (let i = 0; i < filesA.length; i += 1) {
    if (filesA[i] !== filesB[i]) {
      return false;
    }
  }
  for (const relative of filesA) {
    const hashA = await hashFile(path.join(a, relative));
    const hashB = await hashFile(path.join(b, relative));
    if (hashA !== hashB) {
      return false;
    }
  }
  return true;
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(root: string, current: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full));
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}
