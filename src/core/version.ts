import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FILENAME = fileURLToPath(import.meta.url);
const PKG_PATH = path.resolve(path.dirname(FILENAME), "..", "..", "package.json");

let cached: string | null = null;

function readVersionFromDisk(): string {
  try {
    const raw = readFileSync(PKG_PATH, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function agentSinVersion(): string {
  if (cached === null) {
    cached = readVersionFromDisk();
  }
  return cached;
}

export function agentSinVersionFresh(): string {
  return readVersionFromDisk();
}
