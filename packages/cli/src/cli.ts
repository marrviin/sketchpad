import { Command } from "commander";
import { readFileSync } from "node:fs";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./paths.js";

/**
 * sketchpad CLI：
 *   sketchpad tool <名称> [json]
 *                            调用画板工具（工具名可省略 sketchpad_ 前缀，如 state / draw / undo）
 *   sketchpad state|new|brush|draw|compose|grid|snapshot|undo|redo|erase|order|use|clear|preview|lint [json]
 *                            高频工具的具名入口（等价 tool <名称> [json]）。
 *                            参数 JSON 支持内联 / @文件路径（如 sketchpad draw @shapes.json）/ "-" 或管道 stdin
 *   sketchpad ui             确保画板服务在线并打印页面地址（daemon 或本地常驻，自动选择）
 *   sketchpad serve          内部命令：全功能服务（静态页面 + 画板 API，公告 BACKEND_PORT）
 *   sketchpad canvas-backend 内部命令：纯 API 后端（兼容旧统一网关 spawn）
 */

const program = new Command();

program
  .name("sketchpad")
  .description("手绘板：looseleaf Sketchpad 画板（agent 经 CLI 作画，页面实时观看）");

const NAMED_TOOLS = [
  ["state", "get_state"],
  ["new", "new_canvas"],
  ["brush", "set_brush"],
  ["draw", "draw"],
  ["compose", "compose"],
  ["grid", "grid"],
  ["snapshot", "snapshot"],
  ["undo", "undo"],
  ["redo", "redo"],
  ["erase", "erase"],
  ["order", "order"],
  ["use", "use"],
  ["clear", "clear"],
  ["preview", "preview"],
  ["lint", "lint"],
] as const;

/** 读 stdin 全文（参数走管道时用） */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

/** 参数 JSON 三种来源：内联字符串 / @文件路径（draw 一批形状时免 shell 引号地狱）/
 *  "-"（显式 stdin）或省略参数且 stdin 非终端（管道） */
async function loadArgs(jsonArg?: string): Promise<unknown> {
  if (jsonArg === "-") return JSON.parse(await readStdin());
  if (jsonArg?.startsWith("@")) {
    try {
      return JSON.parse(readFileSync(jsonArg.slice(1), "utf8"));
    } catch (e) {
      console.error(`✗ 读参数文件失败：${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
      return undefined;
    }
  }
  if (!jsonArg && !process.stdin.isTTY) {
    const text = await readStdin();
    if (!text.trim()) return {};
    return JSON.parse(text);
  }
  return jsonArg ? JSON.parse(jsonArg) : {};
}

/** 调一个画板工具：zod 解析参数（补默认值）→ handler → 打印 text */
async function runSketchpadTool(nameArg: string, jsonArg?: string): Promise<void> {
  const { sketchpadToolDefs } = await import("./tools.js");
  const name = nameArg.startsWith("sketchpad_") ? nameArg : `sketchpad_${nameArg}`;
  const def = sketchpadToolDefs().find((d) => d.name === name);
  if (!def) {
    const names = sketchpadToolDefs().map((d) => d.name.replace(/^sketchpad_/, "")).join(" / ");
    console.error(`✗ 未知工具「${nameArg}」（可用：${names}）`);
    process.exitCode = 1;
    return;
  }
  let args: unknown;
  try {
    args = await loadArgs(jsonArg);
    if (args === undefined) return; // @文件读取失败已报错
  } catch (e) {
    console.error(`✗ 参数 JSON 解析失败：${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }
  if (args == null || typeof args !== "object") args = {};
  let parsed: unknown;
  try {
    parsed = z.object(def.inputSchema).parse(args);
  } catch (e) {
    console.error(`✗ 参数校验失败（${def.name}）: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }
  const result = await def.handler(parsed);
  console.log(result.content.map((c) => c.text).join("\n"));
  if (result.isError) process.exitCode = 1;
}

program
  .command("tool")
  .argument("<name>", "工具名（可省略 sketchpad_ 前缀）")
  .argument("[json]", "工具参数（JSON 字符串，缺省 {}）")
  .description("调用画板工具（如 tool draw '{\"shapes\":[…]}'）")
  .action((name: string, json?: string) => runSketchpadTool(name, json));

/* 高频工具的具名入口：等价 tool <名称> [json] */
for (const [cmd, name] of NAMED_TOOLS) {
  program
    .command(cmd)
    .argument("[json]", "工具参数（JSON 字符串）")
    .description(`等价于 tool ${name} [json]`)
    .action((json?: string) => runSketchpadTool(name, json));
}

program
  .command("icons")
  .description("列出 icon 形状可用的全部内置手绘 icon 名字")
  .action(() => {
    const iconBundle = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "icon-bundle.json"), "utf8"),
    ) as { icons: Record<string, unknown> };
    console.log(Object.keys(iconBundle.icons).join(" "));
  });

program
  .command("ui")
  .description("确保画板服务在线并打印页面地址（装了 @content-forge/daemon 走守护进程，否则本地常驻）")
  .action(async () => {
    const { ensureSketchpadRoute, sketchpadUrl } = await import("./route.js");
    const pv = await ensureSketchpadRoute();
    console.log(`手绘板页面：${sketchpadUrl(pv)}`);
    console.log("  agent 作画：用 sketchpad tool / draw 直接调");
  });

/* 全功能服务的静态目录（web-dist，vite 构建产物落在 cli 包内）；缺目录时给清晰的报错 */
function staticDir(): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web-dist");
  if (!fs.existsSync(path.join(dir, "index.html"))) {
    throw new Error(`前端构建产物缺失（${dir}）：先运行 pnpm build`);
  }
  return dir;
}

program
  .command("serve", { hidden: true })
  .description("内部命令：全功能服务（静态页面 + 画板 API），监听临时端口并公告 BACKEND_PORT")
  .action(async () => {
    const { startBackend } = await import("./backend.js");
    const server = startBackend({ staticDir: staticDir() });
    server.listen(Number(process.env.SKETCHPAD_BACKEND_PORT) || 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        console.log(`BACKEND_PORT=${addr.port}`);
        console.log(`sketchpad 服务就绪（pid ${process.pid}，项目 ${projectRoot}）`);
      }
    });
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
  });

program
  .command("canvas-backend", { hidden: true })
  .description("内部命令：纯 API 画板后端（兼容旧统一网关 spawn，公告 BACKEND_PORT）")
  .action(async () => {
    const { startBackend } = await import("./backend.js");
    const server = startBackend();
    server.listen(Number(process.env.SKETCHPAD_BACKEND_PORT) || 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        console.log(`BACKEND_PORT=${addr.port}`);
        console.log(`sketchpad 画板后端就绪（pid ${process.pid}，项目 ${projectRoot}）`);
      }
    });
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});

