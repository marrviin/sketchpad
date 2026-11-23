# sketchpad

手绘板：looseleaf Sketchpad 画板 —— 手绘风页面 + REST/SSE 后端 + CLI，agent 与人在同一画布双向同步作画。

pnpm monorepo，两个包：

| 包 | 说明 |
| --- | --- |
| [`packages/cli`](packages/cli/) | 发布包 [`@content-forge/sketchpad`](https://www.npmjs.com/package/@content-forge/sketchpad)：CLI + REST/SSE 后端 + snapshot 渲染器，`fonts/`（霞鹜文楷 Lite，OFL）与 `skill/`（agent 技能）随包发布 |
| [`packages/web`](packages/web/) | 私有包 `@content-forge/sketchpad-web`：React 前端，looseleaf ink 管线来自 `@content-forge/ink`；vite 构建产物直接写入 `packages/cli/web-dist/` |

## 快速开始

```bash
npm i -g @content-forge/sketchpad
sketchpad ui    # 打开（或拉起）画板服务并打印页面地址
```

两种运行模式（自动选择）：装了 [`@content-forge/daemon`](https://www.npmjs.com/package/@content-forge/daemon) 时注册进守护进程（页面挂在 `/project/<项目名>/sketchpad/`），否则起本地常驻服务（127.0.0.1 随机端口）。

CLI 用法、agent 作画约定与创作工作流见 [`packages/cli/README.md`](packages/cli/README.md) 与 [`packages/cli/skill/SKILL.md`](packages/cli/skill/SKILL.md)。

## 开发

```bash
pnpm install
pnpm build        # 先 vite（前端 → packages/cli/web-dist/）再 tsc（服务端 packages/cli/dist/）
pnpm dev:web      # 前端 dev server（API 代理到本地 serve）
pnpm typecheck    # 两个包各自 tsc --noEmit
pnpm ui           # 启动画板服务并打印页面地址
```

License: MIT（字体各自遵循其 OFL 许可）
