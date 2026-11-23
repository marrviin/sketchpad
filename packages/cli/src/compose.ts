/**
 * sketchpad compose：场景级确定性构图。agent 给结构化场景描述（节点/连线/参与者/分区），
 * 这里算出布局并产出后端契约形状（[x,y] tuple），按「幕」分批返回——每批一个语义组 + 叙事层级，
 * 工具层逐批 POST /draw。回放时按幕推进：流程图沿图走（节点→入边→节点）、时序图按消息一幕一幕、
 * 原型骨架按 设备框→分区 分层。叙事质量由算法保证，agent 不再手排坐标。
 * 布局抽象坐标下完成，最后统一缩放进首页画框（1040×620）。
 */
import { STENCIL_ASPECT, type ShapeSpec } from "./contract.js";

/** 首页画框尺寸（与 document.ts CANVAS_WIDTH/HEIGHT 同值，此处避免拉入完整模块） */
const FRAME_W = 1040;
const FRAME_H = 620;
const MARGIN = 44;

/** 构图字号：相对画布宽 2% */
const F = 21;

/** 一幕 = 一次 draw 调用：一个语义组 + 叙事层级 + 该幕形状（批内顺序：结构 → 标注） */
export interface ComposeBatch {
  group: string;
  order: number;
  shapes: ShapeSpec[];
}

/* ===== 文本宽度估计：LXGW 文楷渲染近似（CJK ≈ 1em，latin ≈ 0.55em） ===== */

export function estimateTextWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x2e80) em += 1;
    else if (ch === " ") em += 0.35;
    else if (/[A-Z0-9@#%&_MW]/.test(ch)) em += 0.72;
    else em += 0.55;
  }
  return em * size;
}

type Pt = [number, number];

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** 菱形对角半径（decision），其余 0 */
  r: number;
}

const LINE = { tool: "felt" as const, color: "ink" as const, size: 1 };

/** 组名去重：同名组会被后端合并，破坏逐幕叙事——重复 label 追加 ·id */
function uniqueName(base: string, id: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const name = `${base}·${id}`;
  used.add(name);
  return name;
}

/* ===== 流程图 ===== */

export interface FlowNode {
  id: string;
  label: string;
  /** start/end=椭圆（首尾节点） process=圆角矩形（默认） decision=菱形（分支判断） */
  kind?: "start" | "end" | "process" | "decision";
  /** 节点内 icon（looseleaf 名），画在文字上方 */
  icon?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** 连线中点标注 */
  label?: string;
  /** 后退/例外连线画虚线 */
  dashed?: boolean;
}

export interface FlowInput {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** tb 自上而下（默认）/ lr 自左而右 */
  dir?: "tb" | "lr";
  title?: string;
}

export interface SequenceInput {
  participants: { id: string; label: string }[];
  /** 按发生顺序给出；from === to 画自调用回环 */
  messages: { from: string; to: string; label?: string; kind?: "solid" | "dashed" }[];
  title?: string;
}

export interface WireframeRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

export interface WireframeInput {
  /** 单屏模式：设备框类型 + 内容区（0~1 归一化）分区 */
  frame?: "phone" | "browser";
  regions?: WireframeRegion[];
  /** 多屏章节模式：每屏一幕（框 + 分区 + 标签一起出现），从左到右排布、order 逐屏递增——
   *  讲产品动线（列表 → 详情 → 评论）用这个；屏间导航箭头由 agent 最后一幕补画 */
  frames?: { label?: string; frame?: "phone" | "browser"; regions: WireframeRegion[] }[];
  title?: string;
}

export type ComposeInput =
  | ({ scene: "flow" } & FlowInput)
  | ({ scene: "sequence" } & SequenceInput)
  | ({ scene: "wireframe" } & WireframeInput);

/** 主方向盒边锚点（菱形外） */
function boxAnchor(b: Box, dir: "tb" | "lr", forward: boolean, outward: boolean): Pt {
  const sign = (forward ? 1 : -1) * (outward ? 1 : -1);
  return dir === "tb" ? [b.cx, b.cy + sign * (b.h / 2)] : [b.cx + sign * (b.w / 2), b.cy];
}

/** 菱形边界：沿 target 中心方向的菱形交点（|x|/r + |y|/r = 1） */
function diamondBoundary(d: Box, target: Box): Pt {
  const dx = target.cx - d.cx;
  const dy = target.cy - d.cy;
  if (dx === 0 && dy === 0) return [d.cx, d.cy - d.r];
  const t = 1 / (Math.abs(dx) / d.r + Math.abs(dy) / d.r);
  return [d.cx + dx * t, d.cy + dy * t];
}

