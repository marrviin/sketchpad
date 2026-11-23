import { Muxer, ArrayBufferTarget } from "mp4-muxer"
import { drawSkeleton } from "@content-forge/ink/art-draw"
import { icons as inkIcons } from "@content-forge/ink/art/icons"
import type { ArtDef } from "@content-forge/ink/art/types"
import { strokeMarkup, type SketchStroke } from "@content-forge/ink/recipes/sketchpad-ink"
import { svgMaskDefs } from "@content-forge/ink/textures"
import { buildReplayTimeline, replayRevealOrder, type ReplayGroupLite } from "./replay-order"
import {
  colorHex,
  downloadBlob,
  drawTexts,
  exportRegion,
  exportStamp,
  paperHex,
  rasterSvg,
  resolveFromRoot,
  type CssVarResolve,
  type SketchpadExportDoc,
} from "./sketch-export"

/**
 * 叙事回放 → 视频导出：按 buildReplayTimeline 的确定性时间轴逐帧合成到离屏 canvas。
 * 主路径为 WebCodecs VideoEncoder 逐帧编码（渲染与时间戳完全确定，输出恒为 30fps
 * 逐笔动画，且导出速度不受实时播放限制）；WebCodecs 不可用时回退 MediaRecorder
 * 实时录制（captureStream 可能因逐帧合成耗时丢帧，输出有效帧率下降）。
 * 逐元素预栅格化（每笔一次 SVG→Image），帧循环内只做 drawImage + dash 合成。
 */

const FPS = 30
/** 与页面查看器一致的回放倍速（sketchpad.tsx replaySpeed） */
const REPLAY_SPEED = 8
const HOLD_MS = 400

/** 工具 → grain 种类（镜像 sketchpad-ink 的 TOOL_GRAIN；highlighter 无颗粒） */
const TOOL_GRAIN: Record<string, "felt" | "graphite" | "marker" | null> = {
  felt: "felt",
  brush: "felt",
  pencil: "graphite",
  marker: "marker",
  highlighter: null,
}

/** 页面 StrokeShape 同款：笔迹几何线宽与揭示 mask 线宽 */
const strokeWidthOf = (s: SketchStroke): number => (s.tool === "highlighter" ? 14 : s.tool === "marker" ? 8 : 3.4) * s.size
const maskWidthOf = (s: SketchStroke): number => Math.max(8, strokeWidthOf(s) * 1.6 + 6)

interface StrokeAsset {
  img: HTMLImageElement | null
  box: [number, number, number, number]
  path: Path2D
  len: number
  maskW: number
  color: string
  fallback: SketchStroke["pts"]
}

interface IconAsset {
  img: HTMLImageElement | null
  /** 栅格化覆盖的 64 盒范围（含 pad） */
  box64: [number, number, number, number]
  /** 真实 glyph bbox（64 盒，页面变换用它做中心对齐） */
  bbox: [number, number, number, number]
}

interface VideoDoc extends SketchpadExportDoc {
  groups?: readonly ReplayGroupLite[]
}

export interface ExportVideoOptions {
  resolve?: CssVarResolve
  onProgress?: (p: number) => void
}

const easeOut = (p: number): number => 1 - (1 - p) * (1 - p) * (1 - p)

async function loadFont(): Promise<void> {
  try {
    await document.fonts.load('16px "LXGW WenKai Lite"')
  } catch {
    /* 回退字体 */
  }
}

