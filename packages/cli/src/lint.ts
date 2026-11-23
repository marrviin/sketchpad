/**
 * sketchpad lint：画布几何自查。snapshot 只能目测 PNG，lint 把「画得不好」的可计算信号
 * （文字重叠、文字压线、内容出框）变成结构化清单，agent 拿着 id 直接改——
 * 与叙事 order 一样构成 agent 工具闭环，质量不再只靠模型自觉。
 */
import type { SketchIcon, SketchStroke, SketchText } from "./contract.js";

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LintIssue {
  kind:
    | "text-overlap"
    | "text-cross-border"
    | "text-outside-frame"
    | "stroke-outside-frame"
    | "text-icon-overlap"
    | "narrative-no-order"
    | "narrative-coarse"
    | "narrative-mixed";
  severity: "error" | "warn" | "info";
  msg: string;
  ids: string[];
}

/** 文本包围盒（LXGW 近似：CJK ≈ 1em，latin ≈ 0.55em；行高 1.15em） */
function textBox(t: SketchText): Box {
  let em = 0;
  for (const ch of t.text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x2e80) em += 1;
    else if (ch === " ") em += 0.35;
    else if (/[A-Z0-9@#%&_MW]/.test(ch)) em += 0.72;
    else em += 0.55;
  }
  return { x0: t.x, y0: t.y, x1: t.x + em * t.size, y1: t.y + t.size * 1.15 };
}

function iconBox(ic: SketchIcon): Box {
  return { x0: ic.x, y0: ic.y, x1: ic.x + ic.size, y1: ic.y + ic.size };
}

function strokeBox(s: SketchStroke): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of s.pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return { x0, y0, x1, y1 };
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 线段是否穿过矩形内部（Liang-Barsky） */
function segCrossBox(p: [number, number], q: [number, number], b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const checks: [number, number][] = [
    [-dx, p[0] - b.x0],
    [dx, b.x1 - p[0]],
    [-dy, p[1] - b.y0],
    [dy, b.y1 - p[1]],
  ];
  for (const [den, num] of checks) {
    if (den === 0) {
      if (num < 0) return false;
    } else {
      const t = num / den;
      if (den < 0) {
        t1 = Math.min(t1, t);
      } else {
        t0 = Math.max(t0, t);
      }
      if (t0 > t1) return false;
    }
  }
  return true;
}

export function lintDoc(doc: {
  width: number;
  height: number;
  strokes: SketchStroke[];
  texts: SketchText[];
  icons?: SketchIcon[];
  groups?: { name: string; strokeIds: string[]; textIds: string[]; iconIds?: string[]; order?: number }[];
}): LintIssue[] {
  const issues: LintIssue[] = [];
  const texts = doc.texts ?? [];
  if (texts.length === 0 && doc.strokes.length === 0) {
    issues.push({ kind: "stroke-outside-frame", severity: "info", msg: "画布是空的", ids: [] });
    return issues;
  }
  const FRAME = { x0: 0, y0: 0, x1: doc.width, y1: doc.height };

  // 1. 文本互相重叠
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = textBox(texts[i]);
      const b = textBox(texts[j]);
      const area = overlapArea(a, b);
      const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
      if (smaller > 0 && area / smaller > 0.18) {
        issues.push({
          kind: "text-overlap",
          severity: "warn",
          msg: `文本「${texts[i].text.slice(0, 12)}」与「${texts[j].text.slice(0, 12)}」重叠 ${Math.round((area / smaller) * 100)}%`,
          ids: [texts[i].id, texts[j].id],
        });
      }
    }
  }

  // 2. 文本压线：笔迹线段穿过文本包围盒内部，且该笔迹不是包住它的容器
  for (const t of texts) {
    const tb = textBox(t);
    const tbIn = { x0: tb.x0 + 3, y0: tb.y0 + 3, x1: tb.x1 - 3, y1: tb.y1 - 3 };
    for (const s of doc.strokes) {
      const sb = strokeBox(s);
      if (!overlapArea(sb, tbIn)) continue;
      // 容器（盒/框）包围文本 → 是标签贴在框内，正常
      const contains =
        sb.x0 <= tb.x0 - 6 && sb.y0 <= tb.y0 - 6 && sb.x1 >= tb.x1 + 6 && sb.y1 >= tb.y1 + 6;
      if (contains) continue;
      // 容器边缘正好在文本外 6px 内也放过（标签贴边是常见画法）
      const near =
        sb.x0 >= tb.x1 - 2 || sb.x1 <= tb.x0 + 2 || sb.y0 >= tb.y1 - 2 || sb.y1 <= tb.y0 + 2;
      if (near) continue;
      let cross = false;
      for (let k = 1; k < s.pts.length && !cross; k++) {
        const a = s.pts[k - 1];
        const b = s.pts[k];
        cross = segCrossBox([a[0], a[1]], [b[0], b[1]], tbIn);
      }
      if (cross) {
        issues.push({
          kind: "text-cross-border",
          severity: "warn",
          msg: `文本「${t.text.slice(0, 12)}」被笔迹划过（可能压在框线/箭头上）`,
          ids: [t.id, s.id],
        });
        break;
      }
    }
  }

  // 3. 文本 / icon 出首页画框（info：框外可能是有意画延伸内容）
  for (const t of texts) {
    const b = textBox(t);
    if (b.x1 > FRAME.x1 + 8 || b.y1 > FRAME.y1 + 8 || b.x0 < FRAME.x0 - 8 || b.y0 < FRAME.y0 - 8) {
      issues.push({
        kind: "text-outside-frame",
        severity: "info",
        msg: `文本「${t.text.slice(0, 12)}」超出首页画框`,
        ids: [t.id],
      });
    }
  }
  for (const ic of doc.icons ?? []) {
    const b = iconBox(ic);
    if (b.x1 > FRAME.x1 + 8 || b.y1 > FRAME.y1 + 8 || b.x0 < FRAME.x0 - 8) {
      issues.push({ kind: "text-outside-frame", severity: "info", msg: `icon 超出首页画框`, ids: [ic.id] });
    }
  }
  for (const ic of doc.icons ?? []) {
    const ib = iconBox(ic);
    for (const t of texts) {
      const tb = textBox(t);
      if (overlapArea(ib, tb) > 0.25 * Math.min((ib.x1 - ib.x0) * (ib.y1 - ib.y0), (tb.x1 - tb.x0) * (tb.y1 - tb.y0))) {
        issues.push({
          kind: "text-icon-overlap",
          severity: "warn",
          msg: `icon 与文本「${t.text.slice(0, 12)}」重叠`,
          ids: [ic.id, t.id],
        });
        break;
      }
    }
  }

  // 4. 笔迹大幅出框（可能忘了收敛取景）
  let stray = 0;
  const strayIds: string[] = [];
  for (const s of doc.strokes) {
    const b = strokeBox(s);
    if (b.x1 > FRAME.x1 + 40 || b.y1 > FRAME.y1 + 40 || b.x0 < FRAME.x0 - 40) {
      stray++;
      if (strayIds.length < 6) strayIds.push(s.id);
    }
  }
  if (stray > 0) {
    issues.push({
      kind: "stroke-outside-frame",
      severity: "info",
      msg: `${stray} 条笔迹明显超出首页画框（若非有意的框外延伸，考虑重画或调整取景）`,
      ids: strayIds,
    });
  }

  // 5. 叙事体检：回放讲故事的质量信号（建议级，不影响画面正确性）。组员只数仍存在的元素——
  //    历史清除/擦除可能留下陈旧 id，统计口径以画布实际内容为准
  const strokeIds = new Set(doc.strokes.map((s) => s.id));
  const textIds = new Set(texts.map((t) => t.id));
  const iconIds = new Set((doc.icons ?? []).map((c) => c.id));
  const alive = (g: { strokeIds: string[]; textIds: string[]; iconIds?: string[] }) => ({
    strokes: g.strokeIds.filter((id) => strokeIds.has(id)),
    texts: g.textIds.filter((id) => textIds.has(id)),
    icons: (g.iconIds ?? []).filter((id) => iconIds.has(id)),
  });
  const groups = (doc.groups ?? [])
    .map((g) => ({ g, m: alive(g) }))
    .filter((x) => x.m.strokes.length || x.m.texts.length || x.m.icons.length);
  if (groups.length) {
    const noOrder = groups.filter((x) => x.g.order === undefined);
    if (noOrder.length) {
      issues.push({
        kind: "narrative-no-order",
        severity: "info",
        msg: `${noOrder.length} 个组未设叙事层级（${noOrder.map((x) => `「${x.g.name}」`).join("，").slice(0, 80)}），回放垫底——用 sketchpad order 修序`,
        ids: [],
      });
    }
    const totalElems = doc.strokes.length + texts.length + (doc.icons?.length ?? 0);
    const big = groups
      .map((x) => ({ g: x.g, n: x.m.strokes.length + x.m.texts.length + x.m.icons.length }))
      .filter((x) => x.g.strokeIds.length > 12 && x.n > totalElems * 0.6)
      .sort((a, b) => b.n - a.n)[0];
    if (big) {
      issues.push({
        kind: "narrative-coarse",
        severity: "warn",
        msg: `叙事粒度过粗：组「${big.g.name}」吞掉了 ${big.m.strokes.length + big.m.texts.length + big.m.icons.length} 个元素（约占全部 ${Math.round((big.n / Math.max(totalElems, 1)) * 100)}%），回放一幕播完没有节奏——按结构批拆成多个组（如逐节点/逐分区）`,
        ids: [],
      });
    }
    const mixed = groups.filter((x) => (x.g.order ?? 0) >= 4 && x.m.strokes.length > 6);
    if (mixed.length) {
      issues.push({
        kind: "narrative-mixed",
        severity: "warn",
        msg: `组（${mixed.map((x) => `「${x.g.name}」`).join("，").slice(0, 80)}）在标注层级（order≥4）却带着大量笔迹——像是结构混进了标注层，考虑拆组并把结构降到 order 3`,
        ids: [],
      });
    }
  }
  return issues;
}