/** 带拐弯的三段正交折线（主方向传播，副方向对位） */
function bentPath(from: Pt, to: Pt, dir: "tb" | "lr"): Pt[] {
  return dir === "tb"
    ? [from, [(from[0] + to[0]) / 2, from[1]], [(from[0] + to[0]) / 2, to[1]], to]
    : [from, [from[0], (from[1] + to[1]) / 2], [to[0], (from[1] + to[1]) / 2], to];
}

function arrowHead(at: Pt, fromDir: Pt, len = 9): ShapeSpec[] {
  const ang = Math.atan2(at[1] - fromDir[1], at[0] - fromDir[0]);
  return [Math.PI * 0.8, -Math.PI * 0.8].map((da) => ({
    shape: "line" as const,
    from: at,
    to: [at[0] + len * Math.cos(ang + da), at[1] + len * Math.sin(ang + da)] as Pt,
    ...LINE,
  }));
}

function flowLayout(input: FlowInput, prefix: string, order: number): ComposeBatch[] {
  const dir = input.dir ?? "tb";
  const nodes = input.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of input.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      throw new Error(`edge 引用未知节点：${!byId.has(e.from) ? e.from : e.to}（nodes 里没有这个 id）`);
    }
  }
  const sizeOf = new Map(
    nodes.map((n) => {
      const tw = estimateTextWidth(n.label, F);
      if (n.kind === "decision") {
        const r = Math.max(tw * 0.62 + F, F * 1.6, 72);
        return [n.id, { w: 2 * r, h: 2 * r, r }] as const;
      }
      const ih = n.icon ? 30 : 0;
      return [n.id, { w: Math.max(tw + 36, 104), h: F + 26 + ih, r: 0 }] as const;
    }),
  );

  // 分层 + 行走顺序：从源头 BFS 最短路径（节点尽量靠近起点），queue 顺序 = 叙事行走序
  const layer = new Map<string, number>();
  const queue = nodes.filter((n) => !input.edges.some((e) => e.to === n.id)).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    const L = layer.get(id)!;
    for (const e of input.edges) {
      if (e.from !== id) continue;
      if (!layer.has(e.to)) {
        layer.set(e.to, L + 1);
        queue.push(e.to);
      }
    }
  }
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, 0);

  const maxL = Math.max(...[...layer.values()], 0);
  const layers: string[][] = Array.from({ length: maxL + 1 }, () => []);
  for (const n of nodes) layers[layer.get(n.id)!].push(n.id);

  // 抽象坐标：主轴 = 层推进方向，副轴 = 层内排布
  const gapMain = 74;
  const gapCross = 58;
  const rowSpans = layers.map(
    (L) => L.reduce((s, id) => s + sizeOf.get(id)!.w, 0) + gapCross * Math.max(L.length - 1, 0),
  );
  const rowHeights = layers.map((L) => Math.max(...L.map((id) => sizeOf.get(id)!.h)));
  const totalMain = rowHeights.reduce((s, h) => s + h, 0) + gapMain * Math.max(layers.length - 1, 0);
  const totalCross = Math.max(...rowSpans, 0);

  const boxes = new Map<string, Box>();
  let mainOff = 0;
  layers.forEach((L, li) => {
    let cross = (totalCross - rowSpans[li]) / 2;
    for (const id of L) {
      const s = sizeOf.get(id)!;
      const centerCross = cross + s.w / 2;
      const centerMain = mainOff + s.h / 2;
      boxes.set(
        id,
        dir === "tb"
          ? { cx: centerCross, cy: centerMain, w: s.w, h: s.h, r: s.r }
          : { cx: centerMain, cy: centerCross, w: s.w, h: s.h, r: s.r },
      );
      cross += s.w + gapCross;
    }
    mainOff += rowHeights[li] + gapMain;
  });

  // 统一缩放进首页框
  const titleH = input.title ? F * 2.2 : 0;
  const availW = FRAME_W - 2 * MARGIN;
  const availH = FRAME_H - 2 * MARGIN - titleH;
  const s = Math.min(availW / totalCross, availH / Math.max(totalMain, 1), 1);
  const ox = (FRAME_W - totalCross * s) / 2;
  const oy = MARGIN + titleH + (availH - totalMain * s) / 2;
  for (const [, b] of boxes) {
    b.cx = ox + b.cx * s;
    b.cy = oy + b.cy * s;
    b.w *= s;
    b.h *= s;
    b.r *= s;
  }
  const font = Math.max(F * s, 11);
  const lblFont = Math.max(F * s * 0.8, 10);

  const putLabel = (into: ShapeSpec[], text: string, cx: number, cy: number, fs = font) => {
    const tw = estimateTextWidth(text, fs);
    into.push({ shape: "text", x: cx - tw / 2, y: cy - fs * 0.62, size: fs, color: "ink", text });
  };

  /** 一条连线的形状 + 标注（目标节点的幕里先画入边再画节点） */
  const edgeShapes = (e: FlowEdge): ShapeSpec[] => {
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    const forward = dir === "tb" ? b.cy > a.cy + 1 : b.cx > a.cx + 1;
    const sameBand =
      dir === "tb" ? Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 : Math.abs(a.cx - b.cx) < (a.w + b.w) / 2;
    const dashed = e.dashed || !forward;
    const out: ShapeSpec[] = [];
    let path: Pt[];
    if (sameBand) {
      const ahead = dir === "tb" ? a.cx <= b.cx : a.cy <= b.cy;
      const L = ahead ? a : b;
      const R = ahead ? b : a;
      const p0: Pt = dir === "tb" ? [L.cx + (L.r || L.w / 2), L.cy] : [L.cx, L.cy + (L.r || L.h / 2)];
      const p1: Pt = dir === "tb" ? [R.cx - (R.r || R.w / 2), R.cy] : [R.cx, R.cy - (R.r || R.h / 2)];
      path = [p0, p1];
    } else if (!forward) {
      if (dir === "tb") {
        const x0 = a.cx + (a.r || a.w / 2);
        const x1 = b.cx + (b.r || b.w / 2);
        const xd = Math.max(x0, x1) + 34;
        path = [[x0, a.cy], [xd, a.cy], [xd, b.cy], [x1, b.cy]];
      } else {
        const y0 = a.cy + (a.r || a.h / 2);
        const y1 = b.cy + (b.r || b.h / 2);
        const yd = Math.max(y0, y1) + 34;
        path = [[a.cx, y0], [a.cx, yd], [b.cx, yd], [b.cx, y1]];
      }
    } else {
      const p0 = a.r > 0 ? diamondBoundary(a, b) : boxAnchor(a, dir, true, true);
      const p1 = b.r > 0 ? diamondBoundary(b, a) : boxAnchor(b, dir, true, false);
      const bendGap = dir === "tb" ? Math.abs(p0[0] - p1[0]) : Math.abs(p0[1] - p1[1]);
      path = bendGap > 8 ? bentPath(p0, p1, dir) : [p0, p1];
    }
    if (path.length === 2) {
      out.push(
        dashed
          ? { shape: "dash", from: path[0], to: path[1], ...LINE }
          : { shape: "arrow", from: path[0], to: path[1], ...LINE },
      );
    } else {
      out.push({ shape: "polyline", points: path, ...LINE });
      out.push(...arrowHead(path[path.length - 1], path[path.length - 2]));
    }
    if (e.label) {
      if (path.length === 2) {
        putLabel(out, e.label, (path[0][0] + path[1][0]) / 2, (path[0][1] + path[1][1]) / 2 - lblFont * 0.7, lblFont);
      } else {
        const [m1, m2] = [path[1], path[2]];
        if (dir === "tb") putLabel(out, e.label, m1[0] + lblFont * 0.6, (m1[1] + m2[1]) / 2, lblFont);
        else putLabel(out, e.label, (m1[0] + m2[0]) / 2, m1[1] - lblFont * 0.7, lblFont);
      }
    }
    return out;
  };

  // 出幕：标题（order 1）→ 沿图行走逐节点一幕（入边先画，节点后画，文字最后）
  const used = new Set<string>();
  const batches: ComposeBatch[] = [];
  if (input.title) {
    const shapes: ShapeSpec[] = [];
    putLabel(shapes, input.title, FRAME_W / 2, MARGIN * 0.7 + F * 1.1, font * 1.15);
    batches.push({ group: uniqueName(`${prefix}·标题`, "title", used), order: 1, shapes });
  }
  for (const id of queue) {
    const n = byId.get(id)!;
    const b = boxes.get(id)!;
    const shapes: ShapeSpec[] = [];
    for (const e of input.edges) {
      if (e.to === id) shapes.push(...edgeShapes(e));
    }
    if (n.kind === "decision") {
      shapes.push({
        shape: "polyline",
        points: [
          [b.cx, b.cy - b.r],
          [b.cx + b.r, b.cy],
          [b.cx, b.cy + b.r],
          [b.cx - b.r, b.cy],
          [b.cx, b.cy - b.r],
        ],
        ...LINE,
      });
    } else if (n.kind === "start" || n.kind === "end") {
      shapes.push({ shape: "ellipse", cx: b.cx, cy: b.cy, rx: b.w / 2, ry: b.h / 2, ...LINE });
    } else {
      shapes.push({ shape: "rrect", x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h, r: 7, ...LINE });
    }
    if (n.icon) {
      const isz = Math.min(28 * s, b.h * 0.38);
      shapes.push({ shape: "icon", name: n.icon, x: b.cx - isz / 2, y: b.cy - b.h / 2 + 4, size: isz, tool: LINE.tool, color: LINE.color });
    }
    const fs = n.kind === "decision" ? Math.min(font, b.r * 0.72) : font;
    putLabel(shapes, n.label, b.cx, b.cy + (n.icon ? 6 : 0), fs);
    batches.push({ group: uniqueName(n.label, n.id, used), order, shapes });
  }
  return batches;
}

