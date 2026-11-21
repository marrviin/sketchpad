---
name: sketchpad
description: 用 sketchpad CLI 在 looseleaf 手绘板上创作手绘内容：自创手绘 icon、手绘架构图/流程图、手绘风格原型图——网格定位、spline/hatch/dash 手绘语法、手写风文字标注，画完 snapshot 自查修正。当用户要求"画个 icon / 画示意图 / 手绘架构图 / 手绘流程图 / 原型草图 / 在画板上画 / 白板演示"时使用。写实图像不适合画板，改用生图工具。
---

# sketchpad 手绘板创作工作流

sketchpad = looseleaf Sketchpad 画板（统一前端 `/sketchpad` 入口）+ CLI。定位是**手绘内容创作**：自创 icon、架构图/流程图、原型草图——不是写实绘画（那类需求改用生图工具），也不是图标库搬运（靠创作语法 + 自查回路画新东西）。

人在浏览器页面画/擦/撤销会回流后端，agent 的每一笔经 SSE 秒级出现在页面上。

## 标准流程：画 → 自查 → 修正（循环）

```bash
sketchpad state          # ① 拿画布 id、尺寸、当前画笔、已有内容（= tool get_state）
sketchpad new            #    （或新建画布，返回画布 id 与页面 URL）
sketchpad grid '{"canvas":"<id>"}'                                     # ② 铺 24×24 构造网格（画 icon 时）
sketchpad draw '{"shapes":[...],"unit":"norm","canvas":"<id>"}'        # ③ 一批形状/文本
sketchpad snapshot '{"canvas":"<id>"}'                                 # ④ 渲染 PNG 落盘
```

⑤ 用 **Read 工具查看 snapshot 返回的 PNG**——自查回路的关键一步，每批画完必须看。
⑥ 不像/位置不对 → `sketchpad undo`（`redo` 反悔）撤掉重画；像了 → 回到 ③。
⑦ 画完 icon 后 `sketchpad undo` 撤掉构造网格（或保留当构图辅助）。

> snapshot 是 looseleaf 笔刷的轻量近似（折线+圆帽+手写体文字），判断构图/形状/比例/颜色/位置足够；给用户展示最终效果用 `sketchpad preview` 的页面截图。

## 三种创作场景

### 手绘 icon（自创）
- 24×24 网格思维：先 `grid` 铺网格，icon 占中央 ~2/3；keyshape（圆/方/弧）定大形，细节往里放。
- **先大形后细节**：第一批画 keyshape → snapshot 自查比例 → 第二批五官/部件 → 加深定型。
- 有机轮廓（云、火焰、叶子、动物剪影）用 `spline` 过点画，不要手拧 bezier。
- 画完 `undo` 撤网格。

### 手绘架构图 / 流程图
- 节点：`rrect` 圆角框；分层强调用 `hatch` 排线或换色。
- 连线：有方向用 `arrow`；无方向关联用 `line`；边界/隐藏层用 `dash`。
- 标注：`text` 手写风文字（节点名、箭头说明）；节点名放框内（text 左上角对齐框内左上），箭头说明放线旁。
- 布局自上而下或自左而右，坐标全部用 `unit:"norm"` 归一化。

### 手绘风格原型图
- 卡片/组件：`rrect`；强调/选中态：`hatch` 排线；隐藏/折叠边界：`dash`。
- 文本：`text` 当 UI 标签（按钮字、标题、占位符说明）。
- 组件间距用 norm 坐标换算：画布 1040×620，1% 宽 ≈ 10px。

## shapes 参数速查

| 形状 | 参数 |
| --- | --- |
| point | `{x,y}` |
| line | `{from:{x,y}, to:{x,y}}` |
| polyline | `{points:[{x,y}…]}`（≤4000 点） |
| rect / rrect | `{x,y,w,h}` / `{x,y,w,h,r}` |
| ellipse | `{cx,cy,rx,ry}` |
| arc | `{cx,cy,rx,ry,startDeg,endDeg}`（0°=向右，正方向顺时针） |
| polygon / star | `{cx,cy,r,sides,rotDeg?}` / `{cx,cy,rOuter,rInner,points,rotDeg?}` |
| bezier | `{start,cp1,cp2,end}`（精确单段曲线） |
| spline | `{points:[{x,y}…]}`（过点平滑曲线，≥3 点——有机形状主力） |
| arrow | `{from,to,head?}`（自动三笔：主体线+两条头部短线） |
| dash | `{from,to}`（虚线，多笔分段，段长随手绘线宽变） |
| hatch | `{x,y,w,h,angleDeg?,gap?}`（区域排线"涂阴影"，多笔；norm 下 gap 也是比例） |
| text | `{x,y,text,size?(字号px,默认~29),color?}`（手写风文字；x,y 左上角；size 恒为 px 不参与 norm 缩放） |

