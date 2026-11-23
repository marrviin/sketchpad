# sketchpad · 手绘板

**让 AI agent 和你坐在同一张手绘白板前作画。**

sketchpad 是一块 looseleaf 手绘板：手绘风的页面（笔刷质感、颗粒、压力）、REST/SSE 后端和一套 CLI / 工具接口。AI agent 经 CLI 或工具调用在画板上画架构图、流程图、原型草图和手绘 icon，**每一笔秒级出现在你的浏览器里**；你在页面上的每一笔手绘也会实时回流给 agent。人与 agent 共享同一块画布、同一个撤销栈。

```bash
npm i -g @content-forge/sketchpad
sketchpad ui    # 打开（或拉起）画板服务并打印页面地址
```

## 它擅长画什么

- **手绘架构图 / 流程图**：方框、箭头、连接线，配合网格定位对得整齐；spline 过点平滑曲线画有机形状，hatch 画排线阴影
- **手绘风原型草图**：页面骨架、设备框、分区、卡片——用「叙事层级」从背景到标注逐层铺开，回放时像讲产品一样逐层演示
- **手绘 icon**：内置 160 个手绘 icon（数据库、云、齿轮、人物……），agent 直接按名字取用
- **白板演示**：笔刷质感（毡头笔 / 毛笔 / 铅笔 / 马克笔 / 荧光笔）+ 真实手写风字体，画出来像纸笔，不像默认图形库

## 核心能力

**agent 与人双向同步作画**
agent 的每一笔经 SSE 秒级出现在页面；人在页面画 / 擦 / 撤销会回流后端，agent 下次 `state` 就能看到。两边共享撤销栈，`undo` 一次可以撤销任何一方最近的变更。

**多画布隔离**
每块画布有独立 id、版本与撤销栈，并发 agent 各绑一块画布互不影响，页面右上角随时切换。数据落盘 `<项目根>/.content-forge/sketchpad/<id>.json`，重启不丢。

**snapshot 自查回路**
`sketchpad snapshot` 把画布渲染成 PNG 给 agent 自己看——画 → 自查 → 修正，agent 不需要问你「画得怎么样」。

**叙事层级 + 回放**
agent 作画时给每批笔迹带 `group` + `order`（1 画布 → 2 骨架 → 3 主内容 → 4 次级 → 5 标注），页面 `?replay=1` 按叙事层级逐组铺开、组间停顿，像有人在你面前讲产品。画完顺序不对？`sketchpad order` 事后修序，不用重画。

**按比例思考**
画布坐标支持 `unit: "norm"`（0~1 归一化），agent 按比例布局不用算像素；也支持像素坐标画框外内容。

## 用起来是什么样

```bash
sketchpad ui              # 拉起服务，打印页面地址，浏览器打开
sketchpad new             # 新建画布
sketchpad draw '{"unit":"norm","shapes":[…]}'   # 一批形状/文本，页面实时看到
sketchpad snapshot        # 渲染 PNG 给 agent 自查
sketchpad undo            # 撤销（agent 和你共用）
```

页面里你可以直接上手画、擦、改画笔——和 agent 的笔迹在一起，随时接管或补几笔。

**作为 agent 技能使用**：`packages/cli/skill/SKILL.md` 是完整的创作工作流 skill（画 → 自查 → 修正循环、网格定位、叙事层级、质量基线），复制到 `~/.claude/skills/sketchpad/` 即可让 Claude Code 装上「会画手绘板」的能力。

**daemon 集成**：装了 [`@content-forge/daemon`](https://www.npmjs.com/package/@content-forge/daemon) 时自动注册进守护进程，画板挂在 `/project/<项目名>/sketchpad/`，与统一前端生态共用路由；没有 daemon 就起本地常驻服务，开箱即用。

## 开发

本仓库是 pnpm monorepo：[`packages/cli`](packages/cli/)（发布包：CLI + 后端 + snapshot 渲染器 + 技能）与 [`packages/web`](packages/web/)（React 前端）。构建、typecheck 与目录结构见 [`packages/cli/README.md`](packages/cli/README.md#开发)。

License: MIT（字体各自遵循其 OFL 许可）