function sequenceLayout(input: SequenceInput, prefix: string, order: number): ComposeBatch[] {
  const batches: ComposeBatch[] = [];
  const used = new Set<string>();
  const parts = input.participants;
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const m of input.messages) {
    if (!byId.has(m.from) || !byId.has(m.to)) {
      throw new Error(`message 引用未知参与者：${!byId.has(m.from) ? m.from : m.to}`);
    }
  }
  const titleH = input.title ? F * 2.4 : 0;
  const headH = Math.max(F + 18, 44);
  const availH = FRAME_H - 2 * MARGIN - titleH - headH - 66;
  const rowGap = Math.min(72, Math.max(40, availH / Math.max(input.messages.length + 1, 1)));
  const colW = (FRAME_W - 2 * MARGIN) / Math.max(parts.length, 1);
  const headY = MARGIN + titleH;
  const rowY = (i: number) => headY + headH + 30 + rowGap * (i + 1);
  const cxOf = new Map(parts.map((p, i) => [p.id, MARGIN + colW * (i + 0.5)] as const));

  // ① 标题
  if (input.title) {
    batches.push({
      group: uniqueName(`${prefix}·标题`, "title", used),
      order: 1,
      shapes: [
        {
          shape: "text",
          x: (FRAME_W - estimateTextWidth(input.title, F * 1.15)) / 2,
          y: MARGIN * 0.7,
          size: F * 1.15,
          color: "ink",
          text: input.title,
        },
      ],
    });
  }
  // ② 参与者 + 生命线（骨架）
  const head: ShapeSpec[] = [];
  for (const p of parts) {
    const w = Math.min(colW - 18, Math.max(estimateTextWidth(p.label, F) + 20, 64));
    const cx = cxOf.get(p.id)!;
    head.push({ shape: "rrect", x: cx - w / 2, y: headY, w, h: headH, r: 6, ...LINE });
    head.push({
      shape: "text",
      x: cx - estimateTextWidth(p.label, F) / 2,
      y: headY + headH / 2 - F * 0.62,
      size: F,
      color: "ink",
      text: p.label,
    });
  }
  const lastY = rowY(Math.max(input.messages.length - 1, 0));
  for (const p of parts) {
    const cx = cxOf.get(p.id)!;
    head.push({ shape: "dash", from: [cx, headY + headH + 4], to: [cx, lastY + 22], ...LINE });
  }
  batches.push({ group: uniqueName(`${prefix}·参与者`, "participants", used), order: 2, shapes: head });
  // ③ 每条消息一幕（按发生顺序）
  input.messages.forEach((m, i) => {
    const y = rowY(i);
    const x0 = cxOf.get(m.from)!;
    const x1 = cxOf.get(m.to)!;
    const shapes: ShapeSpec[] = [];
    if (m.from === m.to) {
      const pts: Pt[] = [[x0, y], [x0 + 16, y], [x0 + 16, y + 18], [x0 + 2, y + 18]];
      shapes.push({ shape: "polyline", points: pts, ...LINE });
      shapes.push(...arrowHead([x0 + 2, y + 18], pts[pts.length - 2], 7));
      if (m.label) {
        shapes.push({ shape: "text", x: x0 + 22, y: y + 22, size: F * 0.85, color: "ink", text: m.label });
      }
    } else if (m.kind === "dashed") {
      shapes.push({ shape: "dash", from: [x0, y], to: [x1, y], ...LINE });
      shapes.push(...arrowHead([x1, y], [x0, y], 9));
      if (m.label) {
        shapes.push({
          shape: "text",
          x: (x0 + x1) / 2 - estimateTextWidth(m.label, F * 0.85) / 2,
          y: y - F * 1.15,
          size: F * 0.85,
          color: "ink",
          text: m.label,
        });
      }
    } else {
      shapes.push({ shape: "arrow", from: [x0, y], to: [x1, y], ...LINE });
      if (m.label) {
        shapes.push({
          shape: "text",
          x: (x0 + x1) / 2 - estimateTextWidth(m.label, F * 0.85) / 2,
          y: y - F * 1.15,
          size: F * 0.85,
          color: "ink",
          text: m.label,
        });
      }
    }
    const name = m.label ?? `${byId.get(m.from)!.label}→${byId.get(m.to)!.label}`;
    batches.push({ group: uniqueName(`${prefix}·${name}`, `${i}`, used), order, shapes });
  });
  return batches;
}

