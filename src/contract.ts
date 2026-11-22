/**
 * 画板笔迹契约（CLI / backend / 页面三方共用）：镜像 packages/web/src/lib/ink/recipes/sketchpad-ink.ts。
 * looseleaf 渲染端是视觉行为的权威（笔刷质感、颜色变量 --ll-*）；本文件只镜像数据形状与
 * 荧光笔变色规则，修改时两侧需同步。画板文档（<项目根>/.content-forge/sketchpad/sketch.json）也按此契约落盘。
 */
import { z } from "zod";

/* ===== 画笔 ===== */

export const DRAW_TOOLS = ["felt", "brush", "pencil", "marker", "highlighter"] as const;
export const SKETCH_TOOLS = [...DRAW_TOOLS, "eraser"] as const;
export type DrawTool = (typeof DRAW_TOOLS)[number];
export type SketchTool = (typeof SKETCH_TOOLS)[number];

export const TOOL_LABEL: Record<SketchTool, string> = {
  felt: "毡头笔",
  brush: "毛笔",
  pencil: "铅笔",
  marker: "马克笔",
  highlighter: "荧光笔",
  eraser: "橡皮",
};

/* ===== 命名色板（具体色值由页面 --ll-* CSS 变量解析） ===== */

export const SKETCH_COLORS = [
  "ink",
  "ink-you",
  "red",
  "green",
  "marker",
  "tangerine",
  "hi",
  "teal",
  "grape",
  "bubblegum",
] as const;
export type SketchColor = (typeof SKETCH_COLORS)[number];

export const COLOR_LABEL: Record<SketchColor, string> = {
  ink: "墨黑",
  "ink-you": "蓝",
  red: "红",
  green: "绿",
  marker: "赭红",
  tangerine: "橙",
  hi: "黄",
  teal: "青",
  grape: "紫",
  bubblegum: "粉",
};

/** 荧光笔 + 深色墨几乎不可见（半透明宽帽叠色）：自动换成 hi 黄，与页面组件同规则 */
export const DARK_INKS: ReadonlySet<SketchColor> = new Set<SketchColor>(["ink", "ink-you", "red", "green"]);

export function autoColor(tool: SketchTool, color: SketchColor): SketchColor {
  return tool === "highlighter" && DARK_INKS.has(color) ? "hi" : color;
}

/* ===== 粗细（乘数：实际线宽 = 画笔基础宽 × 乘数） ===== */

export const SKETCH_SIZES = { fine: 0.6, medium: 1, bold: 1.9 } as const;
export type SketchSizeName = keyof typeof SKETCH_SIZES;

export const sizeSchema = z
  .union([z.enum(["fine", "medium", "bold"]), z.number().min(0.2).max(6)])
  .transform((v) => (typeof v === "number" ? v : SKETCH_SIZES[v]));

/* ===== 笔迹数据 ===== */

/** [x, y] 或 [x, y, pressure]（压力参与毛笔渲染，坐标为画布像素坐标，y 向下） */
export const pointSchema = z.union([
  z.tuple([z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number()]),
]);

export const strokeSchema = z.object({
  id: z.string().min(1),
  tool: z.enum(DRAW_TOOLS),
  color: z.enum(SKETCH_COLORS),
  size: z.number().min(0.2).max(6),
  pts: z.array(pointSchema).min(1).max(20000),
});

export type SketchPoint = z.infer<typeof pointSchema>;

export interface SketchStroke {
  id: string;
  tool: DrawTool;
  color: SketchColor;
  size: number;
  pts: SketchPoint[];
}

/* ===== 文本元素（手写风标注，页面/snapshot 用同一手写字体渲染） ===== */

export interface SketchText {
  id: string;
  /** 左上角定位（渲染端统一 y + size*0.78 近似基线，两侧一致） */
  x: number;
  y: number;
  /** 字号 px */
  size: number;
  color: SketchColor;
  text: string;
}

