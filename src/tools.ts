/**
 * sketchpad 工具注册表：CLI（cli.ts 的 tool / state / draw 等命令）与 web 网关共用
 * 同一套 {inputSchema, handler}。handler 经 sketchpadApi 调画板后端，
 * 状态事实源在后端，CLI 只是薄客户端。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { COLOR_LABEL, DRAW_TOOLS, SKETCH_COLORS, SKETCH_SIZES, SKETCH_TOOLS, STENCIL_KINDS, TOOL_LABEL, type SketchColor, type SketchStroke, type SketchText } from "./contract.js";
import { renderDocSvg, resolveFontFile, FONT_FAMILY, TOOL_STYLE } from "./render.js";
import { projectRoot } from "./paths.js";
import { sketchpadApi, sketchpadUrl, ensureSketchpadRoute } from "./route.js";

/** 快照渲染只需要文档形状（与 backend 的 CanvasDoc 同形），避免拉入完整文档模块 */
type CanvasDocShape = { rev: number; width: number; height: number; strokes: SketchStroke[]; texts: SketchText[]; icons?: { id: string; name: string; x: number; y: number; size: number; color: SketchColor }[] };

/** 内容包围盒 ∪ 首页画框，四周 pad——首页框内内容取景与固定画布一致，框外内容自动扩进来 */
function contentBBox(doc: CanvasDocShape): { x0: number; y0: number; w: number; h: number } {
  let x0 = 0;
  let y0 = 0;
  let x1 = doc.width;
  let y1 = doc.height;
  for (const s of doc.strokes) {
    const pad = (TOOL_STYLE[s.tool]?.w ?? TOOL_STYLE.felt.w) * s.size / 2 + 4;
    for (const p of s.pts) {
      x0 = Math.min(x0, p[0] - pad);
      y0 = Math.min(y0, p[1] - pad);
      x1 = Math.max(x1, p[0] + pad);
      y1 = Math.max(y1, p[1] + pad);
    }
  }
  for (const t of doc.texts) {
    // CJK ≈ 1em/字，混排偏短估——pad 兜底
    x0 = Math.min(x0, t.x);
    y0 = Math.min(y0, t.y);
    x1 = Math.max(x1, t.x + t.text.length * t.size * 1.05);
    y1 = Math.max(y1, t.y + t.size);
  }
  for (const ic of doc.icons ?? []) {
    x0 = Math.min(x0, ic.x);
    y0 = Math.min(y0, ic.y);
    x1 = Math.max(x1, ic.x + ic.size);
    y1 = Math.max(y1, ic.y + ic.size);
  }
  const PAD = 24;
  return {
    x0: Math.round(x0 - PAD),
    y0: Math.round(y0 - PAD),
    w: Math.max(64, Math.round(x1 - x0 + 2 * PAD)),
    h: Math.max(64, Math.round(y1 - y0 + 2 * PAD)),
  };
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Raw per-field zod shape（CLI 与 web 网关同形） */
  inputSchema: Record<string, z.ZodType>;
  // 刻意宽松：handler 由具体工具具化签名，此处无法收窄
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<ToolResult>;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

/** 2D 点：必须用 {x,y} 对象而非 [x,y] tuple——部分 Anthropic 兼容网关（如 GLM）拒绝
 *  tuple 形式的 "items":[{...},{...}]，会让携带该 schema 的整个请求 400。backend 契约仍是 tuple，handler 负责转换。 */
const Pt = z.object({ x: z.number(), y: z.number() }).describe("画布像素坐标（y 向下）");

const ptTuple = (p: { x: number; y: number }): [number, number] => [p.x, p.y];

/** 粗细入参：LLM 常把数字传成字符串（"2"），先归一化再走契约 schema。
 *  工厂函数返回全新实例——复用实例（含共享的 sizeSchema）会让 zod-to-json-schema 生成 $ref，部分严格客户端不解析。 */
const makeSizeInput = () =>
  z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
      z
        .union([z.enum(["fine", "medium", "bold"]), z.number().min(0.2).max(6)])
        .transform((v) => (typeof v === "number" ? v : SKETCH_SIZES[v])),
    )
    .describe("粗细：fine/medium/bold 或数值乘数（0.2~6，1 为标准）");

