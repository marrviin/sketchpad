# sketchpad · 手绘板

**让 AI agent 把想法画成一张手绘白板，你在浏览器里实时看着它画。**

sketchpad 是一块 looseleaf 手绘板：手绘风页面（笔刷质感、颗粒、压力）、REST/SSE 后端和一套 CLI / 工具接口。AI agent 经 CLI 或工具调用在画板上画架构图、流程图、原型草图和手绘 icon，**每一笔秒级出现在你的浏览器里**；页面是纯查看器——拖拽平移、滚轮缩放、切换画布、叙事回放，作画全部交给 agent。

**推荐：安装为 agent 技能**（一键装上「会画手绘板」的完整工作流——画 → 自查 → 修正循环、网格定位、叙事层级、质量基线）：

```bash
npx skills add marrviin/sketchpad
```

装好后 agent 直接知道怎么用 sketchpad；再装 CLI 本体即可开箱即画：

```bash
npm i -g @content-forge/sketchpad
sketchpad ui    # 打开（或拉起）画板服务并打印页面地址
```

也可以只装 CLI 手动使用：

```bash
npm i -g @content-forge/sketchpad
sketchpad ui    # 打开（或拉起）画板服务并打印页面地址
```

## 效果演示

| 多屏原型动线（叙事回放） | 流程图（compose 场景构图） |
|---|---|
| <video src="docs/demo-wireframe.mp4" controls muted loop></video> | <video src="docs/demo-flow.mp4" controls muted loop></video> |

## 它擅长画什么

- **手绘架构图 / 流程图**：方框、箭头、连接线，配合网格定位对得整齐；spline 过点平滑曲线画有机形状，hatch 画排线阴影
- **手绘风原型草图**：页面骨架、设备框、分区、卡片——用「叙事层级」从背景到标注逐层铺开，回放时像讲产品一样逐层演示
- **手绘 icon**：内置 160 个手绘 icon（数据库、云、齿轮、人物……），agent 直接按名字取用
- **白板演示**：毡头笔 / 毛笔 / 铅笔 / 马克笔 / 荧光笔的笔刷质感 + 真实手写风字体，画出来像纸笔，不像默认图形库

## 核心能力

**实时同步观看**
agent 的每一笔经 SSE 秒级出现在页面。开一个浏览器窗口挂在旁边，就是一块实时直播的白板；页面拖拽平移、滚轮缩放、右上角切换画布，怎么舒服怎么看。

**多画布隔离**
每块画布有独立 id、版本与撤销栈，并发 agent 各绑一块画布互不影响。数据落盘 `<项目根>/.content-forge/sketchpad/<id>.json`，重启不丢。

**snapshot 自查回路**
`sketchpad snapshot` 把画布渲染成 PNG 给 agent 自己看——画 → 自查 → 修正，agent 不需要问你「画得怎么样」，画错了自己 `undo` 重来。

**场景构图：画得好是算法保证，不是模型自觉**
流程图、时序图、原型骨架这些结构化场景，agent 给结构化描述（节点/连线/参与者/分区），`sketchpad compose` 内置确定性布局一次成图——节点按文字宽度自适应、对齐与间距由算法保证、连线自动贴边、回退边自动绕行。而且**按叙事分幕落笔**：流程图沿图逐节点走、时序图逐消息一幕，回放就是沿图讲故事，不是平铺。agent 再在手绘细节上自由发挥，骨架不会乱。

**叙事大纲与叙事体检**
`sketchpad state {"narrative":true}` 输出回放故事线（各幕顺序 + 预计时长），agent 演示前先「读一遍故事」；`sketchpad lint` 自动检查叙事质量——未设层级的组（回放垫底）、单组吞掉全图（没节奏）、标注层混入结构，连同几何问题一起给 agent 修。叙事顺序清晰是算法和工具保证的，不靠模型自觉。

**lint 自查回路**
`sketchpad snapshot` 渲染 PNG 给 agent 目测，`sketchpad lint` 把「画得不好」的可计算信号变成清单——文本重叠、文字压在框线/箭头上、内容出框，返回元素 id，agent 直接删掉重画。画 → lint → snapshot → 修正，质量闭环不靠运气。

**叙事层级 + 回放**
回放按「讲故事」编排：多屏产品动线（列表 → 详情 → 评论）每屏一幕——手机框、内容、文字一起出现，讲完一屏再进下一屏；单视图则按 画布 → 骨架 → 内容 → 标注 分层推进。agent 作画时用 `group` + `order` 声明章节，页面右键「回放」或 `?replay=1` 逐幕演示；`sketchpad order` 可事后修序，不用重画。

**按比例思考**
画布坐标支持 `unit: "norm"`（0~1 归一化），agent 按比例布局不用算像素；也支持像素坐标画框外内容。

## 用起来是什么样

```bash
sketchpad ui              # 拉起服务，打印页面地址，浏览器打开
sketchpad new             # 新建画布
sketchpad compose @flow.json    # 场景构图：结构骨架一次成图（flow/sequence/wireframe）
sketchpad draw '{"unit":"norm","shapes":[…]}'   # agent 手绘细节/自由形状，页面实时看到
sketchpad lint            # 几何自查：重叠/压线/出框，返回可修的 id 清单
sketchpad snapshot        # 渲染 PNG 给 agent 自查
sketchpad undo            # 画错了撤销重来
```

**作为 agent 技能使用**：[`packages/cli/skill/SKILL.md`](packages/cli/skill/SKILL.md) 是完整的创作工作流 skill（画 → 自查 → 修正循环、网格定位、叙事层级、质量基线）。推荐用 `npx skills add marrviin/sketchpad` 一键安装；也可手动复制到 `~/.claude/skills/sketchpad/`，让 Claude Code 装上「会画手绘板」的能力。

**daemon 集成**：装了 [`@content-forge/daemon`](https://www.npmjs.com/package/@content-forge/daemon) 时自动注册进守护进程，画板挂在 `/project/<项目名>/sketchpad/`，与统一前端生态共用路由；没有 daemon 就起本地常驻服务，开箱即用。

## 开发

本仓库是 pnpm monorepo：[`packages/cli`](packages/cli/)（发布包：CLI + 后端 + snapshot 渲染器 + 技能）与 [`packages/web`](packages/web/)（React 前端）。构建、typecheck 与目录结构见 [`packages/cli/README.md`](packages/cli/README.md#开发)。

License: MIT（字体各自遵循其 OFL 许可）
