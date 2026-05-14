import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { defaultWorkspace } from "./config.js";
import { l } from "./i18n.js";

const PACKAGE_NAME = "agent-sin";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface UpdateCache {
  lastCheckedAt: string | null;
  latestVersion: string | null;
  bannerShownDate: string | null;
}

function packageJsonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "package.json");
}

let cachedCurrentVersion: string | null = null;
async function readCurrentVersion(): Promise<string> {
  if (cachedCurrentVersion) return cachedCurrentVersion;
  try {
    const raw = await readFile(packageJsonPath(), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    cachedCurrentVersion = pkg.version || "0.0.0";
  } catch {
    cachedCurrentVersion = "0.0.0";
  }
  return cachedCurrentVersion;
}

function cachePath(workspace: string): string {
  return path.join(workspace, "update-check.json");
}

async function loadCache(workspace: string): Promise<UpdateCache> {
  try {
    const raw = await readFile(cachePath(workspace), "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    return {
      lastCheckedAt: parsed.lastCheckedAt ?? null,
      latestVersion: parsed.latestVersion ?? null,
      bannerShownDate: parsed.bannerShownDate ?? null,
    };
  } catch {
    return { lastCheckedAt: null, latestVersion: null, bannerShownDate: null };
  }
}

async function saveCache(workspace: string, cache: UpdateCache): Promise<void> {
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(cachePath(workspace), JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // ignore - non-critical
  }
}

function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { timeout: FETCH_TIMEOUT_MS, headers: { accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { version?: string };
            resolve(parsed.version ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.+-]/)[0].split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(/[.+-]/)[0].split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isDisabled(): boolean {
  const flag = (process.env.AGENT_SIN_DISABLE_UPDATE_CHECK || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function scheduleUpdateCheck(workspace: string = defaultWorkspace()): void {
  if (isDisabled()) return;
  void (async () => {
    const cache = await loadCache(workspace);
    const now = Date.now();
    const lastChecked = cache.lastCheckedAt ? Date.parse(cache.lastCheckedAt) : 0;
    if (Number.isFinite(lastChecked) && now - lastChecked < CHECK_INTERVAL_MS) return;
    const latest = await fetchLatestVersion();
    if (!latest) return;
    await saveCache(workspace, {
      ...cache,
      lastCheckedAt: new Date().toISOString(),
      latestVersion: latest,
    });
  })();
}

export async function consumeUpdateBanner(
  workspace: string = defaultWorkspace(),
): Promise<string | null> {
  if (isDisabled()) return null;
  const cache = await loadCache(workspace);
  if (!cache.latestVersion) return null;
  const current = await readCurrentVersion();
  if (compareSemver(cache.latestVersion, current) <= 0) return null;
  const today = todayKey();
  if (cache.bannerShownDate === today) return null;
  await saveCache(workspace, { ...cache, bannerShownDate: today });
  return l(
    `A new version v${cache.latestVersion} is available (current v${current}). Update: npm i -g ${PACKAGE_NAME}@latest`,
    `新しいバージョン v${cache.latestVersion} があります（現在 v${current}）。更新: npm i -g ${PACKAGE_NAME}@latest`,
  );
}
