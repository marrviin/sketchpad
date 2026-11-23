import { drawSkeleton } from "@content-forge/ink/art-draw"
import { icons as inkIcons } from "@content-forge/ink/art/icons"
import type { ArtDef } from "@content-forge/ink/art/types"
import { strokeBounds, strokeMarkup, type SketchColor, type SketchStroke } from "@content-forge/ink/recipes/sketchpad-ink"
import { svgMaskDefs } from "@content-forge/ink/textures"

/**
 * 画布导出（用户把图拿走）：PNG / 视频共用的取景、栅格化与下载辅助。
 * 页面权威渲染是 ink 管线（笔刷质感/颗粒 mask）；导出直接复用 strokeMarkup 与
 * drawSkeleton 的产物（独立 SVG 文档内注入 grain defs），文本用手写风字体经 canvas
 * fillText 绘制——字体只存在于页面文档，独立 SVG <img> 栅格化时取不到。
 * 层序与页面一致：文本 < 图标 < 笔迹。
 */

export interface SketchpadExportDoc {
  width: number
  height: number
  strokes: readonly SketchStroke[]
  texts: readonly { id: string; x: number; y: number; size: number; color: SketchColor; text: string }[]
  icons: readonly { id: string; name: string; x: number; y: number; size: number; color: SketchColor }[]
}

/** 手写风字体（与 sketchpad.tsx / snapshot 渲染器同族） */
const TEXT_FONT = '"LXGW WenKai Lite", "Kaiti SC", "STKaiti", serif'
const TEXT_BASELINE_K = 0.78
/** 取景边距（世界坐标 px） */
const REGION_MARGIN = 48

/** 导出取景：内容包围盒 ∪ 首页画框，外扩边距；aspect 给定时外扩到固定比例（如 16/9） */
export function exportRegion(doc: SketchpadExportDoc, o?: { aspect?: number }): { x0: number; y0: number; w: number; h: number } {
  let bx0 = 0
  let by0 = 0
  let bx1 = doc.width
  let by1 = doc.height
  for (const s of doc.strokes) {
    const b = strokeBounds(s)
    bx0 = Math.min(bx0, b[0])
    by0 = Math.min(by0, b[1])
    bx1 = Math.max(bx1, b[2])
    by1 = Math.max(by1, b[3])
  }
  for (const t of doc.texts) {
    bx0 = Math.min(bx0, t.x)
    by0 = Math.min(by0, t.y)
    bx1 = Math.max(bx1, t.x + t.text.length * t.size * 1.05 + t.size)
    by1 = Math.max(by1, t.y + t.size)
  }
  for (const ic of doc.icons) {
    bx0 = Math.min(bx0, ic.x)
    by0 = Math.min(by0, ic.y)
    bx1 = Math.max(bx1, ic.x + ic.size)
    by1 = Math.max(by1, ic.y + ic.size)
  }
  const region = { x0: bx0 - REGION_MARGIN, y0: by0 - REGION_MARGIN, w: bx1 - bx0 + 2 * REGION_MARGIN, h: by1 - by0 + 2 * REGION_MARGIN }
  // 固定输出比例（如 16:9）：短边以内容包围盒中心对称外扩，内容保持居中
  if (o?.aspect && region.w > 0 && region.h > 0) {
    const ar = region.w / region.h
    if (ar < o.aspect) {
      const nw = region.h * o.aspect
      region.x0 -= (nw - region.w) / 2
      region.w = nw
    } else if (ar > o.aspect) {
      const nh = region.w / o.aspect
      region.y0 -= (nh - region.h) / 2
      region.h = nh
    }
  }
  return region
}

export type CssVarResolve = (name: string) => string | undefined

export const resolveFromRoot = (): CssVarResolve => {
  if (typeof getComputedStyle === "undefined") return () => undefined
  const s = getComputedStyle(document.documentElement)
  return (name) => s.getPropertyValue(name).trim() || undefined
}

/** 命名色 → hex（resolve 不到时的兜底与 sketchpad snapshot 渲染器 PALETTE 同值） */
const FALLBACK_INK = "#2a2420"
export function colorHex(color: SketchColor, resolve: CssVarResolve): string {
  return resolve(`--ll-${color}`) ?? FALLBACK_INK
}

export function paperHex(resolve: CssVarResolve): string {
  return resolve("--ll-paper") ?? "#f8f5ee"
}