/** 画布 id 入参（YYYYMMDDHHmmss）：省略 = 活动画布；每个工具都返回实际命中的画布 id */
const makeCanvasInput = () =>
  z
    .string()
    .regex(/^\d{14}$/)
    .optional()
    .describe(
      "画布 id（YYYYMMDDHHmmss，get_state / new_canvas 返回；页面 URL ?c= 参数同源）。" +
        "省略 = 活动画布。并发作画的多个 agent 应各自绑定不同画布，笔迹互不影响。",
    );

/** 拼 API 路径：带 canvas 走 /canvases/<id>/<op>，省略走活动画布的兼容路由 /<op> */
const canvasPath = (canvas: string | undefined, op: string): string =>
  canvas ? `/canvases/${canvas}/${op}` : `/${op}`;

const toolDesc = SKETCH_TOOLS.map((t) => `${t}=${TOOL_LABEL[t]}`).join("，");
const colorDesc = SKETCH_COLORS.map((c) => `${c}=${COLOR_LABEL[c]}`).join("，");

const ShapeList = z
  .array(
    z.discriminatedUnion("shape", [
      z.object({ shape: z.literal("point"), x: z.number(), y: z.number(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("line"), from: Pt, to: Pt, tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("polyline"), points: z.array(Pt).min(2).max(4000), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("rect"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("rrect"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), r: z.number().min(0), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("ellipse"), cx: z.number(), cy: z.number(), rx: z.number(), ry: z.number(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("arc"), cx: z.number(), cy: z.number(), rx: z.number(), ry: z.number(), startDeg: z.number(), endDeg: z.number(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("polygon"), cx: z.number(), cy: z.number(), r: z.number(), sides: z.number().int().min(3).max(30), rotDeg: z.number().optional(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("star"), cx: z.number(), cy: z.number(), rOuter: z.number(), rInner: z.number(), points: z.number().int().min(3).max(20), rotDeg: z.number().optional(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("bezier"), start: Pt, cp1: Pt, cp2: Pt, end: Pt, tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("arrow"), from: Pt, to: Pt, head: z.number().optional(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("dash"), from: Pt, to: Pt, tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("spline"), points: z.array(Pt).min(3).max(500), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("hatch"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), angleDeg: z.number().optional(), gap: z.number().optional(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      z.object({ shape: z.literal("text"), x: z.number(), y: z.number(), text: z.string().min(1).max(200), size: z.number().min(8).max(200).optional(), color: z.enum(SKETCH_COLORS).optional(), tool: z.enum(SKETCH_TOOLS).optional() }),
      // 复合符号 stencil：服务端按 kind 展开成一组笔迹（只产笔迹，label 自己用 text 标）
      z.object({ shape: z.literal("stencil"), kind: z.enum(STENCIL_KINDS), x: z.number(), y: z.number(), w: z.number(), h: z.number().optional(), units: z.number().int().min(1).max(8).optional(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional(), size: makeSizeInput().optional() }),
      // icon：直接用 looseleaf 真实 icon（name 见 looseleaf icons 库），后端渲染成笔迹
      z.object({ shape: z.literal("icon"), name: z.string().min(1).max(40), x: z.number(), y: z.number(), size: z.number().min(8).max(120).optional(), tool: z.enum(DRAW_TOOLS).optional(), color: z.enum(SKETCH_COLORS).optional() }),
    ]),
  )
  .min(1)
  .max(200)
  .describe("形状数组（一次调用可画多笔）");
type ShapeInput = z.infer<typeof ShapeList>[number];

export function sketchpadToolDefs(): ToolDef[] {
  return [
    {
      name: "sketchpad_get_state",
      title: "查看画板状态",
      description:
        "查看画板当前状态：画布 id 与尺寸、当前默认画笔/颜色/粗细、笔迹数、修订号、在线页面数、历史画布列表与页面 URL。" +
        "full=true 时附带完整笔迹 JSON（画前规划构图或分析已有内容时用）。",
      inputSchema: {
        canvas: makeCanvasInput(),
        full: z.boolean().optional().describe("是否附带完整笔迹 JSON"),
        ids: z.boolean().optional().describe("是否附带元素清单（id · 类型 · 摘要，配合 sketchpad_erase 局部修正）"),
      },
      handler: async ({ canvas, full, ids }) => {
        try {
          const list = await sketchpadApi<{ canvases: { id: string; updatedAt: string; strokes: number }[]; active: string }>(
            "/canvases",
          );
          const id = canvas ?? list.active;
          const { doc, clients } = await sketchpadApi<{
            doc: Record<string, unknown>;
            clients: number;
          }>(canvasPath(id, "doc"));
          const strokes = (doc.strokes as unknown[]).length;
          const lines = [
            `画布 ${id}（首页画框 ${doc.width}×${doc.height}（norm 相对它）· rev ${doc.rev} · ${strokes} 笔迹）`,
            `当前默认：${TOOL_LABEL[doc.tool as never]}（${doc.tool}）/ ${COLOR_LABEL[doc.color as SketchColor]}（${doc.color}）/ 粗细 ${doc.size}`,
            `在线页面：${clients} 个`,
            `历史画布（最近更新在前，共 ${list.canvases.length} 块）：`,
            ...list.canvases.slice(0, 8).map((c) => `  ${c.id}  ${c.strokes} 笔迹${c.id === id ? "（当前）" : ""}`),
            list.canvases.length > 8 ? `  … 共 ${list.canvases.length} 块` : "",
          ].filter(Boolean);
          if (full) lines.push("", JSON.stringify(doc.strokes, null, 2));
          if (ids) {
            lines.push("", "元素清单（id · 类型 · 摘要；配合 sketchpad_erase 做局部修正）：");
            for (const t of doc.texts as SketchText[])
              lines.push(`  ${t.id} → text "${t.text.slice(0, 30)}" @${t.x},${t.y}`);
            for (const ic of (doc.icons ?? []) as { id: string; name: string; x: number; y: number; size: number }[])
              lines.push(`  ${ic.id} → icon "${ic.name}" @${ic.x},${ic.y} size=${ic.size}`);
            for (const s of doc.strokes as SketchStroke[])
              lines.push(`  ${s.id} → ${s.tool}/${s.color} ×${s.pts.length}点 @${Math.round(s.pts[0]?.[0] ?? 0)},${Math.round(s.pts[0]?.[1] ?? 0)}`);
            const groups = (doc.groups ?? []) as { name: string; strokeIds: string[]; textIds: string[]; iconIds?: string[]; order?: number }[];
            if (groups.length) {
              lines.push("", "语义分组（按名擦/按名改：sketchpad erase {name}；阶段 = 叙事层级，回放按它排序）：");
              for (const g of groups)
                lines.push(`  「${g.name}」${g.strokeIds.length} 笔迹 + ${g.textIds.length} 文本${g.iconIds?.length ? ` + ${g.iconIds.length} icon` : ""} → 阶段 ${g.order ?? "—"}`);
            }
          }
          lines.push("", "并发作画请先 sketchpad_new_canvas 各自建画布，之后所有工具带上 canvas id。");
          return textResult(lines.join("\n"));
        } catch (e) {
          return textResult(`查看失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_new_canvas",
      title: "新建画布",
      description:
        "新建一块空白画布（id 为创建时刻 YYYYMMDDHHmmss）并把它设为活动画布，返回 id 与页面 URL。" +
        "并发作画时每个 agent 先各建一块，之后所有工具带上返回的 canvas id，笔迹互不影响。",
      inputSchema: {},
      handler: async () => {
        try {
          const r = await sketchpadApi<{ id: string; doc: { width: number; height: number } }>("/canvases", {
            method: "POST",
          });
          const pv = await ensureSketchpadRoute();
          return textResult(
            `新画布已创建：${r.id}（画布 ${r.doc.width}×${r.doc.height}）。\n` +
              `之后该任务的所有 sketchpad_* 调用都带上 canvas="${r.id}"；\n` +
              `页面: ${sketchpadUrl(pv)}?c=${r.id}`,
          );
        } catch (e) {
          return textResult(`新建画布失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_set_brush",
      title: "选择画笔",
      description:
        "设置画板的默认画笔/颜色/粗细，之后的 sketchpad_draw 不带覆盖项时按此渲染，页面工具栏同步高亮。" +
        `tool: ${toolDesc}。color: ${colorDesc}。size: 粗细乘数 fine/medium/bold 或数值（0.2~6，1 为标准）。` +
        "荧光笔配深色会自动换成 hi 黄（渲染需要，与页面一致）。",
      inputSchema: {
        canvas: makeCanvasInput(),
        tool: z.enum(SKETCH_TOOLS).optional().describe(`画笔：${toolDesc}（不改画笔时省略）`),
        color: z.enum(SKETCH_COLORS).optional().describe(`颜色：${colorDesc}`),
        size: makeSizeInput().optional(),
      },
      handler: async ({ canvas, tool, color, size }) => {
        if (tool === undefined && color === undefined && size === undefined) {
          return textResult("设置失败：tool / color / size 至少给一项。", true);
        }
        try {
          const r = await sketchpadApi<{ id: string; rev: number; tool: string; color: string; size: number }>(canvasPath(canvas, "prefs"), {
            method: "POST",
            body: JSON.stringify({ tool, color, size }),
          });
          return textResult(
            `画布 ${r.id} 的画笔已设为 ${TOOL_LABEL[r.tool as never]}（${r.tool}）/ ${COLOR_LABEL[r.color as SketchColor]}（${r.color}）/ 粗细 ${r.size}（rev ${r.rev}）。`,
          );
        } catch (e) {
          return textResult(`设置失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_draw",
      title: "绘制形状",
      description:
        "在画板上批量绘制形状/文本并实时渲染到页面。每个形状支持覆盖 tool/color/size（缺省用画板当前默认）。\n" +
        "坐标系：画布像素坐标，空间无界（可画出首页画框之外）；原点 = 首页画框（1040×620）左上角，y 向下。\n" +
        "顶层 unit:\"norm\" 可把本批全部坐标按 0~1 归一化（相对首页画框宽高；w/h/r/rx/ry/gap/text 字号等长度统一按宽同比例缩放）——画首页框内的内容强烈建议用它，按比例思考比算像素准；画框外内容用 px。\n" +
        "形状：point {x,y}；line {from,to}；polyline {points:[…]}；rect {x,y,w,h}；rrect 圆角矩形 {x,y,w,h,r}；\n" +
        "ellipse {cx,cy,rx,ry}；arc 弧 {cx,cy,rx,ry,startDeg,endDeg}（角度 0°=向右，正方向顺时针）；\n" +
        "polygon 正多边形 {cx,cy,r,sides,rotDeg?}（默认顶点朝上）；star 星形 {cx,cy,rOuter,rInner,points,rotDeg?}；\n" +
        "bezier {start,cp1,cp2,end}；spline 过点平滑曲线 {points:[…]}（有机形状主力，比手拧 bezier 好画）；\n" +
        "arrow 箭头 {from,to,head?}（三笔：主体线+两条头部短线）；dash 虚线 {from,to}（多笔分段）；\n" +
        "hatch 区域排线填充 {x,y,w,h,angleDeg?,gap?}（手绘涂阴影，多笔）；\n" +
        "text 手写风文本 {x,y,text,size?(字号px,默认画布宽 2.8%),color?}（x,y 是文字左上角）。\n" +
        "自由曲线优先 spline，精确单段曲线用 bezier。\n" +
        "stencil 复合符号 {shape:\"stencil\", kind, x,y,w, h?, units?}：服务端展开成一组笔迹，手画易错的抽象符号直接用它——" +
        "kind: phone=手机框(原型) / browser=浏览器窗(原型) / db=数据库圆柱(架构) / server=服务器机架(架构，units=机架单元数) / " +
        "cloud=外部系统云 / actor=小人(用例图) / group=虚线分组边界(子系统)。h 缺省按 kind 标准比例自动补；stencil 只产笔迹，名称标注随后单独发 text。",
      inputSchema: {
        shapes: ShapeList,
        unit: z.enum(["px", "norm"]).optional().describe("坐标单位：px = 画布像素（默认）；norm = 0~1 归一化相对画布宽高"),
        tool: z.enum(DRAW_TOOLS).optional().describe("本批形状的默认画笔（覆盖画板当前默认）"),
        color: z.enum(SKETCH_COLORS).optional().describe("本批形状的默认颜色"),
        size: makeSizeInput().optional().describe("本批形状的默认粗细"),
        group: z.string().min(1).max(40).optional().describe("语义分组名：这批形状归入该组，以后可用 erase {name} 整组擦掉重画。如 \"数据库\" \"登录按钮\" \"主标题\""),
        order: z.number().int().min(1).max(999).optional().describe("叙事层级（需与 group 同时给）：1=画布/设备框 2=骨架分区 3=主内容/用户动线 4=次级内容 5=标注。实际绘制顺序也应按层级推进，回放按此排序"),
        canvas: makeCanvasInput(),
      },
      handler: async ({ shapes, unit, tool, color, size, group, order, canvas }) => {
        try {
          // 调用层点为 {x,y} 对象（网关兼容），backend 契约是 [x,y] tuple——这里转回
          const backendShapes = shapes.map((s: ShapeInput) => {
            switch (s.shape) {
              case "line":
                return { ...s, from: ptTuple(s.from), to: ptTuple(s.to) };
              case "polyline":
                return { ...s, points: s.points.map(ptTuple) };
              case "bezier":
                return { ...s, start: ptTuple(s.start), cp1: ptTuple(s.cp1), cp2: ptTuple(s.cp2), end: ptTuple(s.end) };
              case "arrow":
              case "dash":
                return { ...s, from: ptTuple(s.from), to: ptTuple(s.to) };
              case "spline":
                return { ...s, points: s.points.map(ptTuple) };
              default:
                return s;
            }
          });
          const r = await sketchpadApi<{ id: string; rev: number; added: number; texts: number; icons: number; strokes: number; clamped: number; strokeIds: string[]; textIds: string[]; iconIds: string[] }>(canvasPath(canvas, "draw"), {
            method: "POST",
            body: JSON.stringify({ shapes: backendShapes, unit, tool, color, size, group, order }),
          });
          const warn = r.clamped > 0 ? `（${r.clamped} 个点越界已钳回画布边缘）` : "";
          const tinfo = r.texts ? `，其中 ${r.texts} 条文本` : "";
          const iinfo = r.icons ? `、${r.icons} 个 looseleaf icon` : "";
          const allIds = [...r.textIds, ...r.iconIds, ...r.strokeIds];
          const idHint = allIds.length === 0
            ? ""
            : allIds.length <= 12
              ? ` 本批元素 id：${allIds.join(" ")}（画错可 sketchpad_erase 按 id 删）。`
              : ` 本批 ${allIds.length} 个元素（清单用 sketchpad_get_state ids=true 查，画错可 sketchpad_erase 按 id 删）。`;
          return textResult(
            `画布 ${r.id} 已落笔 ${r.added}${tinfo}${iinfo}${warn}，现有 ${r.strokes} 笔迹。${idHint}用 sketchpad_snapshot 渲染 PNG 自查画面。`,
          );
        } catch (e) {
          return textResult(`绘制失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_grid",
      title: "铺构造网格",
      description:
        "在画布（或指定区域）铺浅色铅笔构造网格，作为手绘 icon 的定位参照（24×24 是 icon 设计的标准网格思维）。" +
        "画完 icon 后用 sketchpad_undo 撤掉网格，或保留当构图辅助。区域默认整块画布。",
      inputSchema: {
        canvas: makeCanvasInput(),
        x: z.number().optional().describe("区域左上 x（norm 单位 0~1，默认 0）"),
        y: z.number().optional().describe("区域左上 y（norm 单位 0~1，默认 0）"),
        w: z.number().optional().describe("区域宽（norm 单位，默认 1）"),
        h: z.number().optional().describe("区域高（norm 单位，默认 1）"),
        cols: z.number().int().min(2).max(64).optional().describe("纵向列数（默认 24）"),
        rows: z.number().int().min(2).max(64).optional().describe("横向行数（默认 24）"),
      },
      handler: async ({ canvas, x = 0, y = 0, w = 1, h = 1, cols = 24, rows = 24 }) => {
        try {
          const doc = await sketchpadApi<{ doc: { width: number; height: number } }>(canvasPath(canvas, "doc"));
          const W = doc.doc.width, H = doc.doc.height;
          const x0 = x * W, y0 = y * H, x1 = (x + w) * W, y1 = (y + h) * H;
          const line = (ax: number, ay: number, bx: number, by: number) => ({
            tool: "pencil" as const,
            color: "ink" as const,
            size: 0.4,
            pts: [
              [ax, ay] as [number, number],
              [bx, by] as [number, number],
            ],
          });
          const strokes = [] as ReturnType<typeof line>[];
          for (let i = 0; i <= cols; i++) {
            const gx = x0 + ((x1 - x0) * i) / cols;
            strokes.push(line(gx, y0, gx, y1));
          }
          for (let j = 0; j <= rows; j++) {
            const gy = y0 + ((y1 - y0) * j) / rows;
            strokes.push(line(x0, gy, x1, gy));
          }
          const r = await sketchpadApi<{ id: string; rev: number; added: number }>(canvasPath(canvas, "stamp"), {
            method: "POST",
            body: JSON.stringify({ strokes }),
          });
          return textResult(`画布 ${r.id} 已铺 ${cols}×${rows} 构造网格（区域 ${x0.toFixed(0)},${y0.toFixed(0)} – ${x1.toFixed(0)},${y1.toFixed(0)}，浅铅笔）。用 sketchpad_snapshot 查看，画完可用 sketchpad_undo 撤掉。`);
        } catch (e) {
          return textResult(`铺网格失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_snapshot",
      title: "渲染画布快照",
      description:
        "把画布当前内容渲染成 PNG 落盘并返回文件路径：用 Read 工具查看该图片即可自查画面" +
        "（视觉权威的 looseleaf 笔刷质感在这里是轻量近似——判断构图/形状/颜色/位置足够）。\n" +
        "默认取景：全部内容的包围盒 ∪ 首页画框（1040×620），四周留 24px——内容都在首页框内时取景与固定画布一致，" +
        "有框外内容时自动扩进来；region 可显式指定渲染区域（首页画框像素坐标，可越出框）。\n" +
        "标准自查回路：画一小批 → snapshot → Read 看图 → 不像就 undo 撤掉重画，像了再画下一批。",
      inputSchema: {
        canvas: makeCanvasInput(),
        scale: z.number().min(0.2).max(4).optional().describe("PNG 输出宽度缩放倍率（默认 1，取景区原尺寸）"),
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            w: z.number().min(32),
            h: z.number().min(32),
          })
          .optional()
          .describe("渲染区域（世界 px：x/y 左上角 + w/h），默认自动按内容包围盒 ∪ 首页画框取景"),
      },
      handler: async ({ canvas, scale, region }) => {
        try {
          const { Resvg } = await import("@resvg/resvg-js");
          const { doc, id } = await sketchpadApi<{ id: string; doc: CanvasDocShape }>(canvasPath(canvas, "doc"));
          if (!doc.strokes.length && !doc.texts.length && !doc.icons?.length) {
            return textResult(`画布 ${id} 是空的，没有可渲染的内容（rev ${doc.rev}）。`);
          }
          const reg = region
            ? { x0: region.x, y0: region.y, w: region.w, h: region.h }
            : contentBBox(doc);
          const svg = renderDocSvg(doc, { region: reg });
          const width = Math.max(64, Math.round(reg.w * (scale ?? 1)));
          const fontFile = resolveFontFile();
          const resvg = new Resvg(svg, {
            fitTo: { mode: "width", value: width },
            ...(fontFile ? { font: { fontFiles: [fontFile], defaultFontFamily: FONT_FAMILY } } : {}),
          });
          const png = resvg.render().asPng();
          const dir = join(projectRoot, ".content-forge", "sketchpad", "previews");
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${id}-r${doc.rev}.png`);
          writeFileSync(file, png);
          return textResult(
            `画布 ${id} 快照已渲染：${file}\n` +
              `（取景 ${Math.round(reg.x0)},${Math.round(reg.y0)} – ${Math.round(reg.x0 + reg.w)},${Math.round(reg.y0 + reg.h)} · ` +
              `${Math.round(reg.w)}×${Math.round(reg.h)} · ${doc.strokes.length} 笔迹 + ${doc.texts.length} 条文本${doc.icons?.length ? ` + ${doc.icons.length} icon` : ""} · rev ${doc.rev}；输出宽 ${width}px）\n` +
              `下一步：用 Read 工具查看该 PNG 自查；不像就 sketchpad_undo 撤掉重画，像了再继续。`,
          );
        } catch (e) {
          return textResult(`渲染快照失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_undo",
      title: "撤销笔迹",
      description: "撤销画板上最近的笔迹变更（含 agent 与页面产生的），count 为撤销次数，默认 1。",
      inputSchema: { canvas: makeCanvasInput(), count: z.number().int().min(1).max(100).optional().describe("撤销次数（默认 1）") },
      handler: async ({ canvas, count }) => {
        try {
          const r = await sketchpadApi<{ id: string; rev: number; undone: number; strokes: number }>(canvasPath(canvas, "undo"), {
            method: "POST",
            body: JSON.stringify({ count: count ?? 1 }),
          });
          return textResult(r.undone ? `画布 ${r.id} 已撤销 ${r.undone} 次变更，剩 ${r.strokes} 笔迹（rev ${r.rev}）。` : `画布 ${r.id} 没有可撤销的变更。`);
        } catch (e) {
          return textResult(`撤销失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_redo",
      title: "重做笔迹",
      description: "重做被 sketchpad_undo 撤销的变更，count 为重做次数，默认 1。",
      inputSchema: { canvas: makeCanvasInput(), count: z.number().int().min(1).max(100).optional().describe("重做次数（默认 1）") },
      handler: async ({ canvas, count }) => {
        try {
          const r = await sketchpadApi<{ id: string; rev: number; redone: number; strokes: number }>(canvasPath(canvas, "redo"), {
            method: "POST",
            body: JSON.stringify({ count: count ?? 1 }),
          });
          return textResult(r.redone ? `画布 ${r.id} 已重做 ${r.redone} 次变更，现有 ${r.strokes} 笔迹（rev ${r.rev}）。` : `画布 ${r.id} 没有可重做的变更。`);
        } catch (e) {
          return textResult(`重做失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_erase",
      title: "按元素删除",
      description:
        "按元素 id 删除笔迹/文本，做局部修正——undo 的粒度是整次 draw 调用，撤掉单个画错的元素用它。" +
        "元素 id 从 sketchpad_draw 的返回（strokeIds/textIds）或 sketchpad_get_state 的 ids=true 元素清单里拿。" +
        "删除会进撤销栈，sketchpad_undo 可恢复。",
      inputSchema: {
        canvas: makeCanvasInput(),
        ids: z.array(z.string().min(1)).max(2000).optional().describe("要删除的元素 id 列表（笔迹/文本 id 混合均可）"),
        name: z.string().min(1).max(40).optional().describe("按语义组名整组删除——擦掉该组全部笔迹+文本。用于精准修改：用户说\"数据库改大点\"时，先 erase {name:\"数据库\"} 再重画"),
      },
      handler: async ({ canvas, ids, name }) => {
        try {
          const r = await sketchpadApi<{ id: string; rev: number; removedStrokes: number; removedTexts: number; removedIcons: number; groupFound: boolean; strokes: number; texts: number }>(
            canvasPath(canvas, "remove"),
            { method: "POST", body: JSON.stringify({ ids, name }) },
          );
          const parts = [
            r.removedStrokes ? `${r.removedStrokes} 笔迹` : "",
            r.removedTexts ? `${r.removedTexts} 条文本` : "",
            r.removedIcons ? `${r.removedIcons} 个 icon` : "",
          ].filter(Boolean);
          const nameNote = name ? (r.groupFound ? `（组"${name}"）` : `（没找到组"${name}"）`) : "";
          return textResult(
            parts.length
              ? `画布 ${r.id} 已删除 ${parts.join(" + ")}${nameNote}，剩 ${r.strokes} 笔迹 / ${r.texts} 条文本（rev ${r.rev}）；可用 sketchpad_undo 恢复。`
              : `画布 ${r.id} 没有命中这些元素${nameNote}（rev ${r.rev}）。`,
          );
        } catch (e) {
          return textResult(`删除失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_order",
      title: "调整叙事层级",
      description:
        "事后调整各语义分组的叙事层级（回放/演示按它排序）：orders 为 {组名: 层级}。" +
        "规范层级 1=画布/设备框 2=骨架分区 3=主内容/用户动线 4=次级内容 5=标注。" +
        "用于画完发现顺序不对时修序（比如标注画在了中间）；改动可撤销，未知组名会列在 unknown 里不报错。",
      inputSchema: {
        canvas: makeCanvasInput(),
        orders: z
          .record(z.string().min(1).max(40), z.number().int().min(1).max(999))
          .describe("组名 → 叙事层级（1~999）：{\"背景\":1,\"主流程\":3,\"标注\":5}；组名用 get_state ids=true 的分组清单"),
      },
      handler: async ({ canvas, orders }) => {
        try {
          const r = await sketchpadApi<{ id: string; rev: number; updated: number; unknown: string[]; groups: { name: string; order: number | null }[] }>(
            canvasPath(canvas, "order"),
            { method: "POST", body: JSON.stringify({ orders }) },
          );
          const seq = r.groups
            .filter((g) => g.order !== null)
            .sort((a, b) => (a.order as number) - (b.order as number))
            .map((g) => `${g.order}:${g.name}`)
            .join(" → ");
          const unknownNote = r.unknown.length ? `；未知组名（未改动）：${r.unknown.join("、")}` : "";
          return textResult(`画布 ${r.id} 已更新 ${r.updated} 个分组层级（rev ${r.rev}）${unknownNote}。当前叙事序：${seq || "（尚无带层级的分组）"}。`);
        } catch (e) {
          return textResult(`调整层级失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_use",
      title: "切换活动画布",
      description:
        "把指定画布设为活动画布：之后所有省略 canvas 参数的 sketchpad_* 调用（与页面首开）都落到它。" +
        "并发作画/回看旧画布继续画时用它；不改变任何画布内容。",
      inputSchema: {
        canvas: z.string().regex(/^\d{14}$/).describe("要设为活动画布的画布 id（YYYYMMDDHHmmss，get_state 列表里拿）"),
      },
      handler: async ({ canvas }) => {
        try {
          const r = await sketchpadApi<{ id: string; active: string }>("/use", {
            method: "POST",
            body: JSON.stringify({ id: canvas }),
          });
          return textResult(`活动画布已切到 ${r.active}。之后省略 canvas 的 sketchpad_* 调用都落到它。`);
        } catch (e) {
          return textResult(`切换失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_clear",
      title: "清空画板",
      description: "清空画板全部笔迹（可用 sketchpad_undo 恢复）。",
      inputSchema: { canvas: makeCanvasInput() },
      handler: async ({ canvas }) => {
        try {
          const r = await sketchpadApi<{ id: string; rev: number; cleared: number }>(canvasPath(canvas, "clear"), { method: "POST" });
          return textResult(r.cleared ? `画布 ${r.id} 已清空 ${r.cleared} 笔迹（rev ${r.rev}）；可用 sketchpad_undo 恢复。` : `画布 ${r.id} 本来就是空的。`);
        } catch (e) {
          return textResult(`清空失败：${(e as Error).message}`, true);
        }
      },
    },

    {
      name: "sketchpad_preview",
      title: "打开画板页面",
      description:
        "返回画板页面 URL：用浏览器打开即可看到全部笔迹（agent 与人画的都在），页面与画板后端实时双向同步；配合截图工具检查作画效果。可带 canvas 指定打开哪块画布。",
      inputSchema: { canvas: makeCanvasInput() },
      handler: async ({ canvas }) => {
        try {
          const pv = await ensureSketchpadRoute();
          return textResult(`画板页面: ${sketchpadUrl(pv)}${canvas ? `?c=${canvas}` : ""}`);
        } catch (e) {
          return textResult(`获取预览地址失败：${(e as Error).message}`, true);
        }
      },
    },
  ];
}
