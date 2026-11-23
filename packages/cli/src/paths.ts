/**
 * 项目根发现：与 workflow / web CLI 同约定——cwd 向上找 .content-forge / .git；
 * 守护进程 spawn 链路会注入 CONTENT_FORGE_ROOT（网关 → sketchpad backend 继承），优先采用。
 */
import { existsSync } from "node:fs";
import path from "node:path";

function discover(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, ".content-forge")) || existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

export const projectRoot: string = process.env.CONTENT_FORGE_ROOT ?? discover(process.cwd());
