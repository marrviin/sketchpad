---
name: sketchpad
description: 用 sketchpad CLI 在 looseleaf 手绘板上创作手绘内容：自创手绘 icon、手绘架构图/流程图、手绘风格原型图——网格定位、spline/hatch/dash 手绘语法、手写风文字标注，画完 snapshot 自查修正。当用户要求"画个 icon / 画示意图 / 手绘架构图 / 手绘流程图 / 原型草图 / 在画板上画 / 白板演示"时使用。写实图像不适合画板，改用生图工具。
---

# sketchpad 手绘板创作工作流

sketchpad = looseleaf Sketchpad 画板（统一前端 `/sketchpad` 入口）+ CLI。定位是**手绘内容创作**：自创 icon、架构图/流程图、原型草图——不是写实绘画（那类需求改用生图工具）。UI 图标直接用内置的 looseleaf 真图标（`icon` 形状，1:1）；自创图形靠创作语法 + 自查回路画。

人在浏览器页面画/擦/撤销会回流后端，agent 的每一笔经 SSE 秒级出现在页面上。

## 标准流程：画 → 自查 → 修正（循环）

```bash
sketchpad state          # ① 拿画布 id、尺寸、当前画笔、已有内容（= tool get_state）
sketchpad new            #    （或新建画布，返回画布 id 与页面 URL）
sketchpad compose @scene.json      # ② 结构骨架（流程图/时序图/原型骨架）一次构图，见下节；自由构图则 grid+draw
sketchpad draw '{"canvas":"<id>","shapes":[…]}'   # ③ 叠手绘细节/自由形状（长参数用 @file，免 shell 引号地狱；也支持管道 stdin）
sketchpad lint '{"canvas":"<id>"}'                 # ④ 几何自查：文本重叠/压线/出框，返回 id 清单
sketchpad snapshot '{"canvas":"<id>"}'             # ⑤ 渲染 PNG 落盘
```

⑥ 用 **Read 工具查看 snapshot 返回的 PNG**——自查回路的关键一步，每批画完必须看。
⑦ 修：lint 清单里的文本/笔迹问题 `sketchpad erase '{"ids":[…]}'` 按 id 删重画；构图/比例不对再 snapshot 目测，小错删元素、整批不像才 `sketchpad undo`（`redo` 反悔）。像了 → 回到 ③。
⑧ 画完 icon 后 `sketchpad undo` 撤掉构造网格（或保留当构图辅助）。

> snapshot 是 looseleaf 笔刷的轻量近似（折线+圆帽+手写体文字），判断构图/形状/比例/颜色/位置足够；给用户展示最终效果用 `sketchpad preview` 的页面截图。

**批粒度铁律**：undo 的粒度 = 一次 draw 调用。按"结构批（框）/连线批/标注批"分多次 draw，每批之间 snapshot 自查——一批画歪只撤这一批；大批混在一次 draw 里只能整批回滚。

## 语义分组：按名擦 / 按名改（精准修改）

给每批画的东西**起个语义名**，后端记住它包含哪些笔迹/文字，以后按名精准擦掉重画——不用靠坐标猜"哪几条是数据库"。

```bash
sketchpad draw '{"canvas":"<id>","group":"数据库","shapes":[…]}'     # 这批归入"数据库"
sketchpad state '{"canvas":"<id>","ids":true}'                        # 列出所有组：「数据库」4笔迹+1文本
sketchpad erase '{"canvas":"<id>","name":"数据库"}'                   # 一把擦掉整组（连带标签）
sketchpad draw '{"canvas":"<id>","group":"数据库","shapes":[新形状]}'  # 重画该组
```

- **何时用**：凡是会被单独修改的东西——一个节点、一个组件、一条标注、整个手机框——draw 时带 `group` 命名。
- **用户说"数据库那个圆柱画得不像"** → `state` 找组 → `erase {name:"数据库"}` → 重画。不用列 id、不用算坐标。
- 同名 group 多次 draw 会**合并**进同一组；erase 按名删整组后再画同名会重建。
- 页面手画的笔迹没有 group（agent-only 语义）；页面 PUT 回流不会冲掉 agent 的组。

## 场景构图：compose 一次成骨架（流程图 / 时序图 / 原型骨架）

