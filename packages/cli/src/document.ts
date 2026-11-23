/**
 * 画板文档存储与形状采样：CanvasStore 是画板状态的唯一事实源（内存 + 落盘），
 * 页面（fetch/SSE）与 CLI 工具（HTTP）都经它读写；形状输入（point/line/polyline/rect/
 * ellipse/bezier）在此采样为笔迹点列（弧长等距，贴近手写采样密度）。
 */
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoColor,
  STENCIL_ASPECT,
  type CanvasDoc,
  type DrawTool,
  type ElementGroup,
  type SketchColor,
  type SketchIcon,
  type SketchPoint,
  type SketchStroke,
  type SketchText,
  type SketchTool,
  type ShapeSpec,
  type StencilKind,
} from "./contract.js";

export const CANVAS_WIDTH = 1040;
export const CANVAS_HEIGHT = 620;

/** 采样步长（px）：与组件手写采样密度同量级，渲染质感一致 */
const SAMPLE_STEP = 2.5;
/** 无界画布：只挡荒谬坐标（防误传坐标把文档写爆），不再是画布边界；首页画框 1040×620 在原点 */
const COORD_LIMIT = 100_000;
const HISTORY_MAX = 200;

export const clampCoord = (v: number): number => Math.min(Math.max(v, -COORD_LIMIT), COORD_LIMIT);

/* ===== 形状 → 笔迹点列 ===== */

/** 按弧长等距重采样（保首尾点） */
function resample(pts: SketchPoint[]): SketchPoint[] {
  if (pts.length < 2) return pts.slice();
  const out: SketchPoint[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg === 0) continue;
    acc += seg;
    if (acc >= SAMPLE_STEP) {
      out.push(pts[i]);
      acc = 0;
    }
  }
  const tail = pts[pts.length - 1];
  if (out[out.length - 1] !== tail) out.push(tail);
  return out;
}

/** 相邻点连线采样（步长内不插值）；closed 时末点回到首点 */
function polylinePts(points: SketchPoint[], closed = false): SketchPoint[] {
  const src = closed && points.length > 1 ? [...points, points[0]] : points;
  if (src.length < 2) return src.slice();
  const out: SketchPoint[] = [src[0]];
  for (let i = 1; i < src.length; i++) {
    const [ax, ay] = src[i - 1];
    const [bx, by] = src[i];
    const dist = Math.hypot(bx - ax, by - ay);
    const n = Math.floor(dist / SAMPLE_STEP);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    out.push([bx, by]);
  }
  return out;
}

/** 三次贝塞尔：先均匀参数采样，再弧长重采样（避免曲率大处折线感） */
function bezierPts(a: SketchPoint, c1: SketchPoint, c2: SketchPoint, b: SketchPoint): SketchPoint[] {
  const N = 96;
  const raw: SketchPoint[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const x = u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0];
    const y = u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1];
    raw.push([x, y]);
  }
  return resample(raw);
}

