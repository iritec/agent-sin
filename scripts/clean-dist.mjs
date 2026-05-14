import { rm } from "node:fs/promises";
import path from "node:path";

const dist = path.resolve("dist");

await rm(dist, { recursive: true, force: true });