export async function exportSketchVideo(doc: VideoDoc, o: ExportVideoOptions = {}): Promise<{ blob: Blob; ext: string }> {
  const resolve = o.resolve ?? resolveFromRoot()
  await loadFont()

  const region = exportRegion(doc, { aspect: 16 / 9 })
  const scale = Math.max(0.3, Math.min(2, 1920 / Math.max(region.w, region.h)))
  // avc 要求宽高为偶数；取景已是 16:9，像素高按宽度回算保证严格 16:9
  const pxW = Math.max(2, Math.round((region.w * scale) / 2) * 2)
  const pxH = Math.max(2, Math.round(((pxW * 9) / 16) / 2) * 2)

  // 逐笔预栅格化：独立 SVG（注入对应 grain defs）→ Image，box 与 viewBox 对齐
  const strokeAssets: StrokeAsset[] = []
  for (const s of doc.strokes) {
    const m = strokeMarkup(s, { tier: "hi" })
    const pad = 8
    const [bx0, by0, bx1, by1] = m.bbox
    const x0 = bx0 - pad
    const y0 = by0 - pad
    const w = bx1 - bx0 + 2 * pad
    const h = by1 - by0 + 2 * pad
    const grain = TOOL_GRAIN[s.tool]
    let svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}">` +
      (grain ? `<defs>${svgMaskDefs({ kinds: [grain] })}</defs>` : "") +
      m.svg +
      `</svg>`
    svg = svg.replace(/var\((--ll-[a-z0-9-]+)\)/g, (whole, name) => resolve(name) ?? whole)
    strokeAssets.push({
      img: await rasterSvg(svg, Math.round(w * scale), Math.round(h * scale)),
      box: [x0, y0, w, h],
      path: new Path2D(m.centre),
      len: m.length + 1,
      maskW: maskWidthOf(s),
      color: colorHex(s.color, resolve),
      fallback: s.pts,
    })
  }

  // icon 预栅格化（同名共享一份）
  const iconAssets = new Map<string, IconAsset>()
  for (const ic of doc.icons) {
    if (iconAssets.has(ic.name)) continue
    let asset: IconAsset = { img: null, box64: [0, 0, 64, 64], bbox: [0, 0, 64, 64] }
    try {
      const def = (inkIcons as Record<string, ArtDef>)[ic.name]
      if (def) {
        const res = drawSkeleton(def, 64, ic.name, { kind: "icon" })
        const [b0, b1, b2, b3] = res.bbox
        const pad = 2
        const x0 = b0 - pad
        const y0 = b1 - pad
        const w = b2 - b0 + 2 * pad
        const h = b3 - b1 + 2 * pad
        let svg =
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" style="color:${colorHex(ic.color, resolve)}">` +
          `<defs>${svgMaskDefs({})}</defs>` +
          res.svg +
          `</svg>`
        svg = svg.replace(/var\((--ll-[a-z0-9-]+)\)/g, (whole, name) => resolve(name) ?? whole)
        asset = { img: await rasterSvg(svg, Math.round(w * scale), Math.round(h * scale)), box64: [x0, y0, w, h], bbox: res.bbox }
      }
    } catch {
      /* 未知 icon 留空 */
    }
    iconAssets.set(ic.name, asset)
  }

  // 时间轴（与页面回放 buildReplayTimeline 同编排）
  const lengths = doc.strokes.map((s) => strokeMarkup(s, { tier: "hi" }).length)
  const timing = buildReplayTimeline(
    replayRevealOrder(doc.strokes, doc.texts, doc.icons, doc.groups ?? null),
    { strokes: doc.strokes.length, texts: doc.texts.length, icons: doc.icons.length },
    (i) => Math.min(2.4, Math.max(0.14, lengths[i] / (420 * REPLAY_SPEED))),
  )
  const end = timing.end + HOLD_MS / 1000
  const totalFrames = Math.ceil(end * FPS)

  const canvas = document.createElement("canvas")
  canvas.width = pxW
  canvas.height = pxH
  const ctx = canvas.getContext("2d")
  const off = document.createElement("canvas")
  off.width = pxW
  off.height = pxH
  const octx = off.getContext("2d")
  if (!ctx || !octx) throw new Error("canvas 2d 不可用")

  const paper = paperHex(resolve)
  const worldTransform = (c: CanvasRenderingContext2D): void => c.setTransform(scale, 0, 0, scale, -region.x0 * scale, -region.y0 * scale)

  /** 单笔部分揭示：offscreen 上贴笔迹图，再沿 centre 路径 dash 做 destination-in 遮罩 */
  const drawStrokePartial = (a: StrokeAsset, progress: number): void => {
    if (!a.img) return drawStrokeFallback(a)
    octx.setTransform(1, 0, 0, 1, 0, 0)
    octx.clearRect(0, 0, pxW, pxH)
    worldTransform(octx)
    octx.drawImage(a.img, a.box[0], a.box[1], a.box[2], a.box[3])
    octx.globalCompositeOperation = "destination-in"
    octx.strokeStyle = "#fff"
    octx.lineWidth = a.maskW
    octx.lineCap = "round"
    octx.lineJoin = "round"
    octx.setLineDash([Math.max(0.01, progress * a.len), a.len + 2])
    octx.stroke(a.path)
    octx.setLineDash([])
    octx.globalCompositeOperation = "source-over"
    ctx.drawImage(off, region.x0, region.y0, region.w, region.h)
  }

  const drawStrokeFallback = (a: StrokeAsset): void => {
    const pts = a.fallback
    if (!pts.length) return
    ctx.strokeStyle = a.color
    ctx.lineWidth = a.maskW / 2
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.stroke()
  }

  const drawStrokeFull = (a: StrokeAsset): void => {
    if (a.img) ctx.drawImage(a.img, a.box[0], a.box[1], a.box[2], a.box[3])
    else drawStrokeFallback(a)
  }

  const drawFrame = (t: number): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, pxW, pxH)
    worldTransform(ctx)
    drawTexts(ctx, doc.texts, resolve, (i) => {
      const at = timing.texts[i]
      if (at === undefined) return 1
      if (t < at) return 0
      return easeOut(Math.min(1, (t - at) / 0.18))
    })
    for (let i = 0; i < doc.icons.length; i++) {
      const ic = doc.icons[i]
      const at = timing.icons[i]
      const a = at === undefined ? 1 : t < at ? 0 : easeOut(Math.min(1, (t - at) / 0.18))
      if (a <= 0) continue
      const asset = iconAssets.get(ic.name)
      if (!asset?.img) continue
      const k = ic.size / 64
      // 页面 DocIconsLayer 同变换：glyph bbox 中心对齐目标盒中心
      const [b0, b1, b2, b3] = asset.bbox
      const cx = (b0 + b2) / 2
      const cy = (b1 + b3) / 2
      const tx = ic.x + ic.size / 2 - cx * k
      const ty = ic.y + ic.size / 2 - cy * k
      const [x0, y0, w, h] = asset.box64
      ctx.globalAlpha = a
      ctx.drawImage(asset.img, tx + x0 * k, ty + y0 * k, w * k, h * k)
    }
    ctx.globalAlpha = 1
    for (let i = 0; i < strokeAssets.length; i++) {
      const a = strokeAssets[i]
      const tm = timing.strokes[i]
      if (!tm || t >= tm.delay + tm.dur) drawStrokeFull(a)
      else if (t >= tm.delay) drawStrokePartial(a, Math.min(1, (t - tm.delay) / tm.dur))
    }
  }

  // 主路径：WebCodecs 逐帧确定性编码（每帧画面/时间戳完全确定，无丢帧）
  if (typeof VideoEncoder !== "undefined") {
    const codecCandidates = ["avc1.640033", "avc1.64002a", "avc1.640028", "avc1.42e03c"]
    let codec: string | null = null
    for (const candidate of codecCandidates) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: candidate,
          width: pxW,
          height: pxH,
          bitrate: 8_000_000,
          framerate: FPS,
        })
        if (support.supported) {
          codec = candidate
          break
        }
      } catch {
        /* 候选不可用，尝试下一个 */
      }
    }
    if (codec) {
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width: pxW, height: pxH },
        fastStart: "in-memory",
      })
      let encoderError: Error | null = null
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => {
          encoderError = e instanceof Error ? e : new Error(String(e))
        },
      })
      encoder.configure({ codec, width: pxW, height: pxH, bitrate: 8_000_000, framerate: FPS })

      for (let i = 0; i < totalFrames; i++) {
        if (encoderError) throw encoderError
        drawFrame(Math.min(i / FPS, end))
        o.onProgress?.((i + 1) / totalFrames)
        const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) })
        encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 })
        frame.close()
        // 编码队列积压时等待，避免内存膨胀
        while (encoder.encodeQueueSize > 8) {
          await new Promise<void>((r) => setTimeout(r, 4))
        }
      }
      await encoder.flush()
      muxer.finalize()
      const { buffer } = muxer.target as ArrayBufferTarget
      return { blob: new Blob([buffer], { type: "video/mp4" }), ext: "mp4" }
    }
  }

  // 回退路径：MediaRecorder 实时录制（WebCodecs 不可用时）
  const pickMime = (): { mime: string; ext: string } | null => {
    if (typeof MediaRecorder === "undefined") return null
    const candidates: [string, string][] = [
      ["video/mp4;codecs=avc1", "mp4"],
      ["video/mp4", "mp4"],
      ["video/webm;codecs=vp9", "webm"],
      ["video/webm;codecs=vp8", "webm"],
      ["video/webm", "webm"],
    ]
    for (const [mime, ext] of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext }
    }
    return null
  }
  const target = pickMime()
  if (!target) throw new Error("当前浏览器不支持视频导出（需要 WebCodecs 或 MediaRecorder）")

  const stream = canvas.captureStream(FPS)
  const rec = new MediaRecorder(stream, { mimeType: target.mime, videoBitsPerSecond: 8_000_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  const stopped = new Promise<void>((done) => {
    rec.onstop = () => done()
  })
  drawFrame(0)
  rec.start()

  await new Promise<void>((done) => {
    const t0 = performance.now()
    const tick = () => {
      const t = (performance.now() - t0) / 1000
      drawFrame(Math.min(t, end))
      o.onProgress?.(Math.min(1, t / end))
      if (t >= end) {
        setTimeout(done, HOLD_MS)
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  rec.stop()
  await stopped
  stream.getTracks().forEach((tr) => tr.stop())
  return { blob: new Blob(chunks, { type: target.mime }), ext: target.ext }
}

export function downloadSketchVideo(doc: VideoDoc, o: ExportVideoOptions = {}): Promise<void> {
  return exportSketchVideo(doc, o).then(({ blob, ext }) => downloadBlob(`sketchpad-${exportStamp()}.${ext}`, blob))
}