/** 过点平滑曲线（Catmull-Rom，端点复制延拓）：画有机形状的主力 */
function splinePts(points: SketchPoint[]): SketchPoint[] {
  if (points.length < 2) return points.slice();
  const raw: SketchPoint[] = [];
  const at = (i: number): SketchPoint => points[Math.min(points.length - 1, Math.max(0, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const N = 16;
    for (let k = i === 0 ? 0 : 1; k <= N; k++) {
      const t = k / N, t2 = t * t, t3 = t2 * t;
      raw.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return resample(raw);
}

/** 虚线段 → 多段点列（dash/gap 按 size 等比，随手绘线宽变化） */
export function dashSegments(shape: Extract<ShapeSpec, { shape: "dash" }>): SketchPoint[][] {
  const { from, to } = shape;
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (len < 1) return [];
  const unit = Math.max(shape.size ?? 1, 0.2);
  const dash = Math.max(2, 6 * unit), gap = Math.max(1.5, 4.5 * unit);
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const segs: SketchPoint[][] = [];
  for (let s = 0; s < len; s += dash + gap) {
    const e = Math.min(s + dash, len);
    segs.push([
      [from[0] + s * Math.cos(ang), from[1] + s * Math.sin(ang)],
      [from[0] + e * Math.cos(ang), from[1] + e * Math.sin(ang)],
    ]);
  }
  return segs;
}

/** 矩形区域排线 → 线段点列族（角度线族与矩形求交；angleDeg 默认 -45，gap 默认 9px） */
export function hatchLines(shape: Extract<ShapeSpec, { shape: "hatch" }>): SketchPoint[][] {
  const { x, y, w, h } = shape;
  const gap = Math.max(shape.gap ?? 9, 3);
  const ang = ((shape.angleDeg ?? -45) * Math.PI) / 180;
  if (w <= 0 || h <= 0) return [];
  /* 直线 y = k*x + b；沿法向以 gap 步进取 b，与矩形求交（区间裁剪） */
  const k = Math.tan(ang);
  const x0 = Math.min(x, x + w), x1 = Math.max(x, x + w);
  const y0 = Math.min(y, y + h), y1 = Math.max(y, y + h);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  /* b 的取值范围：角点到中心线的法向距离投影 */
  const span = Math.abs(h * Math.cos(ang)) + Math.abs(w * Math.sin(ang));
  const lines: SketchPoint[][] = [];
  for (let d = -span / 2; d <= span / 2; d += gap) {
    /* b = cy - k*cx + d*cos(ang)：沿法向单位向量 (-sin,cos) 平移 d 后的截距 */
    const bb = cy - k * cx + d * Math.cos(ang);
    const xa = x0, xb = x1;
    const ya = k * xa + bb, yb = k * xb + bb;
    /* 与矩形裁剪（Liang-Barsky 单约束版）：den>0 是下界约束收 lo，den<0 是上界约束收 hi */
    let lo = 0, hi = 1;
    const clip = (num: number, den: number): void => {
      if (Math.abs(den) < 1e-12) {
        /* 与该边界平行：点已满足约束（num ≤ 0）则不裁剪，越界（num > 0）则整线拒绝 */
        if (num > 0) { lo = 1; hi = 0; }
        return;
      }
      const t = num / den;
      if (den > 0) { if (t > lo) lo = t; }
      else { if (t < hi) hi = t; }
    };
    clip(x0 - xa, xb - xa); clip(xa - x1, xa - xb);
    clip(y0 - ya, yb - ya); clip(ya - y1, ya - yb);
    if (lo >= hi) continue;
    const cl = (v: number, lo0: number, hi0: number): number => Math.min(hi0, Math.max(lo0, v));
    const p: SketchPoint = [cl(xa + (xb - xa) * lo, x0, x1), cl(ya + (yb - ya) * lo, y0, y1)];
    const q: SketchPoint = [cl(xa + (xb - xa) * hi, x0, x1), cl(ya + (yb - ya) * hi, y0, y1)];
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 1) lines.push([p, q]);
  }
  return lines;
}

/** 笔迹类形状（dash/hatch 多笔形状走 dashSegments/hatchLines，text 走 buildStrokes 的 texts 分支） */
type StrokeShape = Extract<ShapeSpec, { shape: "point" | "line" | "polyline" | "rect" | "rrect" | "ellipse" | "arc" | "polygon" | "star" | "bezier" | "spline" | "arrow" }>;

/** 单形状 → 笔迹点列（坐标系：画布像素，y 向下） */
export function sampleShape(shape: StrokeShape): SketchPoint[] {
  switch (shape.shape) {
    case "point":
      return [[shape.x, shape.y]];
    case "line":
      return polylinePts([shape.from, shape.to]);
    case "polyline":
      return polylinePts(shape.points);
    case "rect": {
      const { x, y, w, h } = shape;
      return polylinePts([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    }
    case "rrect": {
      const { x, y, w, h } = shape;
      const r = Math.min(shape.r, Math.abs(w) / 2, Math.abs(h) / 2);
      if (r <= 0) return sampleShape({ shape: "rect", x, y, w, h });
      /* 顺时针走：顶边 → 右上角弧 → 右边 → 右下角弧 → 底边 → 左下角弧 → 左边 → 左上角弧 */
      const arc = (cx: number, cy: number, a0: number, a1: number): SketchPoint[] => {
        const n = Math.max(4, Math.ceil(((Math.PI / 2) * r) / SAMPLE_STEP));
        const pts: SketchPoint[] = [];
        for (let i = 1; i <= n; i++) {
          const a = a0 + ((a1 - a0) * i) / n;
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        return pts;
      };
      const T = -Math.PI / 2, R = 0, B = Math.PI / 2, L = Math.PI;
      const right = x + w, bottom = y + h;
      return polylinePts([
        [x + r, y],
        ...arc(right - r, y + r, T, R), [right, bottom - r],
        ...arc(right - r, bottom - r, R, B), [x + r, bottom],
        ...arc(x + r, bottom - r, B, L), [x, y + r],
        ...arc(x + r, y + r, L, Math.PI * 1.5), [x + r, y],
      ]);
    }
    case "ellipse": {
      const { cx, cy, rx, ry } = shape;
      return arcPts(cx, cy, rx, ry, 0, Math.PI * 2);
    }
    case "arc": {
      const { cx, cy, rx, ry, startDeg, endDeg } = shape;
      return arcPts(cx, cy, Math.abs(rx), Math.abs(ry), (startDeg * Math.PI) / 180, (endDeg * Math.PI) / 180);
    }
    case "polygon": {
      const { cx, cy, r, sides, rotDeg = -90 } = shape;
      const pts: SketchPoint[] = [];
      for (let i = 0; i < sides; i++) {
        const a = ((rotDeg + (360 * i) / sides) * Math.PI) / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return polylinePts(pts, true);
    }
    case "star": {
      const { cx, cy, rOuter, rInner, points, rotDeg = -90 } = shape;
      const pts: SketchPoint[] = [];
      for (let i = 0; i < points * 2; i++) {
        const a = ((rotDeg + (180 * i) / points) * Math.PI) / 180;
        const r = i % 2 === 0 ? rOuter : rInner;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return polylinePts(pts, true);
    }
    case "bezier":
      return bezierPts(shape.start, shape.cp1, shape.cp2, shape.end);
    case "spline":
      return splinePts(shape.points);
    case "arrow":
      return sampleArrow(shape)[0]; // 正常入口是 buildStrokes→sampleArrow；直调取主体线保持穷尽
  }
}

/** 椭圆弧采样（角度制弧度；跨满 2π 时闭环）：arc 与 ellipse 共用 */
function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): SketchPoint[] {
  const r = Math.max(Math.abs(rx), Math.abs(ry));
  const sweep = Math.abs(a1 - a0);
  const perimeter = (sweep / (Math.PI * 2)) * Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const n = Math.max(24, Math.ceil(perimeter / SAMPLE_STEP));
  const pts: SketchPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return r > 0 ? polylinePts(sweep >= Math.PI * 2 ? [...pts, pts[0]] : pts) : [[cx, cy]];
}

/** 箭头 → 笔迹点列数组：主线 + 两条头部短线（三笔） */
export function sampleArrow(shape: Extract<ShapeSpec, { shape: "arrow" }>): SketchPoint[][] {
  const { from, to } = shape;
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (len < 1) return [[[from[0], from[1]]]];
  const head = shape.head ?? Math.min(16, Math.max(7, len * 0.14));
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  /* 头部从箭尖往回张开 ±25°；线主体留出尖部避免过冲 */
  const wing = (side: number): SketchPoint[] => [
    [to[0] - head * Math.cos(ang + side * 0.46), to[1] - head * Math.sin(ang + side * 0.46)],
    to,
  ];
  const bodyEnd: SketchPoint = [to[0] - head * 0.55 * Math.cos(ang), to[1] - head * 0.55 * Math.sin(ang)];
  const body = len > head ? polylinePts([from, bodyEnd]) : polylinePts([from, to]);
  return [body, polylinePts(wing(1)), polylinePts(wing(-1))];
}

/** 归一化坐标（0~1 相对画布宽高）→ 画布像素：位置按各自轴缩放，长度类字段
 *  （w/h/r/rx/ry/rOuter/rInner/head 等）统一按宽缩放——圆/正方形不因画布宽高比变形 */
export function normalizeShape(shape: ShapeSpec, width: number, height: number): ShapeSpec {
  if (shape.shape === "polyline")
    return { ...shape, points: shape.points.map(([x, y]) => [x * width, y * height]) };
  const s = <T extends SketchPoint>(p: T): T => ([p[0] * width, p[1] * height, p[2]] as T);
  switch (shape.shape) {
    case "point":
      return { ...shape, x: shape.x * width, y: shape.y * height };
    case "line":
      return { ...shape, from: s(shape.from), to: s(shape.to) };
    case "bezier":
      return { ...shape, start: s(shape.start), cp1: s(shape.cp1), cp2: s(shape.cp2), end: s(shape.end) };
    case "arrow":
      return { ...shape, from: s(shape.from), to: s(shape.to), head: shape.head !== undefined ? shape.head * width : undefined };
    case "rect":
    case "rrect":
      return { ...shape, x: shape.x * width, y: shape.y * height, w: shape.w * width, h: shape.h * width, ...(shape.shape === "rrect" ? { r: shape.r * width } : {}) };
    case "ellipse":
    case "arc":
      return { ...shape, cx: shape.cx * width, cy: shape.cy * height, rx: shape.rx * width, ry: shape.ry * width };
    case "polygon":
      return { ...shape, cx: shape.cx * width, cy: shape.cy * height, r: shape.r * width };
    case "star":
      return { ...shape, cx: shape.cx * width, cy: shape.cy * height, rOuter: shape.rOuter * width, rInner: shape.rInner * width };
    case "dash":
      return { ...shape, from: s(shape.from), to: s(shape.to) };
    case "spline":
      return { ...shape, points: shape.points.map(([x, y]) => [x * width, y * height]) };
    case "hatch":
      return { ...shape, x: shape.x * width, y: shape.y * height, w: shape.w * width, h: shape.h * width, gap: shape.gap !== undefined ? shape.gap * width : undefined };
    case "text":
      // 位置按 norm 缩放；字号恒为 px（LLM 传 size:30 意图就是 30px，按宽缩放会得到 3 万像素）
      return { ...shape, x: shape.x * width, y: shape.y * height };
    case "stencil":
      // x/y 按各自轴，w/h 按宽；h 缺省留给 buildStrokes 用 STENCIL_ASPECT 补
      return { ...shape, x: shape.x * width, y: shape.y * height, w: shape.w * width, h: shape.h !== undefined ? shape.h * width : undefined };
    case "icon":
      // x/y 按各自轴，size 边长按宽缩放
      return { ...shape, x: shape.x * width, y: shape.y * height, size: shape.size !== undefined ? shape.size * width : undefined };
  }
}

/** 把点列钳回无界画布的护栏范围（返回钳制的点数）；width/height 仅保留签名兼容，不再参与 */
export function clampPts(pts: SketchPoint[], _width: number, _height: number): number {
  let clamped = 0;
  for (const p of pts) {
    const x = clampCoord(p[0]);
    const y = clampCoord(p[1]);
    if (x !== p[0] || y !== p[1]) clamped++;
    (p as [number, number, number?])[0] = x;
    (p as [number, number, number?])[1] = y;
  }
  return clamped;
}

/* ===== stencil 复合符号展开 =====
 * 每个 kind 把一个包围盒 (x,y,w,h,px) 编译成原语 shape 数组（rect/rrect/ellipse/arc/line/spline/dash），
 * 再走现有采样管线。统一继承 stencil 的 tool/color/size——手绘图本就单色墨线，不做逐元素上色。 */

type Sub = ShapeSpec;

const L = (x1: number, y1: number, x2: number, y2: number): Sub => ({ shape: "line", from: [x1, y1], to: [x2, y2] });

export function stencilBuild(kind: StencilKind, x: number, y: number, w: number, h: number, units = 3): Sub[] {
  const cx = x + w / 2;
  switch (kind) {
    case "phone":
      return [
        { shape: "rrect", x, y, w, h, r: w * 0.11 }, // 机身
        { shape: "rrect", x: cx - w * 0.085, y: y + h * 0.03, w: w * 0.17, h: h * 0.018, r: h * 0.009 }, // 刘海 pill
        L(cx - w * 0.11, y + h * 0.962, cx + w * 0.11, y + h * 0.962), // home indicator
        L(x + w, y + h * 0.18, x + w, y + h * 0.27), // 侧边键
      ];
    case "browser":
      return [
        { shape: "rect", x, y, w, h }, // 窗口
        L(x, y + h * 0.15, x + w, y + h * 0.15), // 标题栏分隔线
        // 三圆点（红绿灯）
        { shape: "ellipse", cx: x + w * 0.05, cy: y + h * 0.075, rx: w * 0.012, ry: h * 0.032 },
        { shape: "ellipse", cx: x + w * 0.095, cy: y + h * 0.075, rx: w * 0.012, ry: h * 0.032 },
        { shape: "ellipse", cx: x + w * 0.14, cy: y + h * 0.075, rx: w * 0.012, ry: h * 0.032 },
        // 地址栏
        { shape: "rrect", x: x + w * 0.2, y: y + h * 0.045, w: w * 0.75, h: h * 0.062, r: h * 0.031 },
      ];
    case "db":
      return [
        { shape: "ellipse", cx, cy: y + h * 0.13, rx: w / 2, ry: h * 0.13 }, // 顶椭圆
        L(x, y + h * 0.13, x, y + h * 0.9), // 左侧壁
        L(x + w, y + h * 0.13, x + w, y + h * 0.9), // 右侧壁
        // 底部前 rim（下半个椭圆，180°→360° 顺时针过底）
        { shape: "arc", cx, cy: y + h * 0.9, rx: w / 2, ry: h * 0.13, startDeg: 180, endDeg: 360 },
      ];
    case "server": {
      const out: Sub[] = [{ shape: "rect", x, y, w, h }];
      const bh = h / Math.max(1, units);
      for (let i = 1; i < units; i++) out.push(L(x, y + bh * i, x + w, y + bh * i)); // 单元分隔
      for (let i = 0; i < units; i++) {
        const top = y + bh * i;
        out.push(L(x + w * 0.32, top + bh * 0.34, x + w * 0.68, top + bh * 0.34)); // 通风线 1
        out.push(L(x + w * 0.32, top + bh * 0.56, x + w * 0.68, top + bh * 0.56)); // 通风线 2
        out.push({ shape: "ellipse", cx: x + w * 0.13, cy: top + bh * 0.45, rx: w * 0.022, ry: bh * 0.14 }); // led
      }
      return out;
    }
    case "cloud":
      return [
        // 顶部三个弧丘（spline 过点）
        {
          shape: "spline",
          points: [
            [x + w * 0.12, y + h * 0.72],
            [x + w * 0.09, y + h * 0.5],
            [x + w * 0.22, y + h * 0.27],
            [x + w * 0.38, y + h * 0.4],
            [x + w * 0.5, y + h * 0.15],
            [x + w * 0.66, y + h * 0.34],
            [x + w * 0.8, y + h * 0.29],
            [x + w * 0.91, y + h * 0.5],
            [x + w * 0.88, y + h * 0.72],
          ],
        },
        L(x + w * 0.88, y + h * 0.72, x + w * 0.12, y + h * 0.72), // 平底
      ];
    case "actor":
      return [
        { shape: "ellipse", cx, cy: y + h * 0.13, rx: w * 0.18, ry: h * 0.11 }, // 头
        L(cx, y + h * 0.24, cx, y + h * 0.58), // 躯干
        L(x + w * 0.12, y + h * 0.36, x + w * 0.88, y + h * 0.36), // 平举双臂
        L(cx, y + h * 0.58, x + w * 0.28, y + h * 0.95), // 左腿
        L(cx, y + h * 0.58, x + w * 0.72, y + h * 0.95), // 右腿
      ];
    case "group":
      // 虚线分组边界（4 边 dash）；标题 tab 由 agent 用 text 落在左上角
      return [
        { shape: "dash", from: [x, y], to: [x + w, y] },
        { shape: "dash", from: [x + w, y], to: [x + w, y + h] },
        { shape: "dash", from: [x + w, y + h], to: [x, y + h] },
        { shape: "dash", from: [x, y + h], to: [x, y] },
      ];
  }
}

/** 单原语 shape → 笔迹点列族（arrow/dash/hatch 各产多笔） */
function resolvePointLists(shape: ShapeSpec): SketchPoint[][] {
  if (shape.shape === "arrow") return sampleArrow(shape);
  if (shape.shape === "dash") return dashSegments(shape);
  if (shape.shape === "hatch") return hatchLines(shape);
  return [sampleShape(shape as StrokeShape)];
}

/* ===== icon：直接用 looseleaf 真实 icon 渲染成笔迹 =====
 * 静态数据 icon-points.json（预生成自 looseleaf icons 库的纯点列，24 网格）。
 * 之前尝试 require web 源码，但 web 用 @/ 别名、sketchpad 后端解析不了，改静态数据。 */
import iconPoints from "./icon-points.json" with { type: "json" };

/** icon 形状 → 笔迹点列族：查静态点列，平移到 (x,y)，scale 到 size（24 网格 → size） */
export function buildIconStrokes(name: string, x: number, y: number, size = 28): SketchPoint[][] {
  const polys = (iconPoints as unknown as Record<string, number[][][]>)[name];
  if (!polys?.length) return [];
  const k = size / 24;
  return polys.map((poly) => poly.map((p) => [x + p[0] * k, y + p[1] * k] as [number, number]));
}

/* ===== 文档存储 ===== */

function blankDoc(): CanvasDoc {
  return {
    version: 1,
    rev: 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    tool: "felt",
    color: "ink",
    size: 1,
    strokes: [],
    texts: [],
    icons: [],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 画布 id：创建时刻的本地时间 YYYYMMDDHHmmss（与页面/CLI 三方约定，见 contract 注释） */
export function canvasId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 画布目录内画布文件的文件名（<id>.json）；sketch.json 是多画布之前的单文档旧格式 */
const isCanvasFile = (name: string): boolean => /^\d{14}\.json$/.test(name);

/** 画布内容快照：笔迹 + 文本 + icon + 命名分组一起进出撤销栈 */
export interface CanvasContent {
  strokes: SketchStroke[];
  texts: SketchText[];
  icons: SketchIcon[];
  groups: ElementGroup[];
}

const emptyContent = (): CanvasContent => ({ strokes: [], texts: [], icons: [], groups: [] });

/** 单个画布的状态：文档 + 该画布自己的撤销/重做栈（多画布互相隔离） */
export class CanvasState {
  doc: CanvasDoc;
  private readonly file: string;
  private past: CanvasContent[] = [];
  private future: CanvasContent[] = [];

  constructor(file: string, doc: CanvasDoc) {
    this.file = file;
    this.doc = doc;
  }

  private save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.doc));
  }

  private touch(): void {
    this.doc.rev += 1;
    this.doc.updatedAt = new Date().toISOString();
    this.save();
  }

  private snapshot(): CanvasContent {
    /* groups 深拷贝：append 之后的 registerGroup/序调整会原地改组对象，共享引用会让 undo 无法回滚组状态 */
    return {
      strokes: this.doc.strokes,
      texts: this.doc.texts,
      icons: this.doc.icons,
      groups: this.doc.groups.map((g) => ({ ...g, strokeIds: [...g.strokeIds], textIds: [...g.textIds], iconIds: g.iconIds ? [...g.iconIds] : undefined })),
    };
  }

  /** 全量替换内容（页面擦除/撤销/清空后的 PUT 全覆盖；texts 省略 = 保留现有文本） */
  replaceStrokes(strokes: SketchStroke[], texts?: SketchText[]): void {
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
    this.doc.strokes = strokes;
    if (texts) this.doc.texts = texts;
    this.touch();
  }

  append(strokes: SketchStroke[], texts: SketchText[] = []): void {
    this.replaceStrokes([...this.doc.strokes, ...strokes], texts.length ? [...this.doc.texts, ...texts] : undefined);
  }

  /** 把这批笔迹/文本/icon 归到命名组（同名合并）。draw 带 group 时调用——这是语义绑定的入口；
   *  order = 叙事层级（回放排序键），同名重画带 order 则覆盖，不带则保留原值 */
  registerGroup(name: string, strokeIds: string[], textIds: string[], iconIds: string[] = [], order?: number): void {
    if (!strokeIds.length && !textIds.length && !iconIds.length) return;
    const g = this.doc.groups.find((x) => x.name === name);
    if (g) {
      g.strokeIds.push(...strokeIds);
      g.textIds.push(...textIds);
      g.iconIds = [...(g.iconIds ?? []), ...iconIds];
      if (order !== undefined) g.order = order;
    } else {
      this.doc.groups.push({ name, strokeIds: [...strokeIds], textIds: [...textIds], iconIds: [...iconIds], order });
    }
    this.save();
  }

  /** 事后调整各组叙事层级（sketchpad order 命令）：未知名进 unknown 不报错；值无变化不动撤销栈。
   *  groups 在 CanvasContent 快照内，undo/redo 自动恢复层级 */
  setGroupOrders(entries: Array<{ name: string; order: number }>): { updated: number; unknown: string[] } {
    const before = this.snapshot();
    let changed = false;
    let updated = 0;
    const unknown: string[] = [];
    for (const { name, order } of entries) {
      const g = this.doc.groups.find((x) => x.name === name);
      if (!g) {
        unknown.push(name);
        continue;
      }
      if (g.order === order) continue;
      g.order = order;
      changed = true;
      updated += 1;
    }
    if (!changed) return { updated: 0, unknown };
    this.past.push(before);
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
    this.touch();
    return { updated, unknown };
  }

  /** 按名删除整组：擦掉该组所有笔迹/文本/icon，并从分组表移除。返回删除数 */
  removeGroup(name: string): { strokes: number; texts: number; icons: number; found: boolean } {
    const g = this.doc.groups.find((x) => x.name === name);
    if (!g) return { strokes: 0, texts: 0, icons: 0, found: false };
    const drop = new Set([...g.strokeIds, ...g.textIds, ...(g.iconIds ?? [])]);
    const strokes = this.doc.strokes.filter((s) => !drop.has(s.id));
    const texts = this.doc.texts.filter((t) => !drop.has(t.id));
    const icons = this.doc.icons.filter((i) => !drop.has(i.id));
    const removedStrokes = this.doc.strokes.length - strokes.length;
    const removedTexts = this.doc.texts.length - texts.length;
    const removedIcons = this.doc.icons.length - icons.length;
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
    this.doc.strokes = strokes;
    this.doc.texts = texts;
    this.doc.icons = icons;
    this.doc.groups = this.doc.groups.filter((x) => x.name !== name);
    this.touch();
    return { strokes: removedStrokes, texts: removedTexts, icons: removedIcons, found: true };
  }

  /** 按元素 id 删除笔迹/文本/icon（局部修正的主力：undo 粒度是整次 draw 调用，删单个元素用它）。
   *  与 replaceStrokes 同进出撤销栈；删除的 id 同时从所有分组里清理；返回各类实际删除数 */
  remove(ids: string[]): { strokes: number; texts: number; icons: number } {
    const drop = new Set(ids);
    const strokes = this.doc.strokes.filter((s) => !drop.has(s.id));
    const texts = this.doc.texts.filter((t) => !drop.has(t.id));
    const icons = this.doc.icons.filter((i) => !drop.has(i.id));
    const removedStrokes = this.doc.strokes.length - strokes.length;
    const removedTexts = this.doc.texts.length - texts.length;
    const removedIcons = this.doc.icons.length - icons.length;
    if (!removedStrokes && !removedTexts && !removedIcons) return { strokes: 0, texts: 0, icons: 0 };
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
    this.doc.strokes = strokes;
    this.doc.texts = texts;
    this.doc.icons = icons;
    // 清理分组里被删的 id；空组移除
    this.doc.groups = this.doc.groups
      .map((g) => ({
        name: g.name,
        strokeIds: g.strokeIds.filter((id) => !drop.has(id)),
        textIds: g.textIds.filter((id) => !drop.has(id)),
        iconIds: (g.iconIds ?? []).filter((id) => !drop.has(id)),
        order: g.order,
      }))
      .filter((g) => g.strokeIds.length || g.textIds.length || g.iconIds?.length);
    this.touch();
    return { strokes: removedStrokes, texts: removedTexts, icons: removedIcons };
  }

  /** 更新默认画笔/颜色/粗细（不进 undo 历史：不影响已有笔迹） */
  setPrefs(patch: { tool?: SketchTool; color?: SketchColor; size?: number }): void {
    if (patch.tool) this.doc.tool = patch.tool;
    if (patch.color) this.doc.color = patch.color;
    if (patch.size) this.doc.size = patch.size;
    // 荧光笔 + 深色墨不可见：与页面组件 selectTool 同一条变色规则
    this.doc.color = autoColor(this.doc.tool, this.doc.color);
    this.touch();
  }

  /** 撤销最近 count 次变更，返回实际撤销的次数 */
  undo(count = 1): number {
    let n = 0;
    while (n < count && this.past.length) {
      this.future.push(this.snapshot());
      const c = this.past.pop()!;
      this.doc.strokes = c.strokes;
      this.doc.texts = c.texts;
      this.doc.icons = c.icons;
      this.doc.groups = c.groups;
      n++;
    }
    if (n) this.touch();
    return n;
  }

  /** 重做 count 次，返回实际重做的次数 */
  redo(count = 1): number {
    let n = 0;
    while (n < count && this.future.length) {
      this.past.push(this.snapshot());
      const c = this.future.pop()!;
      this.doc.strokes = c.strokes;
      this.doc.texts = c.texts;
      this.doc.icons = c.icons;
      this.doc.groups = c.groups;
      n++;
    }
    if (n) this.touch();
    return n;
  }

  /** 追加 icon 元素（draw 带 icon 形状时调用，进 undo 栈） */
  addIcons(icons: SketchIcon[]): void {
    if (!icons.length) return;
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
    this.doc.icons.push(...icons);
    this.touch();
  }

  /** 清空全部内容（笔迹+文本+icon，进撤销栈可恢复） */
  clearAll(): number {
    const n = this.doc.strokes.length + this.doc.texts.length + this.doc.icons.length;
    if (!n) return 0;
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
    this.doc.strokes = [];
    this.doc.texts = [];
    this.doc.icons = [];
    this.touch();
    return n;
  }
}

export interface CanvasMeta {
  id: string;
  updatedAt: string;
  strokes: number;
}

/** 多画布存储：每个画布一个 <id>.json 文件，内存按需加载；active 是不带 id 的旧调用（页面首开/CLI 省略）默认命中的画布 */
export class CanvasStore {
  private readonly dir: string;
  private states = new Map<string, CanvasState>();
  /** 当前活动画布（新建画布会把活动指针切过去；页面/CLI 不带 id 时都落在它上面）；构造器必然赋值 */
  activeId = "";

  constructor(root: string) {
    this.dir = join(root, ".content-forge", "sketchpad");
    mkdirSync(this.dir, { recursive: true });
    this.migrateLegacy();
    const ids = fs.readdirSync(this.dir).filter(isCanvasFile).map((n) => n.slice(0, -5));
    if (ids.length === 0) {
      this.create(); // create() 会把 activeId 指向新画布
      return;
    }
    // 活动画布 = 最近更新的那个（重启后落回用户/agent 最后画的那块）
    const latest = ids
      .map((id) => ({ id, at: this.get(id)!.doc.updatedAt }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    this.activeId = latest[0].id;
  }

  /** 旧单文档 sketch.json → 迁移为以它更新时间命名的画布文件（迁移后删除旧文件） */
  private migrateLegacy(): void {
    const legacy = join(this.dir, "sketch.json");
    if (!existsSync(legacy)) return;
    try {
      const j = JSON.parse(readFileSync(legacy, "utf8")) as CanvasDoc;
      if (j.version !== 1 || !Array.isArray(j.strokes)) return;
      if (!Array.isArray(j.texts)) j.texts = [];
      if (!Array.isArray(j.groups)) j.groups = [];
      if (!Array.isArray(j.icons)) j.icons = [];
      const parsed = j.updatedAt ? new Date(j.updatedAt) : fs.statSync(legacy).mtime;
      const id = canvasId(Number.isNaN(parsed.getTime()) ? new Date() : parsed);
      writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(j));
      fs.unlinkSync(legacy);
    } catch {
      /* 坏文件按不存在处理 */
    }
  }

  /** 画布列表（按更新时间倒序）；只统计文件名合法的画布 */
  list(): CanvasMeta[] {
    return fs
      .readdirSync(this.dir)
      .filter(isCanvasFile)
      .map((n) => {
        const id = n.slice(0, -5);
        const doc = this.get(id)!.doc;
        return { id, updatedAt: doc.updatedAt, strokes: doc.strokes.length };
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** 取画布（按需从磁盘加载）；id 不存在返回 undefined */
  get(id: string): CanvasState | undefined {
    if (!/^\d{14}$/.test(id)) return undefined;
    let st = this.states.get(id);
    if (st) return st;
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as CanvasDoc;
      if (j.version !== 1 || !Array.isArray(j.strokes)) return undefined;
      if (!Array.isArray(j.texts)) j.texts = [];
      if (!Array.isArray(j.groups)) j.groups = [];
      if (!Array.isArray(j.icons)) j.icons = [];
      st = new CanvasState(file, j);
    } catch {
      return undefined;
    }
    this.states.set(id, st);
    return st;
  }

  /** 新建画布（id 秒级碰撞则 +1s 顺延），并把活动指针切过去 */
  create(): CanvasState {
    let id = canvasId();
    while (existsSync(join(this.dir, `${id}.json`))) {
      const d = new Date(
        Number(id.slice(0, 4)),
        Number(id.slice(4, 6)) - 1,
        Number(id.slice(6, 8)),
        Number(id.slice(8, 10)),
        Number(id.slice(10, 12)),
        Number(id.slice(12, 14)) + 1,
      );
      id = canvasId(d);
    }
    const st = new CanvasState(join(this.dir, `${id}.json`), blankDoc());
    st.doc.updatedAt = new Date().toISOString();
    st.replaceStrokes([]); // 落盘
    this.states.set(id, st);
    this.activeId = id;
    return st;
  }
}

/** 生成一组笔迹/文本（形状采样 + 钳制 + 属性回落），供 backend 的 /api/draw 使用：
 *  arrow 产 3 笔（主体线+两条头部短线）、dash/hatch 各产多笔，text 产出文本元素 */
export function buildStrokes(
  shape: ShapeSpec,
  index: number,
  rev: number,
  defaults: { tool: DrawTool; color: SketchColor; size: number },
  width: number,
  height: number,
): { strokes: SketchStroke[]; texts: SketchText[]; icons: SketchIcon[]; clamped: number } {
  const tool = shape.tool ?? defaults.tool;
  const color = autoColor(tool, shape.color ?? defaults.color);
  const size = shape.size ?? defaults.size;
  if (shape.shape === "text") {
    const t = {
      id: `m${rev + 1}x${index}`,
      x: clampCoord(shape.x),
      y: clampCoord(shape.y),
      size: shape.size ?? Math.round(width * 0.028),
      color: shape.color ?? defaults.color,
      text: shape.text,
    };
    return { strokes: [], texts: [t], icons: [], clamped: 0 };
  }
  // icon 形状 → 注册为 1:1 looseleaf icon 元素（不转笔迹）
  if (shape.shape === "icon") {
    const ic: SketchIcon = {
      id: `m${rev + 1}x${index}`,
      name: shape.name,
      x: clampCoord(shape.x),
      y: clampCoord(shape.y),
      size: shape.size ?? 28,
      color: shape.color ?? defaults.color,
    };
    return { strokes: [], texts: [], icons: [ic], clamped: 0 };
  }
  // stencil 先展开成原语子 shape；其他形状本身就是单子 shape
  let pointLists: SketchPoint[][];
  {
    const subs: ShapeSpec[] =
      shape.shape === "stencil"
        ? stencilBuild(shape.kind, shape.x, shape.y, shape.w, shape.h ?? shape.w * STENCIL_ASPECT[shape.kind], shape.units ?? 3)
        : [shape];
    pointLists = [];
    for (const sub of subs) pointLists.push(...resolvePointLists(sub));
  }
  let clamped = 0;
  const strokes: SketchStroke[] = pointLists.map((pts, k) => {
    clamped += clampPts(pts, width, height);
    return { id: `m${rev + 1}x${index}${k ? `k${k}` : ""}`, tool: drawToolOf(tool), color, size, pts };
  });
  return { strokes, texts: [], icons: [], clamped };
}

/** 落笔画笔不能是橡皮（橡皮只擦不画）——与 backend 的 drawTool 同规则 */
const drawToolOf = (t: DrawTool | SketchTool): DrawTool => (t === "eraser" ? "felt" : t);
