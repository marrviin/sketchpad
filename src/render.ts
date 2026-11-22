/**
 * sketchpad 快照渲染器：把画布笔迹渲染成 SVG（供 snapshot 工具栅格化成 PNG 给 agent 自查）。
 * 页面的权威渲染是 looseleaf ink 管线（@content-forge/ink，笔刷质感/颗粒/压力）；
 * 这里是轻量镜像——只用折线 + 圆帽表达笔迹几何与颜色，够 agent 判断"画得像不像"，
 * 不追求笔刷质感一致。色板值镜像 web/src/looseleaf.css 亮色主题的 --ll-* 变量。
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { SketchColor, SketchPoint, SketchStroke, SketchText } from "./contract.js";
import iconBundle from "./icon-bundle.json" with { type: "json" };

/** 1:1 looseleaf icon 渲染：defs 一次注入 + 每个 icon 按 glyph bbox 中心定位。
 *  icon SVG 内 fill="currentColor"，用 style.color 套到 PALETTE 色值。
 *  bundle svg 坐标系 = drawSkeleton(def, 64) 的 64 盒；bbox 归一化 0..1。
 *  glyph 不满铺（各 icon bbox 不同），按 bbox 中心对齐目标盒中心才真居中。
 *  defs 来自 inkDefsSvg 的 <svg width=0><defs>…</defs></svg> 壳——resvg 不读嵌套
 *  svg 里的 defs，必须剥壳只留 <defs> 内层（页面 DOM 无此问题）。 */
const _bundle = iconBundle as unknown as IconBundle;
const ICON_DEFS = (_bundle.defs.match(/<defs>[\s\S]*<\/defs>/)?.[0] ?? _bundle.defs);
const ICON_SVGS = _bundle.icons;

interface IconBundle {
  defs: string;
  icons: Record<string, { svg: string; bbox: [number, number, number, number] }>;
}

type IconShape = { id: string; name: string; x: number; y: number; size: number; color: SketchColor };

function iconEls(icons: readonly IconShape[]): string[] {
  return icons.map((ic) => {
    const entry = ICON_SVGS[ic.name];
    if (!entry) return "";
    const color = PALETTE[ic.color] ?? PALETTE.ink;
    const k = ic.size / 64;
    // bbox 为 64 盒绝对坐标(res.bbox 原样)→ glyph 中心 = tx + cx·k 对齐目标盒中心
    const [b0, b1, b2, b3] = entry.bbox;
    const cx = (b0 + b2) / 2;
    const cy = (b1 + b3) / 2;
    const tx = ic.x + ic.size / 2 - cx * k;
    const ty = ic.y + ic.size / 2 - cy * k;
    return `<g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${k.toFixed(3)})" style="color:${color}">${entry.svg}</g>`;
  });
}

/** 手写风字体（页面 @font-face 与 snapshot resvg 用同一 TTF，两端渲染一致） */
export const FONT_FAMILY = "LXGW WenKai Lite";

/** 字体文件路径：单份落在包根 fonts/，页面 @font-face 与 snapshot resvg 共用同一 TTF */
export function resolveFontFile(): string | null {
  const file = fileURLToPath(new URL("../fonts/LXGWWenKaiLite-Regular.ttf", import.meta.url));
  return existsSync(file) ? file : null;
}

/** 命名色板 → hex（镜像 looseleaf.css 亮色主题；页面上由 --ll-* CSS 变量解析） */
const PALETTE: Record<SketchColor, string> = {
  ink: "#2a2420",
  "ink-you": "#2c4f9e",
  red: "#c2412d",
  green: "#3b7a4b",
  marker: "#df6b3c",
  tangerine: "#f59a2f",
  hi: "#f8dc4c",
  teal: "#2fb1a3",
  grape: "#8f6fd6",
  bubblegum: "#f38bb8",
};

const PAPER = "#f8f5ee";

/** 画笔基准线宽与不透明度（近似页面观感；页面权威值在 sketchpad-ink.ts 的 TOOL_PEN × pen.W） */
export const TOOL_STYLE: Record<SketchStroke["tool"], { w: number; alpha: number }> = {
  felt: { w: 2.2, alpha: 1 },
  brush: { w: 3.2, alpha: 1 },
  pencil: { w: 1.6, alpha: 0.85 },
  marker: { w: 6, alpha: 0.92 },
  highlighter: { w: 15, alpha: 0.38 },
};

