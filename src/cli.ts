import { Command } from "commander";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./paths.js";

/**
 * sketchpad CLI：
 *   sketchpad tool <名称> [json]
 *                            调用画板工具（工具名可省略 sketchpad_ 前缀，如 state / draw / undo）
 *   sketchpad state|new|brush|draw|grid|snapshot|undo|redo|clear|preview [json]
 *                            高频工具的具名入口（等价 tool <名称> [json]）
 *   sketchpad ui             确保画板服务在线并打印页面地址（daemon 或本地常驻，自动选择）
 *   sketchpad serve          内部命令：全功能服务（静态页面 + 画板 API，公告 BACKEND_PORT）
 *   sketchpad canvas-backend 内部命令：纯 API 后端（兼容旧统一网关 spawn）
 */

const program = new Command();

program
  .name("sketchpad")
  .description("手绘板：looseleaf Sketchpad 画板（agent 经 CLI 作画，页面双向同步）");

const NAMED_TOOLS = [
  ["state", "get_state"],
  ["new", "new_canvas"],
  ["brush", "set_brush"],
  ["draw", "draw"],
  ["grid", "grid"],
  ["snapshot", "snapshot"],
  ["undo", "undo"],
  ["redo", "redo"],
  ["clear", "clear"],
  ["preview", "preview"],
] as const;

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
  let args: unknown = {};
  if (jsonArg) {
    try {
      args = JSON.parse(jsonArg);
    } catch (e) {
      console.error(`✗ 参数 JSON 解析失败：${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
      return;
    }
  }
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
  .command("ui")
  .description("确保画板服务在线并打印页面地址（装了 @content-forge/daemon 走守护进程，否则本地常驻）")
  .action(async () => {
    const { ensureSketchpadRoute, sketchpadUrl } = await import("./route.js");
    const pv = await ensureSketchpadRoute();
    console.log(`手绘板页面：${sketchpadUrl(pv)}`);
    console.log("  agent 作画：用 sketchpad tool / draw 直接调");
  });

/* 全功能服务的静态目录（web/dist）；缺目录时给清晰的报错 */
function staticDir(): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
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

