# sketchpad

手绘板：looseleaf Sketchpad 画板 —— 手绘风页面（笔刷质感/颗粒/压力）+ REST/SSE 后端 + CLI，agent 作画、人实时观看。

- **页面是纯查看器**：拖拽平移、滚轮缩放、切换画布、叙事回放；作画全部经 CLI / API（带 canvas id）由 agent 完成，每一笔经 SSE 秒级出现在页面
- 多画布隔离：并发 agent 各绑一块画布，rev/撤销栈/笔迹互不影响；数据落盘 `<项目根>/.content-forge/sketchpad/<id>.json`
- `snapshot` 渲染 PNG 给 agent 自查（画 → 自查 → 修正回路）
- 叙事回放：agent 作画带 `group` + `order`（1 画布 → 2 骨架 → 3 主内容 → 4 次级 → 5 标注），页面 `?c=<id>&replay=1` 按叙事层级逐组铺开，像讲产品而不是乱画

## 安装与使用

```bash
npm i -g @content-forge/sketchpad
sketchpad ui    # 打开（或拉起）画板服务并打印页面地址
```

两种运行模式（自动选择）：

- **daemon 模式**：装了 [`@content-forge/daemon`](https://www.npmjs.com/package/@content-forge/daemon) 时，注册进守护进程，页面挂在 `/project/<项目名>/sketchpad/`（与统一前端生态共用路由）
- **独立模式**：无 daemon 包时，起本地常驻服务（127.0.0.1 随机端口），状态记录在 `<项目根>/.content-forge/sketchpad/server.json`

## CLI

```bash
sketchpad state            # 画布 id、尺寸、当前画笔、已有内容
sketchpad new              # 新建画布（返回 id 与页面 URL）
sketchpad draw '{"shapes":[…],"unit":"norm"}'   # 一批形状/文本（norm=0~1 归一化坐标）
sketchpad order '{"canvas":"<id>","orders":{"标注":5,"主流程":3}}'   # 修叙事层级（回放按此编排）
sketchpad snapshot         # 渲染 PNG 落盘，供 agent Read 自查
sketchpad undo / redo / erase / clear / grid / brush / use / preview
sketchpad tool <名> [json]  # 通用入口（工具名可省略 sketchpad_ 前缀）
```

形状种类：point / line / polyline / rect / rrect / ellipse / arc / polygon / star / bezier / arrow / dash / spline / hatch / text；icon（手绘内置图标）经 draw 的 `icons` 字段单独传入。参数 JSON 支持内联、`@文件路径` 或 stdin 管道。

## Claude skill

`skill/SKILL.md` 是 sketchpad 创作工作流的 skill（画 → 自查 → 修正循环、网格定位、自查要点）。使用方式：复制到 `~/.claude/skills/sketchpad/`。

## 开发

```bash
pnpm install
pnpm build        # pnpm monorepo：vite（前端 → packages/cli/web-dist/）+ tsc（服务端 packages/cli/dist/）
pnpm dev:web      # 前端 dev server（API 代理到本地 serve）
pnpm typecheck
```

结构：pnpm monorepo——

```
packages/
├── cli/     # 发布包 @content-forge/sketchpad：src/（CanvasStore + REST/SSE + snapshot 渲染器 + CLI）
│            #   bin/、fonts/（霞鹜文楷 Lite，OFL）、skill/（agent 技能）、web-dist/（前端产物，随包发布）
└── web/     # 私有包 @content-forge/sketchpad-web：React 前端，looseleaf ink 管线来自 @content-forge/ink
             #   vite 构建产物直接写入 packages/cli/web-dist/
```

License: MIT（字体各自遵循其 OFL 许可）
