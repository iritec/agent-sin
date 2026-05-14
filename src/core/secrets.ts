import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspace } from "./config.js";

export interface DotenvLoadResult {
  loaded: boolean;
  path: string;
  vars_set: number;
  permission_warning?: string;
}

export async function dotenvPath(workspace = defaultWorkspace()): Promise<string> {
  return path.join(workspace, ".env");
}

// .env に書かれているキー名だけを返す (process.env には影響しない)。
// setup の検出表示で「シェルから漏れているキー」を「.env 由来」と誤認しないために使う。
export async function readDotenvKeys(workspace = defaultWorkspace()): Promise<Set<string>> {
  const file = path.join(workspace, ".env");
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return keys;
  }
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (parsed && parsed.value.length > 0) {
      keys.add(parsed.key);
    }
  }
  return keys;
}

export async function loadDotenv(workspace = defaultWorkspace()): Promise<DotenvLoadResult> {
  const file = await dotenvPath(workspace);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { loaded: false, path: file, vars_set: 0 };
  }

  let permissionWarning: string | undefined;
  try {
    const info = await stat(file);
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      permissionWarning = `permissions ${mode.toString(8).padStart(3, "0")} on ${file} are too open; recommend: chmod 600 ${file}`;
    }
  } catch {
    // Ignore stat failures; the file was readable above.
  }

  let varsSet = 0;
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (!parsed) {
      continue;
    }
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
      varsSet += 1;
    }
  }

  return { loaded: true, path: file, vars_set: varsSet, permission_warning: permissionWarning };
}

function parseDotenvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) {
    return null;
  }
  let value = match[2].trim();
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
      return { key: match[1], value };
    }
  }
  // Strip trailing inline comment ` # ...` (only when preceded by whitespace).
  const commentIndex = findInlineCommentIndex(value);
  if (commentIndex >= 0) {
    value = value.slice(0, commentIndex).trim();
  }
  return { key: match[1], value };
}

function findInlineCommentIndex(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charAt(i) === "#" && (i === 0 || /\s/.test(value.charAt(i - 1)))) {
      return i;
    }
  }
  return -1;
}

export async function upsertDotenv(
  workspace: string,
  entries: Array<{ key: string; value: string }>,
): Promise<{ path: string }> {
  const file = path.join(workspace, ".env");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.split(/\r?\n/);
  const updated = new Set<string>();
  for (const { key, value } of entries) {
    const formatted = `${key}=${formatDotenvValue(value)}`;
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && match[1] === key) {
        lines[i] = formatted;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.push(formatted);
    }
    updated.add(key);
    process.env[key] = value;
  }
  let next = lines.join("\n");
  if (!next.endsWith("\n")) next = `${next}\n`;
  await writeFile(file, next, { mode: 0o600 });
  return { path: file };
}

function formatDotenvValue(value: string): string {
  if (/[\s"'#]/.test(value) || value === "") {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

export interface ApiKeySource {
  provider: string;
  envVar: string;
}

export interface ApiKeyResolution {
  provider: string;
  keys: string[];
  sources: ApiKeySource[];
}

const NUMBERED_KEY_LIMIT = 32;

export function getApiKeyResolution(provider: string, fallbackProviders: string[] = []): ApiKeyResolution {
  const keys: string[] = [];
  const seen = new Set<string>();
  const sources: ApiKeySource[] = [];

  for (const candidate of [provider, ...fallbackProviders]) {
    const upper = candidate.toUpperCase();

    pushKey(keys, seen, sources, candidate, `AGENT_SIN_LIVE_${upper}_KEY`, process.env[`AGENT_SIN_LIVE_${upper}_KEY`]);

    const list = process.env[`${upper}_API_KEYS`];
    if (list) {
      for (const item of list.split(/[,;]/)) {
        pushKey(keys, seen, sources, candidate, `${upper}_API_KEYS`, item);
      }
    }

    pushKey(keys, seen, sources, candidate, `${upper}_API_KEY`, process.env[`${upper}_API_KEY`]);

    for (let i = 1; i <= NUMBERED_KEY_LIMIT; i += 1) {
      pushKey(keys, seen, sources, candidate, `${upper}_API_KEY_${i}`, process.env[`${upper}_API_KEY_${i}`]);
    }
  }

  return { provider, keys, sources };
}

export function getApiKeys(provider: string, fallbackProviders: string[] = []): string[] {
  return getApiKeyResolution(provider, fallbackProviders).keys;
}

function pushKey(
  keys: string[],
  seen: Set<string>,
  sources: ApiKeySource[],
  provider: string,
  envVar: string,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  keys.push(trimmed);
  sources.push({ provider, envVar });
}

export function maskKey(key: string): string {
  if (!key) {
    return "<empty>";
  }
  if (key.length <= 8) {
    return `${key.slice(0, 2)}...${key.slice(-2)}`;
  }
  return `${key.slice(0, 4)}...${key.slice(-4)} (len=${key.length})`;
}

const DOTENV_TEMPLATE = `# Agent-Sin secrets file
# Recommend: chmod 600 ~/.agent-sin/.env
# Lines starting with # are ignored.
#
# Uncomment the line for the provider you want to use and paste your key.
# After editing, run \`agent-sin setup\` again — the new keys will be detected.

# --- OpenAI (https://platform.openai.com/api-keys) ---
# OPENAI_API_KEY=sk-...

# --- Gemini / Google AI (https://aistudio.google.com/app/apikey) ---
# GEMINI_API_KEY=AIza...

# --- Anthropic API (https://console.anthropic.com/settings/keys) ---
# ANTHROPIC_API_KEY=sk-ant-...

# --- Ollama (local) ---
# No API key needed. Run \`ollama serve\` and \`ollama pull <model>\` first.
# Uncomment only if Ollama is not on the default localhost:11434.
# OLLAMA_HOST=http://localhost:11434
`;

export async function ensureDotenvSkeleton(workspace: string): Promise<{ created: boolean; path: string }> {
  const file = path.join(workspace, ".env");
  try {
    await stat(file);
    return { created: false, path: file };
  } catch {
    // File does not exist; create skeleton.
  }
  await writeFile(file, DOTENV_TEMPLATE, { mode: 0o600 });
  return { created: true, path: file };
}
