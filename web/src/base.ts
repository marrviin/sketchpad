/**
 * 对外访问前缀：经 content-forge 守护进程按项目路由时，daemon 会在返回的 HTML 里注入
 * window.__DAEMON_BASE__（嵌套旧路径 /project/<项目名>[/<hash>]/web，或独立服务 /project/<项目名>
 * ——sketchpad 服务为挂载式反代，base 不含服务段，页面内自行拼 /sketchpad/api）；直连运行（vite dev）为空串。
 * 与 workflow app 的 base.ts 同一套托管契约。
 */
declare global {
  interface Window {
    __DAEMON_BASE__?: string;
  }
}

export const DAEMON_BASE: string = typeof window !== "undefined" ? (window.__DAEMON_BASE__ ?? "") : "";