结构化场景**不要手排坐标**——`compose` 内置确定性布局（对齐、间距、节点尺寸按文字宽度自动算、连线起止贴边、回退边自动绕行），一次调用画出正确骨架，比手排又快又准：

```bash
sketchpad compose '{"scene":"flow","title":"下单流程","nodes":[
  {"id":"s","label":"进入","kind":"start"},{"id":"a","label":"浏览","icon":"search"},
  {"id":"d","label":"库存够?","kind":"decision"},{"id":"e","label":"完成","kind":"end"}],
 "edges":[{"from":"s","to":"a"},{"from":"a","to":"d"},{"from":"d","to":"e"},{"from":"d","to":"a","label":"否","dashed":true}]}'   # 流程图：start/end 椭圆、process 圆角框、decision 菱形，dir=tb/lr
sketchpad compose '{"scene":"sequence","participants":[{"id":"u","label":"用户"},{"id":"p","label":"网关"}],
 "messages":[{"from":"u","to":"p","label":"请求"},{"from":"p","to":"u","label":"回调","kind":"dashed"}]}'   # 时序图：生命线/消息箭头/自调用回环，消息按发生顺序给
sketchpad compose '{"scene":"wireframe","frame":"phone","regions":[
  {"x":0.06,"y":0.02,"w":0.88,"h":0.1,"label":"搜索栏"},{"x":0.06,"y":0.16,"w":0.88,"h":0.3,"label":"Banner"}]}'   # 原型骨架：设备框 + 内容区（0~1 归一化）
```

- compose 按**叙事分幕**落笔：流程图沿图逐节点（入边先画、节点后现）、时序图逐消息一幕、原型按 设备框→分区 分层；每幕一个语义组（节点/分区用自身 label 命名，重复自动去重），标题幕 order=1、参与者/设备框 order=2、内容幕默认 order=3；`group` 参数作组名前缀、`order` 参数调内容层级。
- **先 compose 打底，再用 draw 叠手绘细节**（涂改痕迹、hatch 阴影、强调色、装饰）——细节画在骨架坐标上，勿整组重画。
- 自由构图（不规则插画、icon 创作、非标准布局）仍用 `draw`；两条路线不冲突。

## 叙事层级：按产品叙事画，回放按叙事播

给每批 draw 带 `group` + `order`（叙事层级），且**实际绘制顺序也按层级推进**——先背景后内容、主内容沿用户动线，回放/演示时逐级铺开，像讲产品而不是乱画：

```bash
sketchpad draw '{"canvas":"<id>","group":"设备框","order":1,"shapes":[…]}'   # ① 先画画布/设备框
sketchpad draw '{"canvas":"<id>","group":"骨架分区","order":2,"shapes":[…]}'  # ② 再画分区/导航骨架
sketchpad draw '{"canvas":"<id>","group":"主流程","order":3,"shapes":[…]}'    # ③ 主内容按用户动线
sketchpad draw '{"canvas":"<id>","group":"次级内容","order":4,"shapes":[…]}'  # ④ 次级内容/卡片
sketchpad draw '{"canvas":"<id>","group":"标注","order":5,"shapes":[…]}'      # ⑤ 最后标注/说明
sketchpad order '{"canvas":"<id>","orders":{"标注":5,"主流程":3}}'            # 画完可事后修序（可撤销）
```

- **规范五级**：1 画布/设备框 → 2 骨架分区 → 3 主内容/用户动线 → 4 次级内容 → 5 标注。可超五级（如主流程内多步 3/4/5…），数字不必连续，回放按数值升序。
- `order` 必须与 `group` 同时给；同名组重画时带新 `order` 即覆盖。绘制批次严格按 level 从低到高发——观看页面直播时就是正确的产品节奏。
- 回放规则（页面 `?c=<id>&replay=1` 触发，或演示给用户看）：按层级逐组逐笔播放，组间停顿 ~0.35s；无 order 的组排在最后；无组笔迹最后按文档顺序。无分组画布回放 = 文档顺序（原行为）。
- 画完发现顺序不对（如标注混进了中间）→ `state {"ids":true}` 看各组「阶段」→ `sketchpad order` 修序，不用重画。
- **演示前先读故事线**：`state {"narrative":true}` 输出叙事大纲（各幕按回放顺序 + 预计时长）——检查幕数是否合理（单幕吞掉全图 = 没节奏）、有没有未设 order 的组垫底。`lint` 也会自动报这两类叙事问题。

