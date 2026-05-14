import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultWorkspace } from "./config.js";
import { l } from "./i18n.js";

const DEFAULT_INCLUDE = [
  ".env",
  "config.toml",
  "models.yaml",
  "skill-settings.yaml",
  "skills",
  "memory",
  "notes",
  "schedules.yaml",
  "discord",
  "telegram",
  "logs",
  "index",
];

const ALWAYS_EXCLUDE = [".venv", "node_modules", ".DS_Store"];

export interface ExportOptions {
  workspace?: string;
  outFile?: string;
  includeSecrets?: boolean;
  includeLogs?: boolean;
  includeIndex?: boolean;
}

export interface ExportResult {
  archivePath: string;
  byteSize: number;
  includedItems: string[];
  warnings: string[];
}

export interface ImportOptions {
  archivePath: string;
  workspace?: string;
  dryRun?: boolean;
  backup?: boolean;
}

export interface ImportResult {
  workspace: string;
  archivePath: string;
  entries: string[];
  backupPath?: string;
  dryRun: boolean;
}

export async function exportWorkspace(options: ExportOptions = {}): Promise<ExportResult> {
  const workspace = options.workspace || defaultWorkspace();
  if (!(await pathExists(workspace))) {
    throw new Error(l(`Workspace not found: ${workspace}`, `ワークスペースが見つかりません: ${workspace}`));
  }

  const include: string[] = [...DEFAULT_INCLUDE];
  if (options.includeSecrets && !include.includes(".env")) include.push(".env");
  if (options.includeLogs && !include.includes("logs")) include.push("logs");
  if (options.includeIndex && !include.includes("index")) include.push("index");

  const present: string[] = [];
  const missing: string[] = [];
  for (const item of include) {
    if (await pathExists(path.join(workspace, item))) {
      present.push(item);
    } else {
      missing.push(item);
    }
  }
  if (present.length === 0) {
    throw new Error(l("No transferable workspace data was found.", "ワークスペースに移行可能なデータが見つかりません。"));
  }

  const archivePath = path.resolve(options.outFile || defaultArchivePath());
  await mkdir(path.dirname(archivePath), { recursive: true });

  const args: string[] = ["-czf", archivePath, "-C", workspace];
  for (const exc of ALWAYS_EXCLUDE) {
    args.push(`--exclude=${exc}`);
  }
  args.push(...present);

  await runTar(args);

  const stats = await stat(archivePath);
  return {
    archivePath,
    byteSize: stats.size,
    includedItems: present,
    warnings:
      missing.length > 0 ? [l(`Missing items: ${missing.join(", ")}`, `存在しなかった項目: ${missing.join(", ")}`)] : [],
  };
}

export async function listArchiveEntries(archivePath: string): Promise<string[]> {
  if (!(await pathExists(archivePath))) {
    throw new Error(l(`Archive not found: ${archivePath}`, `アーカイブが見つかりません: ${archivePath}`));
  }
  const entries = await listArchiveMetadata(path.resolve(archivePath));
  assertSafeArchiveEntries(entries);
  return entries.map((entry) => entry.path);
}

export async function importWorkspace(options: ImportOptions): Promise<ImportResult> {
  if (!(await pathExists(options.archivePath))) {
    throw new Error(l(`Archive not found: ${options.archivePath}`, `アーカイブが見つかりません: ${options.archivePath}`));
  }
  const archivePath = path.resolve(options.archivePath);
  const workspace = options.workspace || defaultWorkspace();
  const archiveEntries = await listArchiveMetadata(archivePath);
  assertSafeArchiveEntries(archiveEntries);
  const entries = archiveEntries.map((entry) => entry.path);

  if (options.dryRun) {
    return { workspace, archivePath, entries, dryRun: true };
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-sin-import-"));
  try {
    await runTar(["-xzf", archivePath, "-C", tempRoot]);
    await assertExtractedTreeSafe(tempRoot);

    let backupPath: string | undefined;
    if ((options.backup ?? true) && (await pathExists(workspace))) {
      backupPath = await backupExistingWorkspace(workspace);
    }

    await mkdir(workspace, { recursive: true });
    await copySafeTree(tempRoot, workspace);

    return { workspace, archivePath, entries, backupPath, dryRun: false };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function backupExistingWorkspace(workspace: string): Promise<string> {
  const ts = formatTimestamp(new Date());
  const backupPath = `${workspace}.bak-${ts}`;
  await rename(workspace, backupPath);
  return backupPath;
}

function defaultArchivePath(): string {
  const ts = formatTimestamp(new Date());
  return path.resolve(process.cwd(), `agent-sin-backup-${ts}.tar.gz`);
}

function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(l("tar command not found. Install tar first.", "tar コマンドが見つかりません。tar をインストールしてください。")));
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(l(`tar failed (code ${code}): ${stderr.trim()}`, `tar が失敗しました (code ${code}): ${stderr.trim()}`)));
      }
    });
  });
}

function runTarCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(l("tar command not found. Install tar first.", "tar コマンドが見つかりません。tar をインストールしてください。")));
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(l(`tar failed (code ${code}): ${stderr.trim()}`, `tar が失敗しました (code ${code}): ${stderr.trim()}`)));
      }
    });
  });
}

interface ArchiveMetadataEntry {
  path: string;
  type: string;
}

async function listArchiveMetadata(archivePath: string): Promise<ArchiveMetadataEntry[]> {
  const namesOut = await runTarCapture(["-tzf", archivePath]);
  const names = namesOut
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const verboseOut = await runTarCapture(["-tvzf", archivePath]);
  const types = verboseOut
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0)
    .map((line) => line.charAt(0));
  if (types.length !== names.length) {
    throw new Error(l("The archive could not be inspected safely.", "アーカイブの内容を安全に検査できませんでした。"));
  }
  return names.map((entryPath, index) => ({ path: entryPath, type: types[index] }));
}

function assertSafeArchiveEntries(entries: ArchiveMetadataEntry[]): void {
  for (const entry of entries) {
    const name = entry.path;
    if (!name || name.includes("\0")) {
      throw new Error(l("The archive contains an invalid path.", "アーカイブに不正なパスが含まれています。"));
    }
    if (name.includes("\\") || path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
      throw new Error(l(`The archive contains a disallowed path: ${name}`, `アーカイブに許可されないパスが含まれています: ${name}`));
    }
    const normalized = path.posix.normalize(name);
    if (normalized === "." || normalized === ".." || normalized.startsWith("../") || name.split("/").includes("..")) {
      throw new Error(l(`The archive contains a path outside the workspace: ${name}`, `アーカイブにワークスペース外へ出るパスが含まれています: ${name}`));
    }
    if (entry.type !== "-" && entry.type !== "d") {
      throw new Error(l(`The archive contains an entry that is not a regular file or directory: ${name}`, `アーカイブに通常ファイル/ディレクトリ以外が含まれています: ${name}`));
    }
  }
}

async function assertExtractedTreeSafe(root: string): Promise<void> {
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new Error(l(`The archive contains a symbolic link: ${entry}`, `アーカイブにシンボリックリンクが含まれています: ${entry}`));
      }
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(l(`The archive contains an entry that is not a regular file or directory: ${entry}`, `アーカイブに通常ファイル/ディレクトリ以外が含まれています: ${entry}`));
      }
    }
  }
  await walk(root);
}

async function copySafeTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dest = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copySafeTree(src, dest);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(l(`Cannot restore this file type: ${entry.name}`, `復元できないファイル種別です: ${entry.name}`));
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
}
