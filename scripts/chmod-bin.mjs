import { chmod } from "node:fs/promises";
import path from "node:path";

const bin = path.resolve("dist/cli/index.js");

await chmod(bin, 0o755);