## 画得好：质量基线（所有场景通用）

> "好"= 布局合理且正确，不只是美观。这是用户反复反馈的问题清单，开画前和每批自查时对照。

**布局/间距**
- 先数元素个数，用 **px 精确算 pitch**（间距），别用 norm 随手拍 0.07/0.21。norm 下 h 按宽缩放，纵向必拥挤。
- **一张图只用一套间距档位**（页面边距 20 / 大栏间 16 / 卡间 20 / 卡内 10~12 / 线→内容 ≥14，详见 prototypes.md 间距规范）——先算可用空间定档，全图共用；别这排 12 那排 16。
- 上下边距平衡，元素不贴画布边缘；相邻元素间距 <10px 或文字贴框 <4px = 太紧凑，重排。
- 元素间距 ≥ 自身高度 1/3；连线箭头 ≥30px（短 stub 显挤）。

**对齐**
- 网格对齐：同一列 x 严格一致，同一行 y 基线一致。
- 文字在容器内**垂直居中**（y ≈ 容器顶 + 容器高/2 − 字号/2）。
- 节点标签**水平居中**；列表行按列对齐（头像列 / 文字列 / 时间列三列）。
- 元素中心 = 行/容器中心（头像中心 = 文字块中心 = 行中心）。
- **icon 盒中心 = 所在区域中心线**：先算区域中心线，`y = 中心线 − size/2`。不同 size 的图标在同一条中心线上各自反推 y（工具栏中心 98 → size=24 图标 y=86、size=16 图标 y=90），别给所有图标同一个 y。

**分层（线宽 + 颜色）**
- 外层框**粗**（`size:1.5~1.8`），内部分隔线**细**（`size:0.5`）——别所有线一样粗。
- 颜色 = 语义：架构按层配色、状态（选中=绿、未读=红）、强调。不是装饰。
- 粗框 = 区域边界，细线 = 内容结构，一眼分出"这是哪一块"。

**文字**
- 单行，不塞两行（机制说明放旁注）。
- `size` 恒为 px，不参与 norm 缩放。
- 算文字宽度（CJK≈字号、ascii≈字号×0.55），避免撞右边元素。
- 字号分级：标题 > 标签 > 辅助说明。

**连线（手绘风）**
- 回路/绕回用紧 `bezier`（鼓出 ~60px），不用直角折线、不用 spline 大圈。
- 主脊柱 / 垂直流向保留直线。
- 箭头尖手绘两笔。

## 三种创作场景

### 手绘 icon（自创）
- **UI 图标（工具栏/按钮/列表里的小图标）一律用 `icon` 形状**——looseleaf 真图标 1:1，别手画。定位公式 `y = 区域中心线 − size/2`，详见 [references/icons.md](references/icons.md)。
- 只有画板 icon 库里**没有**的图形（自创吉祥物、业务符号）才手画：
- 24×24 网格思维：先 `grid` 铺网格，icon 占中央 ~2/3；keyshape（圆/方/弧）定大形，细节往里放。
- **先大形后细节**：第一批画 keyshape → snapshot 自查比例 → 第二批五官/部件 → 加深定型。
- 有机轮廓（云、火焰、叶子、动物剪影）用 `spline` 过点画，不要手拧 bezier。
- 画完 `undo` 撤网格。
- 图标设计原则与高频配方（放大镜/齿轮/用户/爱心/铃铛/房子）见 [references/icons.md](references/icons.md)。

