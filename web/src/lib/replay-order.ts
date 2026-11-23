/**
 * 叙事回放顺序：把 (strokes, texts, icons, groups) 编排成回放揭示序列。
 * 纯函数、无 React/DOM 依赖——供 SketchpadCanvas 的 timing() 使用，也便于单测。
 * 规则：无组 → 返回 null（调用方保持旧行为：笔迹按文档顺序，文本/icon 即时显现）；
 * 有组 → 组按 (order 升序 → 无 order 靠后 → 组内首个成员的文档序 tie-break) 排序；
 * 组内先笔迹、后文本、再 icon（各按文档顺序）；无组元素排在最后。
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
  const push = (items: Item[]): Chunk | null => {
    if (!items.length) return null
    const chunk: Chunk = { orderKey: items[0].orderKey, items, firstDoc: Math.min(...items.map((x) => x.doc)) }
    chunks.push(chunk)
    return chunk
  }

  for (const g of groups) {
    const key = g.order ?? Infinity
    const items: Item[] = []
    for (const id of g.strokeIds) {
      const i = sIdx.get(id)
      if (i === undefined || claimed.has(`s${i}`)) continue
      claimed.add(`s${i}`)
      items.push({ kind: "stroke", index: i, orderKey: key, doc: i })
    }
    for (const id of g.textIds) {
      const i = tIdx.get(id)
      if (i === undefined || claimed.has(`t${i}`)) continue
      claimed.add(`t${i}`)
      items.push({ kind: "text", index: i, orderKey: key, doc: strokes.length + i })
    }
    for (const id of g.iconIds ?? []) {
      const i = iIdx.get(id)
      if (i === undefined || claimed.has(`i${i}`)) continue
      claimed.add(`i${i}`)
      items.push({ kind: "icon", index: i, orderKey: key, doc: strokes.length + texts.length + i })
    }
    push(items)
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
