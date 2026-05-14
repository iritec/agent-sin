import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export interface SkillSettings {
  /** Skill ids the user has explicitly disabled. */
  disabled: Set<string>;
}

export function skillSettingsPath(workspace: string): string {
  return path.join(workspace, "skill-settings.yaml");
}

export async function loadSkillSettings(workspace: string): Promise<SkillSettings> {
  const file = skillSettingsPath(workspace);
  try {
    await stat(file);
  } catch {
    return { disabled: new Set() };
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { disabled: new Set() };
  }
  const parsed = (raw.trim() ? (YAML.parse(raw) as Record<string, unknown> | null) : null) || {};
  const disabled = new Set<string>();
  const rawDisabled = (parsed as { disabled?: unknown }).disabled;
  if (Array.isArray(rawDisabled)) {
    for (const id of rawDisabled) {
      if (typeof id === "string" && id.trim().length > 0) {
        disabled.add(id.trim());
      }
    }
  }
  return { disabled };
}

export async function saveSkillSettings(
  workspace: string,
  settings: SkillSettings,
): Promise<string> {
  const file = skillSettingsPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  const disabled = Array.from(settings.disabled).sort();
  const payload: Record<string, unknown> = {};
  if (disabled.length > 0) {
    payload.disabled = disabled;
  }
  const content = disabled.length === 0 ? "disabled: []\n" : YAML.stringify(payload);
  await writeFile(file, content, "utf8");
  return file;
}

export async function setSkillEnabled(
  workspace: string,
  skillId: string,
  enabled: boolean,
): Promise<{ changed: boolean; settings: SkillSettings }> {
  const settings = await loadSkillSettings(workspace);
  const wasDisabled = settings.disabled.has(skillId);
  if (enabled) {
    if (!wasDisabled) {
      return { changed: false, settings };
    }
    settings.disabled.delete(skillId);
  } else {
    if (wasDisabled) {
      return { changed: false, settings };
    }
    settings.disabled.add(skillId);
  }
  await saveSkillSettings(workspace, settings);
  return { changed: true, settings };
}