/* ===== icon 元素（1:1 looseleaf icon，直接渲染预导出 SVG，非笔迹） ===== */
export interface SketchIcon {
  id: string;
  /** looseleaf icon 库名（chevron-left / search / lock …） */
  name: string;
  /** 左上角定位 */
  x: number;
  y: number;
  /** 边长 px（24 网格缩放） */
  size: number;
  color: SketchColor;
}

export const textSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  size: z.number().min(8).max(200),
  color: z.enum(SKETCH_COLORS),
  text: z.string().min(1).max(200),
});

/* ===== 命名分组（语义绑定：给一批形状起名，按名擦/按名改） =====
 * 前端不感知——只渲染 strokes/texts；groups 是后端的修改索引。 */

export interface ElementGroup {
  /** 语义名，如 "数据库" / "登录按钮" / "主标题" */
  name: string;
  strokeIds: string[];
  textIds: string[];
  /** icon 元素 id（1:1 looseleaf icon 也是可擦成员） */
  iconIds?: string[];
}

/* ===== 画板文档（落盘格式 sketch.json） ===== */

export interface CanvasDoc {
  version: 1;
  /** 单调递增修订号：每次变更 +1，页面经 SSE 比对决定是否拉取 */
  rev: number;
  width: number;
  height: number;
  /** 新笔迹的默认画笔/颜色/粗细（页面工具栏受控值；tool 允许 eraser，与页面工具栏一致） */
  tool: SketchTool;
  color: SketchColor;
  size: number;
  strokes: SketchStroke[];
  /** 手写风文本元素（agent-only，页面暂不提供编辑入口） */
  texts: SketchText[];
  /** 1:1 looseleaf icon 元素（预导出 SVG，非笔迹） */
  icons: SketchIcon[];
  /** 命名分组（语义绑定：按名擦/按名改）；前端不感知 */
  groups: ElementGroup[];
  updatedAt: string;
}

/* ===== 形状输入（sketchpad_draw 的 shapes 数组元素） =====
 * 高层原语（arrow/arc/star/polygon/rrect）由 document.ts 的 sampleShape 编译为普通笔迹，
 * 页面只看到 strokes——契约两侧仍只镜像数据形状，页面无需感知新形状。 */

/* ===== stencil 复合符号（服务端展开成原语笔迹，前端无感） =====
 * 只收"自由手画几乎必错"的抽象符号：设备框/数据库/服务器/云/小人/分组边界。
 * stencil 只产笔迹，不产 label——文字标注由 agent 随后单独发 text。 */
export const STENCIL_KINDS = ["phone", "browser", "db", "server", "cloud", "actor", "group"] as const;
export type StencilKind = (typeof STENCIL_KINDS)[number];

/** 各 stencil 的标准高宽比（h = w × aspect；h 显式传则覆盖） */
export const STENCIL_ASPECT: Record<StencilKind, number> = {
  phone: 2.05, // 9:19 机身
  browser: 0.62,
  db: 0.72,
  server: 1.5,
  cloud: 0.55,
  actor: 1.7,
  group: 0.8,
};

const Pt = z.tuple([z.number(), z.number()]);

/** 单形状覆盖项（缺省回落到文档默认 tool/color/size） */
const shapeOverrides = {
  tool: z.enum(DRAW_TOOLS).optional(),
  color: z.enum(SKETCH_COLORS).optional(),
  size: sizeSchema.optional(),
};

/* ===== icon 形状（直接用 looseleaf 真实 icon，不是手画） =====
 * name 是 looseleaf icon 库的名字（chevron-left / rotate-cw / lock / search …），
 * 后端调 drawSkeleton 渲染出真实手绘 SVG，再把路径解析成笔迹点列画进画板。 */