function wireframeLayout(input: WireframeInput, prefix: string, order: number): ComposeBatch[] {
  const batches: ComposeBatch[] = [];
  const used = new Set<string>();
  const screens =
    input.frames && input.frames.length
      ? input.frames.map((f) => ({ frame: f.frame ?? input.frame ?? "phone", label: f.label, regions: f.regions }))
      : input.frame
        ? [{ frame: input.frame, label: undefined, regions: input.regions ?? [] }]
        : (() => {
            throw new Error("wireframe 需要 frame（单屏）或 frames（多屏章节）");
          })();
  const N = screens.length;
  if (N > 6) throw new Error(`frames 最多 6 屏（当前 ${N}）`);
  const titleH = input.title ? F * 2.2 : 0;
  const availW = FRAME_W - 2 * MARGIN;
  const availH = FRAME_H - 2 * MARGIN - titleH;
  const gap = N > 1 ? 56 : 0;
  // 按最宽高比反推每屏尺寸：高度撞顶或宽度装不下取小者
  let fh = availH;
  for (const sc of screens) {
    const aspect = STENCIL_ASPECT[sc.frame];
    fh = Math.min(fh, ((availW - gap * (N - 1)) / N) * aspect, availH);
  }
  // 各屏宽高（不同 kind 可混排：phone/browser 各自按同一高度定宽）
  const geom = screens.map((sc) => {
    const fw = fh / STENCIL_ASPECT[sc.frame];
    return { sc, fw, fh };
  });
  const totalW = geom.reduce((s, g) => s + g.fw, 0) + gap * (N - 1);
  let x = (FRAME_W - totalW) / 2;
  const y = MARGIN + titleH + (availH - fh) / 2;
  const font = F * 0.85;
  // ① 标题
  if (input.title) {
    batches.push({
      group: uniqueName(`${prefix}·标题`, "title", used),
      order: 1,
      shapes: [
        {
          shape: "text",
          x: (FRAME_W - estimateTextWidth(input.title, font * 1.2)) / 2,
          y: MARGIN * 0.55,
          size: font * 1.2,
          color: "ink",
          text: input.title,
        },
      ],
    });
  }
  // ② 每屏一幕（章节叙事：框 + 分区 + 标签一起出现，order 逐屏递增）
  geom.forEach(({ sc, fw }, i) => {
    const fx = x;
    x += fw + gap;
    const shapes: ShapeSpec[] = [
      { shape: "stencil", kind: sc.frame, x: fx, y, w: fw, h: fh, ...LINE },
    ];
    // 内容区：扣掉 browser 标题栏 / phone 刘海
    const inset = sc.frame === "browser" ? fh * 0.16 : fh * 0.06;
    const ix = fx + fw * 0.045;
    const iw = fw - fw * 0.09;
    const iy = y + inset;
    const ih = fh - inset - fh * 0.045;
    for (const r of sc.regions) {
      const rx = ix + r.x * iw;
      const ry = iy + r.y * ih;
      const rw = r.w * iw;
      const rh = r.h * ih;
      shapes.push({ shape: "rrect", x: rx, y: ry, w: rw, h: rh, r: 5, ...LINE });
      if (r.label) {
        shapes.push({ shape: "text", x: rx + 6, y: ry + 6, size: font, color: "ink", text: r.label });
      }
    }
    const name = sc.label ?? `${prefix}·屏幕${i + 1}`;
    batches.push({ group: uniqueName(name, `${i}`, used), order: order + i, shapes });
  });
  return batches;
}

/** 场景 → 叙事批次（每批一次 draw 调用；批序 = 回放序） */
export function composeBatches(input: ComposeInput, prefix: string, order: number): ComposeBatch[] {
  switch (input.scene) {
    case "flow":
      return flowLayout(input, prefix, order);
    case "sequence":
      return sequenceLayout(input, prefix, order);
    case "wireframe":
      return wireframeLayout(input, prefix, order);
  }
}