/** 丢弃近重复点 + 折线中点二次贝塞尔平滑（渲染用，不改存储的点列） */
function smoothPath(pts: readonly SketchPoint[]): string {
  const kept: [number, number][] = [];
  for (const p of pts) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.8) kept.push([p[0], p[1]]);
  }
  if (kept.length === 0) return "";
  if (kept.length === 1) {
    const [x, y] = kept[0];
    return `M${x.toFixed(1)} ${y.toFixed(1)}l.01 0`;
  }
  const f = (n: number): string => n.toFixed(1);
  let d = `M${f(kept[0][0])} ${f(kept[0][1])}`;
  for (let i = 1; i < kept.length - 1; i++) {
    const mx = (kept[i][0] + kept[i + 1][0]) / 2;
    const my = (kept[i][1] + kept[i + 1][1]) / 2;
    d += `Q${f(kept[i][0])} ${f(kept[i][1])} ${f(mx)} ${f(my)}`;
  }
  const last = kept[kept.length - 1];
  d += `L${f(last[0])} ${f(last[1])}`;
  return d;
}

/** 文本元素 → SVG <text>（与页面同一近似基线 y + size*0.78；文字渲染在笔迹下层） */
function textEls(texts: readonly SketchText[]): string[] {
  return texts.map((t) => {
    const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return (
      `<text x="${t.x.toFixed(1)}" y="${(t.y + t.size * 0.78).toFixed(1)}" ` +
      `font-family="${FONT_FAMILY}" font-size="${t.size}" fill="${PALETTE[t.color] ?? PALETTE.ink}">${esc(t.text)}</text>`
    );
  });
}

/** 元素包围盒是否与取景区相交。resvg 2.6.2 在「viewBox 原点非零 + 元素整体在视口外 +
 *  组透明度 <1」时会 panic（geom.rs unwrap），region 模式下必须剔除完全在区外的元素 */
function intersectsRegion(
  x0: number, y0: number, x1: number, y1: number,
  reg: { x0: number; y0: number; w: number; h: number },
): boolean {
  return x1 >= reg.x0 && y1 >= reg.y0 && x0 <= reg.x0 + reg.w && y0 <= reg.y0 + reg.h;
}

/** 画布文档 → SVG 文本（含纸底色；transparent=true 去掉底色矩形）。
 *  region 给定时按该世界坐标区域取景（viewBox/底色矩形/尺寸都用它），否则按首页画框。
 *  参数取结构子集（width/height/strokes/texts），调用方可以直接传后端返回的 doc JSON。 */
export function renderDocSvg(
  doc: { width: number; height: number; strokes: readonly SketchStroke[]; texts?: readonly SketchText[]; icons?: readonly { id: string; name: string; x: number; y: number; size: number; color: SketchColor }[] },
  o: { transparent?: boolean; region?: { x0: number; y0: number; w: number; h: number } } = {},
): string {
  const reg = o.region ?? { x0: 0, y0: 0, w: doc.width, h: doc.height };
  const f = (n: number): string => n.toFixed(1);
  const parts: string[] = [];
  if (!o.transparent) {
    parts.push(`<rect x="${f(reg.x0)}" y="${f(reg.y0)}" width="${f(reg.w)}" height="${f(reg.h)}" fill="${PAPER}"/>`);
  }
  // icon 真实 SVG（defs 一次注入）
  if (doc.icons?.length) {
    parts.push(ICON_DEFS);
    parts.push(...iconEls(doc.icons));
  }
  for (const t of doc.texts ?? []) {
    // CJK ≈ 1em/字估宽；与快照取景同一近似
    const w = t.text.length * t.size * 1.05 + t.size;
    if (o.region && !intersectsRegion(t.x, t.y, t.x + w, t.y + t.size, reg)) continue;
    parts.push(textEls([t])[0]);
  }
  for (const s of doc.strokes) {
    const st = TOOL_STYLE[s.tool] ?? TOOL_STYLE.felt;
    const w = st.w * s.size;
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (const p of s.pts) {
      sx0 = Math.min(sx0, p[0]); sy0 = Math.min(sy0, p[1]);
      sx1 = Math.max(sx1, p[0]); sy1 = Math.max(sy1, p[1]);
    }
    if (o.region && !intersectsRegion(sx0 - w / 2, sy0 - w / 2, sx1 + w / 2, sy1 + w / 2, reg)) continue;
    const d = smoothPath(s.pts);
    if (!d) continue;
    parts.push(
      `<path d="${d}" fill="none" stroke="${PALETTE[s.color] ?? PALETTE.ink}" stroke-width="${w.toFixed(2)}" ` +
        `stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${st.alpha}"/>`,
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(reg.x0)} ${f(reg.y0)} ${f(reg.w)} ${f(reg.h)}" ` +
    `width="${Math.round(reg.w)}" height="${Math.round(reg.h)}">${parts.join("")}</svg>`
  );
}