每个形状可覆盖 `tool`/`color`/`size`（text 只有 color）；批级默认由 draw 顶层参数给。点/线端点必须 `{x,y}` 对象（部分 LLM 网关拒绝 tuple）。

## 画笔与色板

| 画笔 | 特点 | 创作场景用法 |
| --- | --- | --- |
| `felt` 毡头笔 | 均匀墨线 | icon/框线主力 |
| `brush` 毛笔 | 压力粗细变化 | 强调线 |
| `pencil` 颗粒感 | 构造线/网格/hatch | 打稿、排线 |
| `marker` 马克笔 | 粗扁笔触 | 大面积形状轮廓 |
| `highlighter` 荧光笔 | 半透明宽帽；深色自动换黄 | 区域底色 |
| `eraser` 橡皮 | 擦除（页面用） | agent 用 undo 替代 |

颜色是**命名色板**（不能传 hex）：`ink` / `ink-you`(蓝) / `red` / `green` / `marker`(橙红) / `tangerine` / `hi`(黄) / `teal` / `grape` / `bubblegum`(粉)。

## 坐标系与画布

- **无限画布**：坐标空间无界（页面可滚轮平移、ctrl/⌘+滚轮缩放、中键或 Space 拖拽平移），可画出首页画框之外的内容。默认**画布像素**（原点 = 首页画框 1040×620 的左上角，y 向下）；`draw` 顶层 `"unit":"norm"` 则坐标按 0~1 归一化（**相对首页画框宽高**），**长度类字段（w/h/r/rx/ry/gap）统一按首页框宽缩放**（圆/正方形不因宽高比变形），text 字号恒为 px。首页框内构图用 norm，框外内容用 px。
- 画布按 id（`YYYYMMDDHHmmss`）隔离：并发作画的多个 agent 各自 `new`，之后所有调用带 `canvas` id。
- 文档落盘 `<项目根>/.content-forge/sketchpad/<画布id>.json`（strokes + texts 一起）；snapshot PNG 落 `.content-forge/sketchpad/previews/`。
- snapshot 默认取景 = 内容包围盒 ∪ 首页画框（框内内容取景与固定画布一致），`region:{x,y,w,h}` 可显式指定区域。
- 文本元素（texts）是 agent-only：页面只渲染不编辑，undo/clear 与笔迹一起进出。

## 环境与同步机制

```bash
sketchpad ui    # 确保统一前端在线并打印画板页面地址
```

- 页面受控同步：SSE rev 去抖 + PUT 回流。直连旧入口页面会降级纯本地模式——确认走 `sketchpad ui`。
- 文字用霞鹜文楷 Lite（OFL，字体文件在 `packages/web/src/apps/sketchpad/fonts/`）：页面 @font-face 与 snapshot 渲染共用同一 TTF，两端一致。
- 后端长驻：改了 sketchpad 包源码后 `pkill -f canvas-backend` 让网关重拉；改了前端组件要 `pnpm --filter @content-forge/web build`。

## 常见问题

| 现象 | 处置 |
| --- | --- |
| preview 页面没显示内容 | 确认前端经 `sketchpad ui` 启动（旧入口无画板 API） |
| 笔画越界/位置不对 | 用 `unit:"norm"`（首页框内），或以 `state` 的首页框尺寸为准换算；框外内容用 px 坐标 |
| 颜色设置无效 | 只接受命名色板，hex 会被拒 |
| 多人/多 agent 同时画 | 各自 new 隔离 |
| 改了代码新形状不生效 | `pkill -f canvas-backend` 重启画板后端 |
| snapshot 里文字是巨大墨块/缺失 | 确认 text 的 size 传的是字号 px（norm 模式下也不缩放） |
