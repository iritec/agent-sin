import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { consumeUpdateBanner } from "../dist/core/update-notifier.js";

function freshWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "agent-sin-update-"));
}

function currentVersion() {
  const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
  return String(pkg.version || "0.0.0");
}

function nextPatch(version) {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[+-]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

test("update banner compares minor and patch versions, not only major", async () => {
  const workspace = freshWorkspace();
  const current = currentVersion();
  const latest = nextPatch(current);
  writeFileSync(
    path.join(workspace, "update-check.json"),
    JSON.stringify(
      {
        lastCheckedAt: new Date().toISOString(),
        latestVersion: latest,
        bannerShownDate: null,
      },
      null,
      2,
    ),
    "utf8",
  );

  const banner = await consumeUpdateBanner(workspace);

  assert.match(banner || "", new RegExp(`v${latest.replaceAll(".", "\\.")}`));
  assert.match(banner || "", new RegExp(`current v${current.replaceAll(".", "\\.")}`));
});