### 手绘架构图 / 流程图
- **标准流程图/架构骨架先用 `compose scene:"flow"`**（节点对齐、连线贴边、菱形分支、回退边绕行都是算法保证的），再用 draw 叠细节。compose 覆盖不了的自由构图才手排，此时按下面规范：
- 节点：`rrect` 圆角框；**抽象符号一律用 stencil**——数据库 `db`、服务器 `server`、外部系统 `cloud`、参与者 `actor`、子系统分组 `group`，别用方盒子代替圆柱/云。
- 分层强调用 `hatch` 排线或换色（颜色=层级语义）。大框别用 `marker` 描边——快照里笔触过粗会压到相邻框线，要加粗用 `size:2.5` 的 felt。
- 连线：有方向用 `arrow`；无方向关联用 `line`；边界/隐藏层用 `dash`。双向交互（如 SSE 推送 / PUT 回流）画两条平行斜线各配标注。
- 标注：`text` 手写风文字（节点名、箭头说明）；节点名放框内**水平+垂直居中**（见质量基线），箭头说明放线旁。
- 布局自上而下或自左而右；**间距用 px 精确算 pitch**（见质量基线），别用 norm 随手拍。norm 仍可用于首页框内按比例构图，但纵向间距必须按"norm 高度换算坑"换算成 px 验证。
- stereotype 对照表、布局/箭头/配色约定见 [references/arch-flow.md](references/arch-flow.md)。

### 手绘风格原型图
- **整页骨架先用 `compose scene:"wireframe"`**（设备框 + 内容区一次成型，标签自动贴左上角），复杂分区/组件再用 draw 叠加。手排时按下面规范：
- **先设备框再铺 UI**：移动端用 `stencil kind:"phone"`，桌面/Web 用 `stencil kind:"browser"`；复杂页面（电商首页等）建议手画 macOS Chrome 三层顶栏（红绿灯/标签/工具栏，见 prototypes.md）。
- **先列层次清单再开画**：把页面拆成层（工具条→头部→导航→首屏→楼层→页脚），每层定 y 范围，层内再套间距档位（见 prototypes.md"间距规范"），然后 px 精确排坐标。
- 卡片/组件：`rrect`；强调/选中态：`hatch` 排线；隐藏/折叠边界：`dash`。
- 文本：`text` 当 UI 标签（按钮字、标题、占位符说明）。
- **分批**：复杂页面 3 批——①骨架+顶栏（框/分隔线/设备框）②元素+icon（胶囊/图标/hatch 图区）③全部文字；每批 snapshot 自查。**重排布局时改 `/tmp` 里的 JSON 脚本 `clear` 重跑**，比逐元素 erase 快得多（前提：draw 时带语义分组）。
- 坐标用 px（画布像素），别用 norm 拍间距；norm 仅适合框内简单构图且必须按 h 坑换算。
- UI 元素配方（按钮/输入框/列表行/导航/标签栏/开关/头像）、间距档位与状态配色语义见 [references/prototypes.md](references/prototypes.md)。

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
| stencil | `{kind, x,y,w, h?, units?}` 复合符号（服务端展开成笔迹，见下） |
| icon | `{name, x,y, size?(边长px,默认28), color?}` **1:1 looseleaf 真图标**（独立元素非笔迹，见下） |
| text | `{x,y,text,size?(字号px,默认~29),color?}`（手写风文字；x,y 左上角；size 恒为 px 不参与 norm 缩放） |

**stencil kind**（手画易错的抽象符号直接用它，只产笔迹、名称自己用 text 标）：
`phone`手机框·`browser`浏览器窗（原型）；`db`数据库圆柱·`server`服务器机架(units=单元数)·`cloud`外部云·`actor`小人·`group`虚线分组边界（架构图）。`h` 缺省按 kind 标准比例自动补。

**icon 形状**（UI 图标一律用它，别用 line/polyline 手画——造型必错、质感必硬）：
`chevron-left/right`·`arrow-*`·`rotate-cw`·`lock`·`search`·`star`·`ellipsis-vertical`·`home`·`user`·`mail`…共 160 个。
`x/y` 是盒子左上角，glyph 自动按实测 bbox 中心对齐盒中心。**定位公式：y = 区域中心线 − size/2**（工具栏中心 98 → size=24 时 y=86）；同一条中心线上不同 size 的图标各自反推 y。
查全部名字：`python3 -c "import json; print(list(json.load(open('packages/cli/src/icon-bundle.json'))['icons'].keys()))"`。详见 [references/icons.md](references/icons.md)。

每个形状可覆盖 `tool`/`color`/`size`（text 只有 color）；批级默认由 draw 顶层参数给。点/线端点必须 `{x,y}` 对象（部分 LLM 网关拒绝 tuple）。

## 画笔与色板

