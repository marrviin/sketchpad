# @content-forge/sketchpad

[![npm version](https://img.shields.io/npm/v/@content-forge/sketchpad.svg)](https://www.npmjs.com/package/@content-forge/sketchpad)
[![license](https://img.shields.io/npm/l/@content-forge/sketchpad.svg)](https://github.com/marrviin/sketchpad/blob/main/LICENSE)

> **让 AI agent 把想法画成一张手绘白板，你在浏览器里实时看着它画。**

这是 [sketchpad](https://github.com/marrviin/sketchpad)（中文 README 传送门）的 npm 发布包：**CLI + REST/SSE 后端 + 查看器页面 + 手绘字体**，一个包全部带走。

---

## 它是什么

sketchpad 是一块 **agent 驱动**的手绘白板。人不碰笔——你用自然语言让 agent 画架构图、流程图、原型草图、手绘 icon，每一笔经 SSE 秒级出现在浏览器里。页面是纯查看器：拖拽平移、滚轮缩放、切换画布、叙事回放，作画全部经 CLI / API（带 canvas id）由 agent 完成。

风格是纸笔手绘（笔刷质感、颗粒、压力、手写字体），不是默认的矢量图形库。

- **多画布隔离**：并发 agent 各绑一块画布，rev / 撤销栈 / 笔迹互不影响
- **snapshot 自查回路**：agent 每画完一张渲染 PNG 自己看，画歪了 `undo` 重画——闭环不靠模型自觉，是工具保证的
- **叙事分幕回放**：作画带 `group` + `order`（画布 → 骨架 → 主内容 → 标注），页面 `?replay=1` 按叙事层级逐组铺开
- **数据落盘**：`<项目根>/.content-forge/sketchpad/<id>.json`，无云端依赖

## 安装

```bash
npm i -g @content-forge/sketchpad
sketchpad ui    # 打开（或拉起）画板服务并打印页面地址
```

两种运行模式（自动选择）：

- **daemon 模式**：装了 [`@content-forge/daemon`](https://www.npmjs.com/package/@content-forge/daemon) 时，注册进守护进程，页面挂在 `/project/<项目名>/sketchpad/`
- **独立模式**：无 daemon 包时，起本地常驻服务（127.0.0.1 随机端口），状态记录在 `<项目根>/.content-forge/sketchpad/server.json`

不想全局装也可用 `npx -y @content-forge/sketchpad` 代替 `sketchpad` 前缀。

## 推荐：配合 Claude skill 使用

手动敲命令只是兜底——装上 skill，agent 会把「画 → 自查 → 修正」的工作流全包了：

```bash
npx skills add marrviin/sketchpad
```

装完在 Claude Code 里说一句「帮我画一张登录流程图」即可。完整创作工作流见仓库 [`skills/sketchpad/SKILL.md`](https://github.com/marrviin/sketchpad/blob/main/skills/sketchpad/SKILL.md)。

## CLI 命令参考

```bash
sketchpad state                 # 画布 id、尺寸、当前画笔、已有内容（含语义分组清单）
sketchpad new                   # 新建画布（返回 id 与页面 URL）
sketchpad compose @scene.json   # 场景构图：flow / sequence / wireframe 结构骨架一次成图
sketchpad draw '{"shapes":[…]}' # 手绘细节/自由形状（长参数用 @文件 或 stdin 管道）
sketchpad icons                 # 列出全部内置手绘 icon 名字
sketchpad order '{"orders":{"标注":5,"主流程":3}}'   # 修叙事层级（回放按此编排）
sketchpad lint                  # 几何自查：文本重叠/压线/出框，返回可修的 id 清单
sketchpad snapshot              # 渲染 PNG 落盘，供 agent Read 自查
sketchpad undo / redo / erase / clear / grid / brush / use / preview
sketchpad tool <名> [json]      # 通用入口（工具名可省略 sketchpad_ 前缀）
```

- 形状种类：point / line / polyline / rect / rrect / ellipse / arc / polygon / star / bezier / arrow / dash / spline / hatch / text / stencil（db、server、cloud、phone、browser 等复合符号）/ icon（内置 160 个手绘真图标，`sketchpad icons` 查名单）
- `draw` 支持 `unit: "norm"`（0~1 归一化坐标，相对首页画框），agent 按比例布局不用算像素
- 参数 JSON 支持内联、`@文件路径` 或 stdin 管道

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
│            #   bin/、fonts/（霞鹜文楷 Lite，OFL）、web-dist/（前端产物，随包发布）
└── web/     # 私有包 @content-forge/sketchpad-web：React 前端，looseleaf ink 管线来自 @content-forge/ink
             #   vite 构建产物直接写入 packages/cli/web-dist/
skills/
└── sketchpad/  # Claude skill（完整创作工作流），经 npx skills add 安装
```

## License

MIT（内置字体各自遵循其 OFL 许可）。
