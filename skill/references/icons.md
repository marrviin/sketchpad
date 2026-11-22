# 手绘 icon · 领域知识

> 自创 icon = 在 `grid` 24×24 网格里定大形、抠细节。先铺网格画 keyshape，自查比例后再上细节，最后 undo 撤网格。

## ⭐ 用 `icon` 形状画真 looseleaf icon（1:1，推荐）

> 画板内置 looseleaf 全部 160 个真实 icon 的渲染 SVG。`icon` 形状直接注入 looseleaf 原生输出——填充形、圆角端点、颗粒质感与 looseleaf `<Icon>` 组件**完全一致**。**别用 line/polyline 手画图标**——实测手画必错造型（chevron 画成横线箭头、刷新环画成半 C）、质感必硬；路径转笔迹也拿不到填充形和颗粒。

```json
{ "shape": "icon", "name": "chevron-left", "x": 88, "y": 86, "size": 24 }
```

- `name`：`chevron-left/right`、`arrow-*`、`rotate-cw`、`lock`、`search`、`star`、`ellipsis-vertical`、`home`、`user`、`mail`、`settings-2`、`circle-check`…（共 160 个）
- `size` = 边长 px；`x/y` = **盒子左上角**；`color` 套色。
- **glyph 自动按 bbox 中心对齐盒中心**——looseleaf glyph 不满铺（各 icon bbox 不同），渲染端已按 glyph 实测中心定位，调用方只管把盒子放对。
- icon 是独立元素（非笔迹），进 undo/redo，可被语义分组 `group` 绑定、按 id/组名擦除。
- 查全部名字：`python3 -c "import json; print(list(json.load(open('packages/sketchpad/src/icon-bundle.json'))['icons'].keys()))"`

### 定位公式：盒中心 = 所在区域的中心线

**先算区域中心线，再反推 y**（x 同理）：

```
y = 区域中心线 − size/2
```

| 场景 | 区域 | 中心线 | size=24 时 y | size=16 时 y |
| --- | --- | --- | --- | --- |
| Chrome 工具栏 | 分隔线 78~118 | 98 | **86** | 90 |
| 地址栏胶囊 | y 89~108 | 98.5 | 86.5 | **90~91** |
| 列表行 | 行顶 r~r+64 | r+32 | r+20 | r+24 |

**踩过的坑**：size=24 图标放 y=90 → 盒中心 102，比工具栏中心线 98 低 4px——整排图标肉眼可见偏下。先算中心线再定 y，别顺手拍。

**不同 size 的图标在同一中心线上共存**：y 各自按 size 反推（工具栏里 size=24 的 y=86、size=16 的锁 y=90，两者 glyph 中心都在 98）。

## 自创 icon 的原则（非库内 icon 才手画）

- **keyshape 先行**：每个 icon 先定外轮廓的主形（圆 / 方 / 三角 / 弧丘），占中央 ~2/3。第一批只画主形 → snapshot 看比例 → 第二批抠内部。
- **光学对齐，不是数学对齐**：视觉重心略高于几何中心；圆形（镜头、铃铛）要比方形稍大一点才"看着一样大"。
- **线宽统一**：全 icon 用同一 `size`（felt medium）。粗细忽变是 icon 显廉价的头号原因。
- **负空间**：内部镂空要够大，缩到 16px 还能认得出。别塞太多细节。
- **描边 vs 实心**：一套 icon 统一描边风（felt 线框）或实心风（hatch/粗填），别混。手绘图默认描边。

## 高频 icon 配方（相对包围盒 {x,y,S}，S=边长 px）

- **放大镜**：`ellipse` cx=x+S*0.42 cy=y+S*0.42 rx=S*0.3 ry=S*0.3（镜片）；柄 `line` 从 [x+S*0.62, y+S*0.62] 到 [x+S*0.85, y+S*0.85]。
- **齿轮**：外 `ellipse` cx,cy=中心 rx=S*0.32；中心孔 `ellipse` rx=S*0.12；6~8 根辐条 `line` 从近心到外缘、径向均分（每 45° 一根）。
- **用户**：头 `ellipse` cx=x+S*0.5 cy=y+S*0.3 rx=S*0.16；肩 `spline` 过 [x+S*0.2,y+S*0.85]→[x+S*0.3,y+S*0.6]→[x+S*0.7,y+S*0.6]→[x+S*0.8,y+S*0.85]（拱形肩）。
- **爱心**：两瓣 `arc`——左瓣 cx=x+S*0.37 cy=y+S*0.4 startDeg=90 endDeg=270；右瓣 cx=x+S*0.63 cy=y+S*0.4 startDeg=-90 endDeg=90；底部尖用两条 `line` 从两瓣底汇到 [x+S*0.5,y+S*0.9]。
- **铃铛**：帽 `spline` 弧丘盖过顶部；下口一条 `line`；底下 `ellipse` 小锤 rx=S*0.06。
- **文件夹**：后板 `rect`；前板 `rrect` 下半；左上折角用两条 `line` 折出 tab。
- **房子**：墙 `rect` 下半；屋顶 `line` 人字形到顶点 [x+S*0.5, y+S*0.15]；门小 `rect` 居中。
- **星形**：直接 `star` 原语 cx,cy,rOuter=S*0.45,rInner=S*0.2,points=5。

## 常见错法

- **手画 UI 图标**（工具栏/按钮/列表小图标）→ 造型错、质感硬。实测三条路全失败：凭印象手画（chevron 画成横线箭头）、描 Lucide 配方（和 looseleaf 造型不同）、把 looseleaf 路径转笔迹（丢填充形/抖动/颗粒，粗了糊块细了没质感）。**一律 `icon` 形状**，只有库外图形才手画。
- **所有图标同一个 y** → 不同 size 盒中心不同，整排偏移。先算区域中心线，各自 `y = 中心线 − size/2`。
- **icon y 拍脑袋放** → glyph 中心≠盒中心时视觉偏移。渲染端已按 glyph bbox 中心自动对齐盒中心，调用方只需把盒子放对。
- 第一批就抠细节 → 比例歪了全废。**永远先主形、再细节，两批分开 draw。**
- 不用网格直接拍坐标 → 偏移明显。icon 小，先 `grid` 铺 24 格。
- 有机轮廓（云、火、叶、动物）手拧 bezier → 用 `spline` 过点。
- 忘了撤网格 → 画完 `undo` 掉，或 `erase` 网格 id。

## 附：looseleaf icon 原始库位置（排查用）

> 画板内置的 `icon-points`/渲染 SVG 预生成自 looseleaf 原仓库 `~/github/looseleaf/src/lib/ink/art/icons/`（160 个 ArtDef，24×24 网格 SVG 路径）。icon 形状缺某个图标/渲染异常时去那里查定义；重新导出脚本在 `~/github/looseleaf/scripts/icon-bundle.mts`。
