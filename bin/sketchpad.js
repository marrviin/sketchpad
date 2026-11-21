#!/usr/bin/env node
// sketchpad — CLI 启动器：加载编译产物 dist/cli.js（先 pnpm build）。
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "..", "dist", "cli.js")).href);
