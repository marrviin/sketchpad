/**
 * 叙事回放顺序：把 (strokes, texts, icons, groups) 编排成回放揭示序列。
 * 纯函数、无 React/DOM 依赖——供 SketchpadCanvas 的 timing() 使用，也便于单测。
 * 规则：无组 → 返回 null（调用方保持旧行为：笔迹按文档顺序，文本/icon 即时显现）；
 * 有组 → 组按 (order 升序 → 无 order 靠后 → 组内首个成员的文档序 tie-break) 排序；
 * 组内按「落笔顺序」交替播放（元素 id m{rev}x{idx} 编码了 draw 批次内的形状序——
 * 文字/图标跟着它标注的元素一起出现，而不是等整组笔迹放完才淡入）；无组元素排在最后。
 */

export interface ReplayGroupLite {
  name: string
  strokeIds: string[]
  textIds: string[]
  iconIds?: string[]
  /** 叙事层级（1=画布/设备框 … 5=标注）：回放排序键，无值排最后 */
  order?: number
}

export type ReplayItem =
  | { kind: "stroke"; index: number; orderKey: number }
  | { kind: "text"; index: number; orderKey: number }
  | { kind: "icon"; index: number; orderKey: number }

/** 组与组（含进入无组尾段）之间的叙事停顿（秒） */
export const GROUP_GAP = 0.35

/** 文档序全局位置：笔迹 0..n-1，文本接后，icon 再接后——跨数组 tie-break 用 */
type Item = ReplayItem & { doc: number }

/** 落笔顺序键：draw 批次内形状序编码在元素 id 里（m{rev}x{idx}[k{n}]）；非工具批次元素无键 */
function strokeSeq(id: string): [number, number, number] | null {
  const m = /^m(\d+)x(\d+)(?:k(\d+))?$/.exec(id)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

export function replayRevealOrder(
  strokes: readonly { id: string }[],
  texts: readonly { id: string }[],
  icons: readonly { id: string }[],
  groups?: readonly ReplayGroupLite[] | null,
): ReplayItem[] | null {
  const total = strokes.length + texts.length + icons.length
  if (!total) return []
  if (!groups?.length) return null

  const sIdx = new Map(strokes.map((s, i) => [s.id, i]))
  const tIdx = new Map(texts.map((t, i) => [t.id, i]))
  const iIdx = new Map(icons.map((c, i) => [c.id, i]))
  const claimed = new Set<string>()

  interface Chunk {
    orderKey: number
    items: Item[]
    firstDoc: number
  }
  const chunks: Chunk[] = []
  const push = (items: Item[], firstDoc = Math.min(...items.map((x) => x.doc))): Chunk | null => {
    if (!items.length) return null
    const chunk: Chunk = { orderKey: items[0].orderKey, items, firstDoc }
    chunks.push(chunk)
    return chunk
  }

  for (const g of groups) {
    const key = g.order ?? Infinity
    const items: (Item & { seq: [number, number, number] | null })[] = []
    for (const id of g.strokeIds) {
      const i = sIdx.get(id)
      if (i === undefined || claimed.has(`s${i}`)) continue
      claimed.add(`s${i}`)
      items.push({ kind: "stroke", index: i, orderKey: key, doc: i, seq: strokeSeq(id) })
    }
    for (const id of g.textIds) {
      const i = tIdx.get(id)
      if (i === undefined || claimed.has(`t${i}`)) continue
      claimed.add(`t${i}`)
      items.push({ kind: "text", index: i, orderKey: key, doc: strokes.length + i, seq: strokeSeq(id) })
    }
    for (const id of g.iconIds ?? []) {
      const i = iIdx.get(id)
      if (i === undefined || claimed.has(`i${i}`)) continue
      claimed.add(`i${i}`)
      items.push({
        kind: "icon",
        index: i,
        orderKey: key,
        doc: strokes.length + texts.length + i,
        seq: strokeSeq(id),
      })
    }
    const firstDoc = items.length ? Math.min(...items.map((x) => x.doc)) : 0
    items.sort((a, b) => {
      // 有落笔键的按 (rev, 批内序) 交替；无键（非工具批次）垫后按文档序
      if (a.seq && b.seq) {
        const d = a.seq[0] - b.seq[0] || a.seq[1] - b.seq[1] || a.seq[2] - b.seq[2]
        if (d) return d
        return a.doc - b.doc
      }
      if (a.seq) return -1
      if (b.seq) return 1
      return a.doc - b.doc
    })
    push(items, firstDoc)
  }

  const tail: Item[] = []
  strokes.forEach((_, i) => {
    if (!claimed.has(`s${i}`)) tail.push({ kind: "stroke", index: i, orderKey: Infinity, doc: i })
  })
  texts.forEach((_, i) => {
    if (!claimed.has(`t${i}`)) tail.push({ kind: "text", index: i, orderKey: Infinity, doc: strokes.length + i })
  })
  icons.forEach((_, i) => {
    if (!claimed.has(`i${i}`)) tail.push({ kind: "icon", index: i, orderKey: Infinity, doc: strokes.length + texts.length + i })
  })
  push(tail)

  chunks.sort((a, b) => (a.orderKey !== b.orderKey ? a.orderKey - b.orderKey : a.firstDoc - b.firstDoc))
  return chunks.flatMap((c) => c.items.map(({ kind, index, orderKey }) => ({ kind, index, orderKey })))
}