/** SVG data URL → Image（像素 w×h）；失败/超时返回 null（大画布 hi 档栅格化可到秒级，超时给足余量） */
export function rasterSvg(svg: string, w: number, h: number, timeoutMs = 15000): Promise<HTMLImageElement | null> {
  return new Promise((done) => {
    if (typeof document === "undefined" || typeof Image === "undefined") return done(null)
    const img = new Image()
    const giveUp = setTimeout(() => done(null), timeoutMs)
    img.onload = () => {
      clearTimeout(giveUp)
      done(img)
    }
    img.onerror = () => {
      clearTimeout(giveUp)
      done(null)
    }
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

/** 页面同款 icon 变换（bbox 中心对齐目标盒中心）产物 → 独立 SVG（currentColor 由 style.color 落色） */
export function iconMarkup(name: string, ic: { x: number; y: number; size: number }, color: string): string | null {
  try {
    const def = (inkIcons as Record<string, ArtDef>)[name]
    if (!def) return null
    const res = drawSkeleton(def, 64, name, { kind: "icon" })
    const [b0, b1, b2, b3] = res.bbox
    const cx = (b0 / 64 + b2 / 64) / 2
    const cy = (b1 / 64 + b3 / 64) / 2
    const tx = ic.x + ic.size / 2 - cx * ic.size
    const ty = ic.y + ic.size / 2 - cy * ic.size
    return `<g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${(ic.size / 64).toFixed(4)})" style="color:${color}">${res.svg}</g>`
  } catch {
    return null
  }
}

/** 导出根 SVG：grain defs + 图标 + 笔迹（透明底；纸底/文本由调用方在 canvas 上画，保证文本层在笔迹下） */
export function exportStrokesSvg(doc: SketchpadExportDoc, region: { x0: number; y0: number; w: number; h: number }, scale: number, resolve: CssVarResolve, background?: string): string {
  const parts = background ? [`<rect x="${region.x0.toFixed(1)}" y="${region.y0.toFixed(1)}" width="${region.w.toFixed(1)}" height="${region.h.toFixed(1)}" fill="${background}"/>`] : []
  const iconEls = doc.icons.map((ic) => iconMarkup(ic.name, ic, colorHex(ic.color, resolve))).filter(Boolean)
  if (iconEls.length) parts.push(...(iconEls as string[]))
  for (const s of doc.strokes) {
    parts.push(`<g data-stroke="${s.id}">${strokeMarkup(s, { tier: "hi" }).svg}</g>`)
  }
  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${region.x0.toFixed(1)} ${region.y0.toFixed(1)} ${region.w.toFixed(1)} ${region.h.toFixed(1)}" ` +
    `width="${Math.round(region.w * scale)}" height="${Math.round(region.h * scale)}">` +
    `<defs>${svgMaskDefs({})}</defs>` +
    parts.join("") +
    `</svg>`
  svg = svg.replace(/var\((--ll-[a-z0-9-]+)\)/g, (whole, name) => resolve(name) ?? whole)
  return svg
}

/** 文本层（canvas fillText；字体需已在页面文档加载） */
export function drawTexts(
  ctx: CanvasRenderingContext2D,
  texts: SketchpadExportDoc["texts"],
  resolve: CssVarResolve,
  alphaOf?: (i: number) => number,
): void {
  ctx.textAlign = "left"
  ctx.textBaseline = "alphabetic"
  ctx.fillStyle = FALLBACK_INK
  ctx.font = `16px ${TEXT_FONT}`
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]
    const a = alphaOf?.(i) ?? 1
    if (a <= 0) continue
    ctx.globalAlpha = a
    ctx.fillStyle = colorHex(t.color, resolve)
    ctx.font = `${t.size}px ${TEXT_FONT}`
    ctx.fillText(t.text, t.x, t.y + t.size * TEXT_BASELINE_K)
  }
  ctx.globalAlpha = 1
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** 文件名时间戳：sketchpad-20261123-153045 */
export function exportStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export interface ExportPngOptions {
  /** CSS 变量解析（默认 documentElement 上读 --ll-*） */
  resolve?: CssVarResolve
  /** 像素/世界 比，默认 2，长边上限 2400 */
  scale?: number
}

/** 导出 PNG（16:9）：canvas 画纸底+文本 → SVG（图标+笔迹，透明底）栅格化后贴上 → Blob */
export async function exportSketchPng(doc: SketchpadExportDoc, o: ExportPngOptions = {}): Promise<Blob | null> {
  const resolve = o.resolve ?? resolveFromRoot()
  const region = exportRegion(doc, { aspect: 16 / 9 })
  const scale = o.scale ?? Math.min(2, 2400 / Math.max(region.w, region.h))
  const img = await rasterSvg(exportStrokesSvg(doc, region, scale, resolve), Math.round(region.w * scale), Math.round(region.h * scale))
  if (!img) return null
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(region.w * scale)
  // 取景已是 16:9，像素高按宽度回算并四舍五入（±1px 以内的取整误差可忽略）
  canvas.height = Math.round((canvas.width * 9) / 16)
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  try {
    await document.fonts.load(`16px ${TEXT_FONT.split(",")[0]}`)
  } catch {
    /* 字体加载失败用回退字体 */
  }
  // 层序与页面一致：纸底 < 文本 < 图标/笔迹（后两者在透明底栅格图里）
  const k = scale
  ctx.fillStyle = paperHex(resolve)
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(k, 0, 0, k, -region.x0 * k, -region.y0 * k)
  drawTexts(ctx, doc.texts, resolve)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob | null>((done) => canvas.toBlob((b) => done(b), "image/png"))
}

/** SVG data URL → PNG data URL（供 SketchpadHandle.toPNG 复用） */
export function svgToPngDataUrl(svgDataUrl: string, width: number, height: number, scale = 2): Promise<string | null> {
  return new Promise((done) => {
    if (typeof document === "undefined" || typeof Image === "undefined") return done(null)
    const img = new Image()
    const giveUp = setTimeout(() => done(null), 4000)
    img.onload = () => {
      clearTimeout(giveUp)
      try {
        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        const g = canvas.getContext("2d")
        if (!g) return done(null)
        g.drawImage(img, 0, 0, canvas.width, canvas.height)
        done(canvas.toDataURL("image/png"))
      } catch {
        done(null)
      }
    }
    img.onerror = () => {
      clearTimeout(giveUp)
      done(null)
    }
    img.src = svgDataUrl
  })
}