| 画笔 | 特点 | 创作场景用法 |
| --- | --- | --- |
| `felt` 毡头笔 | 均匀墨线 | icon/框线主力 |
| `brush` 毛笔 | 压力粗细变化 | 强调线 |
| `pencil` 颗粒感 | 构造线/网格/hatch | 打稿、排线 |
| `marker` 马克笔 | 粗扁笔触 | 大面积形状轮廓 |
| `highlighter` 荧光笔 | 半透明宽帽；深色自动换黄 | 区域底色 |
| `eraser` 橡皮 | 擦除（页面用） | agent 局部修正用 `sketchpad erase`，整批才 undo |

颜色是**命名色板**（不能传 hex）：`ink` / `ink-you`(蓝) / `red` / `green` / `marker`(橙红) / `tangerine` / `hi`(黄) / `teal` / `grape` / `bubblegum`(粉)。

## 坐标系与画布

- **无限画布**：坐标空间无界（页面可滚轮平移、ctrl/⌘+滚轮缩放、中键或 Space 拖拽平移），可画出首页画框之外的内容。默认**画布像素**（原点 = 首页画框 1040×620 的左上角，y 向下）；`draw` 顶层 `"unit":"norm"` 则坐标按 0~1 归一化（**相对首页画框宽高**），**长度类字段（w/h/r/rx/ry/gap）统一按首页框宽 1040 缩放**（圆/正方形不因宽高比变形），text 字号恒为 px。首页框内构图用 norm，框外内容用 px。
- **norm 高度换算坑**：y 按 620 缩放、h 按 1040 缩放——norm 的 `h:0.1` 视觉高是 **104px**，不是 62px。想要视觉高 H px 的框，传 `h = H/1040`；纵向布局时先算好"框顶 y + H/620"得到框底 y，别拿 h 直接加。rrect/rect/hatch 都受此影响，最常把竖排布局画成框互相压线。
- 画布按 id（`YYYYMMDDHHmmss`）隔离：并发作画的多个 agent 各自 `new`，之后所有调用带 `canvas` id。
- 文档落盘 `<项目根>/.content-forge/sketchpad/<画布id>.json`（strokes + texts 一起）；snapshot PNG 落 `.content-forge/sketchpad/previews/`。
- snapshot 默认取景 = 内容包围盒 ∪ 首页画框（框内内容取景与固定画布一致），`region:{x,y,w,h}` 可显式指定区域。
- 文本元素（texts）是 agent-only：页面只渲染不编辑，undo/clear 与笔迹一起进出。

## 环境与同步机制

```bash
sketchpad ui    # 确保统一前端在线并打印画板页面地址
```

- 页面受控同步：SSE rev 去抖 + PUT 回流。直连旧入口页面会降级纯本地模式——确认走 `sketchpad ui`。
- 文字用霞鹜文楷 Lite（OFL，字体文件在 `packages/cli/fonts/`）：页面 @font-face 与 snapshot 渲染共用同一 TTF，两端一致。
- 后端长驻：改了 sketchpad 包源码后 `pkill -f canvas-backend` 让网关重拉；改了前端组件要 `pnpm --filter @content-forge/web build`。

## 常见问题

| 现象 | 处置 |
| --- | --- |
| preview 页面没显示内容 | 确认前端经 `sketchpad ui` 启动（旧入口无画板 API） |
| 笔画越界/位置不对 | 用 `unit:"norm"`（首页框内），或以 `state` 的首页框尺寸为准换算；框外内容用 px 坐标 |
| norm 模式下框画得太高/互相压线 | h 按 1040 缩放而 y 按 620：`h = 期望px/1040`（见坐标系"norm 高度换算坑"） |
| 画错了一个元素但整批 undo 会连带 | `erase '{"ids":[…]}'` 按元素删（id 见 draw 返回 / `state {"ids":true}`）；删除进撤销栈可 undo 恢复 |
| 在多块画布间切来切去省略 canvas 打错地方 | `sketchpad use '{"canvas":"<id>"}'` 切活动画布，或所有调用显式带 canvas |
| 颜色设置无效 | 只接受命名色板，hex 会被拒 |
| 多人/多 agent 同时画 | 各自 new 隔离 |
| 改了代码新形状不生效 | `pkill -f canvas-backend` 重启画板后端 |
| snapshot 里文字是巨大墨块/缺失 | 确认 text 的 size 传的是字号 px（norm 模式下也不缩放） |
