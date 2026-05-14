import { spawn } from "node:child_process";
import { rm, rename } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.resolve(root, "dist");
const tmp = path.resolve(root, ".dist-build");
const previous = path.resolve(root, ".dist-previous");
const tsc = path.resolve(root, "node_modules", "typescript", "bin", "tsc");

await rm(tmp, { recursive: true, force: true });

await run(process.execPath, [tsc, "--outDir", tmp]);

await rm(previous, { recursive: true, force: true });

let previousReady = false;
try {
  await rename(dist, previous);
  previousReady = true;
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

try {
  await rename(tmp, dist);
} catch (error) {
  if (previousReady) {
    await rename(previous, dist).catch(() => undefined);
  }
  throw error;
}

await rm(previous, { recursive: true, force: true });
await import("./chmod-bin.mjs");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal || code}`));
    });
  });
}
