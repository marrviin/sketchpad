/**
 * sketchpad CLI / agent 工具 × 服务接入层（两种模式自动选择）：
 *   daemon 模式：装了 @content-forge/daemon（peerDependency）时，向守护进程注册
 *     mount=/sketchpad 的 sketchpad 服务（单进程 = 静态页面 + 画板 API），
 *     对外 URL /project/<项目名>[/<hash>]/sketchpad/，与统一前端生态共用路由。
 *   独立模式：无 daemon 包时，`sketchpad ui` 起本地常驻进程（端口与 pid 记录在
 *     <项目根>/.content-forge/sketchpad/server.json），CLI/agent 直连 http://127.0.0.1:<port>/。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./paths.js";

type ProjectRoute = { base: string; prefix: string; root: string };

/** 自身 bin（dist 形态）绝对路径：spawn sketchpad 服务进程用 */
function selfBin(): string {
  const bin = path.join(fileURLToPath(new URL("../bin/", import.meta.url)), "sketchpad.js");
  if (!fs.existsSync(bin)) throw new Error("sketchpad 服务需要构建产物：先运行 pnpm build（bin/sketchpad.js + dist/）");
  return bin;
}

/* ===== daemon 模式 ===== */

/** sketchpad 服务 spec：单进程全功能服务（静态 + API），daemon 挂载 /sketchpad 反代 */
function sketchpadServiceSpec(): { name: string; exec: string; args: string[]; mount: string } {
  return { name: "sketchpad", exec: process.execPath, args: [selfBin(), "serve"], mount: "/sketchpad" };
}

/** 确保画板路由可用（daemon 模式）：返回 {base, prefix}，页面 URL = base + prefix + "/" */
async function ensureDaemonRoute(): Promise<ProjectRoute> {
  const daemon = (await import("@content-forge/daemon")) as typeof import("@content-forge/daemon");
  const spec = sketchpadServiceSpec();
  const reg = await daemon.registerProject(projectRoot);
  await daemon.registerService(spec);
  return { base: daemon.daemonBase(), prefix: `${reg.prefix}/${spec.name}`, root: projectRoot };
}

/* ===== 独立模式 ===== */

const stateFile = (): string => path.join(projectRoot, ".content-forge", "sketchpad", "server.json");

interface LocalServerState {
  port: number;
  pid: number;
}

function readLocalState(): LocalServerState | null {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as LocalServerState;
    process.kill(st.pid, 0); // 不活着就当没有
    return st;
  } catch {
    return null;
  }
}

/** 拉起本地常驻 serve 进程（detached），等它公告 BACKEND_PORT 后记录状态 */
function spawnLocalServer(): Promise<LocalServerState> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [selfBin(), "serve"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => reject(new Error("sketchpad serve 启动超时（10s）")), 10000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      const m = out.match(/BACKEND_PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        const st: LocalServerState = { port: Number(m[1]), pid: child.pid! };
        fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2));
        child.unref();
        resolve(st);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sketchpad serve 退出（code ${code}）：${out.slice(0, 400)}`));
    });
  });
}

async function ensureLocalRoute(): Promise<ProjectRoute> {
  const alive = readLocalState();
  const st = alive ?? (await spawnLocalServer());
  return { base: `http://127.0.0.1:${st.port}`, prefix: "", root: projectRoot };
}

/* ===== 对外 API ===== */

/** 确保画板页面/画板 API 路由可用（daemon 或本地常驻），返回路由 */
export async function ensureSketchpadRoute(): Promise<ProjectRoute> {
  try {
    await import("@content-forge/daemon");
  } catch {
    return ensureLocalRoute();
  }
  return ensureDaemonRoute();
}

/** 画板页面 URL（浏览器打开即可看到 agent 的笔迹，双向同步） */
export function sketchpadUrl(pv: ProjectRoute): string {
  return `${pv.base}${pv.prefix}/`;
}

/** 调画板后端 API：daemon mount 反代 / 本地直连（首调可能触发本地 serve 冷启动，稍慢） */
export async function sketchpadApi<T>(path: string, init?: RequestInit): Promise<T> {
  const pv = await ensureSketchpadRoute();
  const res = await fetch(`${pv.base}${pv.prefix}/api${path}`, {
    signal: AbortSignal.timeout(20000),
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data as T;
}

/** 本地常驻 serve 是否在跑（独立模式健康检查） */
export function localServerState(): LocalServerState | null {
  return readLocalState();
}