export const iconShapeSchema = z.object({
  shape: z.literal("icon"),
  name: z.string().min(1).max(40),
  x: z.number(),
  y: z.number(),
  /** 边长 px（icon 是正方形）；缺省 28 */
  size: z.number().min(8).max(120).optional(),
  tool: z.enum(DRAW_TOOLS).optional(),
  color: z.enum(SKETCH_COLORS).optional(),
});

export const shapeSchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("point"), x: z.number(), y: z.number(), ...shapeOverrides }),
  z.object({ shape: z.literal("line"), from: Pt, to: Pt, ...shapeOverrides }),
  z.object({ shape: z.literal("polyline"), points: z.array(Pt).min(2).max(4000), ...shapeOverrides }),
  z.object({ shape: z.literal("rect"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), ...shapeOverrides }),
  z.object({ shape: z.literal("rrect"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), r: z.number().min(0), ...shapeOverrides }),
  z.object({ shape: z.literal("ellipse"), cx: z.number(), cy: z.number(), rx: z.number(), ry: z.number(), ...shapeOverrides }),
  z.object({ shape: z.literal("arc"), cx: z.number(), cy: z.number(), rx: z.number(), ry: z.number(), startDeg: z.number(), endDeg: z.number(), ...shapeOverrides }),
  z.object({ shape: z.literal("polygon"), cx: z.number(), cy: z.number(), r: z.number(), sides: z.number().int().min(3).max(30), rotDeg: z.number().optional(), ...shapeOverrides }),
  z.object({ shape: z.literal("star"), cx: z.number(), cy: z.number(), rOuter: z.number(), rInner: z.number(), points: z.number().int().min(3).max(20), rotDeg: z.number().optional(), ...shapeOverrides }),
  z.object({ shape: z.literal("bezier"), start: Pt, cp1: Pt, cp2: Pt, end: Pt, ...shapeOverrides }),
  z.object({ shape: z.literal("arrow"), from: Pt, to: Pt, head: z.number().optional(), ...shapeOverrides }),
  /* 虚线段（原型图边界/隐藏线）：按 size 缩放的分段模式，产出多笔 */
  z.object({ shape: z.literal("dash"), from: Pt, to: Pt, ...shapeOverrides }),
  /* 过点平滑曲线（Catmull-Rom）：画有机形状（云/火焰/叶子）的主力 */
  z.object({ shape: z.literal("spline"), points: z.array(Pt).min(3).max(500), ...shapeOverrides }),
  /* 区域排线填充（手绘"涂阴影"）：矩形区域 + 角度线族，产出多笔 */
  z.object({ shape: z.literal("hatch"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), angleDeg: z.number().optional(), gap: z.number().optional(), ...shapeOverrides }),
  /* 手写风文本标注：size 是字号 px（不是笔迹乘数），产出 texts 元素 */
  z.object({ shape: z.literal("text"), x: z.number(), y: z.number(), text: z.string().min(1).max(200), size: z.number().min(8).max(200).optional(), color: z.enum(SKETCH_COLORS).optional(), tool: z.enum(SKETCH_TOOLS).optional() }),
  /* 复合符号 stencil：服务端按 kind 展开成一组原语笔迹（只产笔迹，label 自己用 text 标）。
   * h 缺省 = w × STENCIL_ASPECT[kind]；units 仅 server 用（机架单元数，默认 3）。 */
  z.object({
    shape: z.literal("stencil"),
    kind: z.enum(STENCIL_KINDS),
    x: z.number(), y: z.number(), w: z.number(),
    h: z.number().optional(),
    units: z.number().int().min(1).max(8).optional(),
    ...shapeOverrides,
  }),
  /* icon：直接用 looseleaf 真实 icon（name 见 icons 库），后端渲染成笔迹。x/y 是 icon 左上角 */
  iconShapeSchema,
]);

/** 角度单位为度：0° 指向 +x（右），正方向为顺时针（屏幕坐标系 y 向下的直观方向） */
export type ShapeSpec = z.infer<typeof shapeSchema>;
