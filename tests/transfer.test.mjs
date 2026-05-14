import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
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
    },
    encoding: "utf8",
  });
}

function runWithInput(args, home, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_SIN_HOME: home,
    },
    encoding: "utf8",
    input,
  });
}

function extractArchivePath(stdout) {
  const match = stdout.match(/Archive: (.+\.tar\.gz)/);
  return match ? match[1].trim() : undefined;
}

function listArchive(file) {
  const result = spawnSync("tar", ["-tzf", file], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function localDateParts(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return { yyyy, MM, dd, date: `${yyyy}-${MM}-${dd}` };
}

test("export creates a tar.gz archive containing user data", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-export-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-sin-archive-"));

  assert.equal(run(["setup"], home).status, 0);

  const save = run(["run", "memo-save", "--text", "export対象のメモ"], home);
  assert.equal(save.status, 0, save.stderr);

  const archiveOut = path.join(outDir, "backup.tar.gz");
  const result = run(["export", "--out", archiveOut], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Archive:/);
  assert.match(result.stdout, /Items:/);
  assert.match(result.stdout, /skills/);
  assert.match(result.stdout, /notes/);
  assert.match(result.stdout, /\.env/);
  assert.match(result.stdout, /logs/);

  assert.ok(existsSync(archiveOut), "archive file should exist");
  assert.ok(statSync(archiveOut).size > 0, "archive should not be empty");
});

test("export includes migration state by default", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-export-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-sin-archive-"));
  assert.equal(run(["setup"], home).status, 0);

  const archiveOut = path.join(outDir, "migration.tar.gz");
  const exp = run(["export", "--out", archiveOut], home);
  assert.equal(exp.status, 0, exp.stderr);
  assert.match(exp.stdout, /\.env を含みます|Includes \.env/);

  const entries = listArchive(archiveOut);
  assert.match(entries, /(^|\n)\.env(\n|$)/);
  assert.match(entries, /(^|\n)logs\/?(\n|$)/);
  assert.match(entries, /(^|\n)index\/?(\n|$)/);
  assert.doesNotMatch(entries, /(^|\n)\.venv\/?(\n|$)/);
  assert.doesNotMatch(entries, /(^|\n)node_modules\/?(\n|$)/);
});

test("import --dry-run lists archive entries without extracting", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agent-sin-export-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-sin-archive-"));
  assert.equal(run(["setup"], home).status, 0);

  const exp = run(["export", "--out", path.join(outDir, "backup.tar.gz")], home);
  assert.equal(exp.status, 0, exp.stderr);

  const targetHome = mkdtempSync(path.join(tmpdir(), "agent-sin-import-"));
  // Remove the empty target so we can detect no-side-effect on dry-run.
  const dryRun = run(
    ["import", path.join(outDir, "backup.tar.gz"), "--dry-run"],
    targetHome,
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Entries:/);
  assert.match(dryRun.stdout, /config\.toml/);
  // Workspace must remain in its pre-import state (the mkdtemp created an empty dir).
  assert.equal(existsSync(path.join(targetHome, "config.toml")), false);
});

test("import restores user data into a new workspace", () => {
  const sourceHome = mkdtempSync(path.join(tmpdir(), "agent-sin-source-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-sin-archive-"));
  assert.equal(run(["setup"], sourceHome).status, 0);

  const save = run(["run", "memo-save", "--text", "移行検証用のメモ"], sourceHome);
  assert.equal(save.status, 0, save.stderr);
  const today = localDateParts();
  const noteRel = path.join("notes", today.yyyy, today.MM, `${today.date}.md`);

  const archiveOut = path.join(outDir, "backup.tar.gz");
  assert.equal(run(["export", "--out", archiveOut], sourceHome).status, 0);

  const targetHome = mkdtempSync(path.join(tmpdir(), "agent-sin-target-"));
  const imp = run(["import", archiveOut, "--force"], targetHome);
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /Workspace:/);
  assert.match(imp.stdout, /Restored entries/);

  const restoredNote = path.join(targetHome, noteRel);
  assert.ok(existsSync(restoredNote), `restored note should exist at ${restoredNote}`);
  const restoredContent = readFileSync(restoredNote, "utf8");
  assert.match(restoredContent, /移行検証用のメモ/);

  const skills = run(["skills"], targetHome);
  assert.equal(skills.status, 0, skills.stderr);
  assert.match(skills.stdout, /memo-save/);
});

test("import backs up existing workspace by default", () => {
  const sourceHome = mkdtempSync(path.join(tmpdir(), "agent-sin-source-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-sin-archive-"));
  assert.equal(run(["setup"], sourceHome).status, 0);

  const archiveOut = path.join(outDir, "backup.tar.gz");
  assert.equal(run(["export", "--out", archiveOut], sourceHome).status, 0);

  const targetHome = mkdtempSync(path.join(tmpdir(), "agent-sin-target-"));
  assert.equal(run(["setup"], targetHome).status, 0);
  assert.ok(existsSync(path.join(targetHome, "config.toml")));

  const imp = run(["import", archiveOut, "--force"], targetHome);
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /Backup:/);

  const backupMatch = imp.stdout.match(/Backup: (.+)/);
  assert.ok(backupMatch);
  const backupPath = backupMatch[1].trim();
  assert.ok(existsSync(backupPath), `backup directory should exist at ${backupPath}`);
});

test("import rejects archives containing symlinks", () => {
  const payloadDir = mkdtempSync(path.join(tmpdir(), "agent-sin-malicious-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "agent-sin-archive-"));
  const archiveOut = path.join(outDir, "symlink.tar.gz");
  mkdirSync(path.join(payloadDir, "notes"), { recursive: true });
  symlinkSync("/tmp", path.join(payloadDir, "skills"), "dir");

  const packed = spawnSync("tar", ["-czf", archiveOut, "-C", payloadDir, "notes", "skills"], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);

  const targetHome = mkdtempSync(path.join(tmpdir(), "agent-sin-target-"));
  const imp = run(["import", archiveOut, "--force"], targetHome);
  assert.notEqual(imp.status, 0);
  assert.match(imp.stderr, /通常ファイル\/ディレクトリ以外|シンボリックリンク|not a regular file or directory/);
});
