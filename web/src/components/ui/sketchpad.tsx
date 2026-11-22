/* eslint-disable react-hooks/refs --
   ink/shadcn 组件层刻意保留的模式（useInk render 期由 ref 派生 hostProps、上游 setState-in-effect 习惯）；
   按编译器约束重写需重构 ink hook 架构，超出本次 lint 清理范围。 */

"use client"

import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Paper, type PaperProps } from "@/components/ui/paper"
import { useInk, useInkTier, useMergedRef, useEnsureInkDefs } from "@content-forge/ink/react"
import { icons as inkIcons } from "@content-forge/ink/art/icons"
import type { ArtDef } from "@content-forge/ink/art/types"
import { drawSkeleton } from "@content-forge/ink/art-draw"
import {
  DARK_INKS,
  DRAW_TOOLS,
  SKETCH_COLORS,
  SKETCH_SIZES,
  canvasFrameRecipe,
  cursorMarkup,
  sketchSizeRecipe,
  sketchSwatchRecipe,
  sketchToolRecipe,
  strokeHit,
  strokeMarkup,
  strokesToSvg,
  svgDataUrl,
  type DrawTool,
  type SketchColor,
  type SketchPoint,
  type SketchSizeName,
  type SketchStroke,
  type SketchTool,
  type StrokeMarkup,
} from "@content-forge/ink/recipes/sketchpad-ink"
import { svgToPngDataUrl } from "@/lib/sketch-export"
import { cn } from "@/lib/utils"

type StrokeInput = Omit<SketchStroke, "id"> & { id?: string }

/** 手写风文本标注（agent-only；镜像 packages/sketchpad/src/contract.ts 的 SketchText，两侧需同步） */
interface SketchText {
  id: string
  x: number
  y: number
  size: number
  color: SketchColor
  text: string
}

/** 1:1 looseleaf icon 元素（agent-only；镜像 contract.ts 的 SketchIcon） */
interface SketchDocIcon {
  id: string
  name: string
  x: number
  y: number
  size: number
  color: SketchColor
}

const TEXT_FONT = '"LXGW WenKai Lite", "Kaiti SC", "STKaiti", serif'
/** 与 sketchpad snapshot 渲染器同一近似基线（左上角定位 → y + size*0.78） */
const TEXT_BASELINE_K = 0.78

/** 无限画布视口：世界坐标 → 屏幕 = translate(x,y) scale(zoom)；世界原点 = 首页画框（W×H）左上角 */
export interface SketchpadView {
  x: number
  y: number
  zoom: number
}

export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 3
/** 缩放落点吸附的 ln 网格步长（ln 0.02 ≈ 2% 步），与 workflow 图页同款——
 *  静止缩放稳定在网格上，同样的缩放比重复出现时渲染可复用；限制的是分辨率不是速度 */
export const ZOOM_STEP_LN = 0.02
export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** 光标锚定缩放：让 (px,py) 下的世界点在缩放后保持在原屏幕位置（workflow 同款公式） */
export const anchoredZoom = (v: SketchpadView, px: number, py: number, target: number): SketchpadView => ({
  x: px - ((px - v.x) / v.zoom) * target,
  y: py - ((py - v.y) / v.zoom) * target,
  zoom: target,
})

interface SketchpadHandle {
  undo(): void
  redo(): void
  clear(): void
  replay(): void
  strokes(): SketchStroke[]
  toSVG(options?: ExportOptions): string
  toDataURL(options?: ExportOptions): string
  toPNG(options?: ExportOptions & { scale?: number }): Promise<string | null>
  /** 以面板中心为锚缩放 zoom 倍 */
  zoomBy(factor: number): void
  /** 回到首页画框：等比适配并居中 */
  fitHome(): void
}

interface ExportOptions {
  background?: boolean
  margin?: number
  title?: string
}

const TOOL_LABEL: Record<SketchTool, string> = { felt: "Felt", brush: "Brush", pencil: "Pencil", marker: "Marker", highlighter: "Highlighter", eraser: "Eraser" }
const COLOR_LABEL: Record<SketchColor, string> = { ink: "Ink", "ink-you": "Blue", red: "Red", green: "Green", marker: "Terracotta", tangerine: "Orange", hi: "Yellow", teal: "Teal", grape: "Purple", bubblegum: "Pink" }
const SIZE_LABEL: Record<SketchSizeName, string> = { fine: "Fine", medium: "Medium", bold: "Bold" }
const KEY_TOOL: Record<string, SketchTool> = { f: "felt", b: "brush", p: "pencil", m: "marker", h: "highlighter", e: "eraser" }
const SIZE_STEPS = [SKETCH_SIZES.fine, SKETCH_SIZES.medium, SKETCH_SIZES.bold]
const DEFAULT_TOOLS: readonly SketchTool[] = ["felt", "pencil", "marker", "highlighter", "eraser"]
const HISTORY = 100
const NO_IDS: ReadonlySet<string> = new Set()

const round1 = (v: number) => Math.round(v * 10) / 10
const isDrawTool = (t: SketchTool): t is DrawTool => (DRAW_TOOLS as readonly string[]).includes(t)
const sizeName = (size: number): SketchSizeName | undefined => (Object.keys(SKETCH_SIZES) as SketchSizeName[]).find((k) => Math.abs(SKETCH_SIZES[k] - size) < 0.05)

function useControllable<T>(value: T | undefined, defaultValue: T, onChange?: (v: T) => void): [T, (v: T) => void, boolean] {
  const [inner, setInner] = React.useState(defaultValue)
  const controlled = value !== undefined
  const set = React.useCallback(
    (v: T) => {
      if (!controlled) setInner(v)
      onChange?.(v)
    },
    [controlled, onChange],
  )
  return [controlled ? value : inner, set, controlled]
}

function withIds(strokes: readonly StrokeInput[]): SketchStroke[] {
  return strokes.every((s) => s.id) ? (strokes as SketchStroke[]) : strokes.map((s, i) => (s.id ? (s as SketchStroke) : { ...s, id: `i${i}` }))
}

interface SketchpadContextValue {
  strokes: SketchStroke[]
  texts: readonly SketchText[]
  icons: readonly SketchDocIcon[]
  width: number
  height: number
  view: SketchpadView
  setView(v: SketchpadView): void
  /** SketchpadCanvas 注册的视口操作（zoomBy/fitHome 需要 pane 尺寸），apiRef 经它转发 */
  viewportApiRef: React.RefObject<{ zoomBy(factor: number): void; fitHome(): void } | null>
  tool: SketchTool
  tools: readonly SketchTool[]
  /** 查看器模式：指针一律拖拽平移（grab 手型），禁用指针/键盘手绘 */
  panMode: boolean
  color: SketchColor
  size: number
  readOnly: boolean
  disabled: boolean
  canUndo: boolean
  canRedo: boolean
  replaying: boolean
  replayKey: number
  replaySpeed: number
  seed: string
  announce: string
  rootRef: React.RefObject<HTMLDivElement | null>
  canvasRef: React.RefObject<HTMLDivElement | null>
  selectTool(t: SketchTool): void
  setColor(c: SketchColor): void
  setSize(s: number): void
  commit(next: SketchStroke[], message: string): void
  nextId(): string
  say(message: string): void
  undo(): void
  redo(): void
  clear(): void
}

const SketchpadContext = React.createContext<SketchpadContextValue | null>(null)

function useSketchpad(): SketchpadContextValue {
  const ctx = React.useContext(SketchpadContext)
  if (!ctx) throw new Error("Sketchpad parts must be used inside <Sketchpad>")
  return ctx
}

const count = (n: number) => `${n} ${n === 1 ? "stroke" : "strokes"}`

type SketchpadProps = Omit<React.ComponentProps<"div">, "onChange" | "defaultValue" | "color"> & {
  value?: readonly StrokeInput[]
  defaultValue?: readonly StrokeInput[]
  onValueChange?: (strokes: SketchStroke[]) => void
  /** 手写风文本标注（agent-only 受控值；页面不提供编辑入口，随文档渲染） */
  texts?: readonly SketchText[]
  /** 1:1 looseleaf icon 元素（agent-only；页面随文档渲染） */
  icons?: readonly SketchDocIcon[]
  tool?: SketchTool
  defaultTool?: SketchTool
  onToolChange?: (tool: SketchTool) => void
  tools?: readonly SketchTool[]
  color?: SketchColor
  defaultColor?: SketchColor
  onColorChange?: (color: SketchColor) => void
  size?: number
  defaultSize?: number
  onSizeChange?: (size: number) => void
  width?: number
  height?: number
  /** 无限画布视口（受控；缺省内部维护 {x:0,y:0,zoom:1}） */
  view?: SketchpadView
  onViewChange?: (v: SketchpadView) => void
  /** 查看器模式：指针一律拖拽平移（grab 手型），禁用指针/键盘手绘 */
  panMode?: boolean
  readOnly?: boolean
  disabled?: boolean
  replay?: boolean
  replaySpeed?: number
  apiRef?: React.Ref<SketchpadHandle>
  seed?: string | number
}

function Sketchpad({
  className,
  children,
  ref,
  value,
  defaultValue,
  onValueChange,
  texts = [],
  icons = [],
  tool: toolProp,
  defaultTool = "felt",
  onToolChange,
  tools = DEFAULT_TOOLS,
  color: colorProp,
  defaultColor = "ink",
  onColorChange,
  size: sizeProp,
  defaultSize = SKETCH_SIZES.medium,
  onSizeChange,
  width = 640,
  height = 400,
  view: viewProp,
  onViewChange,
  panMode = false,
  readOnly = false,
  disabled = false,
  replay = false,
  replaySpeed = 1,
  apiRef,
  seed,
  ...props
}: SketchpadProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLDivElement | null>(null)
  const lastButton = React.useRef<HTMLButtonElement | null>(null)
  const idBase = React.useId()
  const [strokesRaw, setStrokes, strokesControlled] = useControllable<readonly StrokeInput[]>(value, defaultValue ?? [], onValueChange as ((v: readonly StrokeInput[]) => void) | undefined)
  const strokes = React.useMemo(() => withIds(strokesRaw), [strokesRaw])
  const [tool, setToolRaw] = useControllable<SketchTool>(toolProp, defaultTool, onToolChange)
  const [color, setColor] = useControllable<SketchColor>(colorProp, defaultColor, onColorChange)
  const [size, setSize] = useControllable<number>(sizeProp, defaultSize, onSizeChange)
  const [view, setView] = useControllable<SketchpadView>(viewProp, { x: 0, y: 0, zoom: 1 }, onViewChange)
  const viewportApiRef = React.useRef<{ zoomBy(factor: number): void; fitHome(): void } | null>(null)
  const [announce, setAnnounce] = React.useState("")
  const [replayN, setReplayN] = React.useState(0)

  const latest = React.useRef({ strokes, color, tool })
  latest.current = { strokes, color, tool }
  const hist = React.useRef<{ past: SketchStroke[][]; future: SketchStroke[][]; last: readonly StrokeInput[] | null }>({ past: [], future: [], last: null })
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  const counter = React.useRef(0)

  React.useEffect(() => {
    if (strokesControlled && value !== hist.current.last && (hist.current.past.length || hist.current.future.length)) {
      hist.current.past = []
      hist.current.future = []
      force()
    }
  }, [value, strokesControlled])

  const emit = React.useCallback(
    (next: SketchStroke[]) => {
      hist.current.last = next
      setStrokes(next)
    },
    [setStrokes],
  )

  const commit = React.useCallback(
    (next: SketchStroke[], message: string) => {
      const h = hist.current
      h.past.push(latest.current.strokes)
      if (h.past.length > HISTORY) h.past.shift()
      h.future = []
      emit(next)
      setAnnounce(`${message} ${count(next.length)}.`)
    },
    [emit],
  )

  const undo = React.useCallback(() => {
    const h = hist.current
    const prev = h.past.pop()
    if (!prev) return
    h.future.push(latest.current.strokes)
    emit(prev)
    setAnnounce(`Undone. ${count(prev.length)}.`)
    force()
  }, [emit])

  const redo = React.useCallback(() => {
    const h = hist.current
    const next = h.future.pop()
    if (!next) return
    h.past.push(latest.current.strokes)
    emit(next)
    setAnnounce(`Redone. ${count(next.length)}.`)
    force()
  }, [emit])

  const clear = React.useCallback(() => {
    if (!latest.current.strokes.length) return
    commit([], "Cleared.")
  }, [commit])

  const selectTool = React.useCallback(
    (t: SketchTool) => {
      const prev = latest.current.tool
      setToolRaw(t)
      const c = latest.current.color
      if (t === "highlighter" && DARK_INKS.has(c)) setColor("hi")
      else if (prev === "highlighter" && t !== "highlighter" && c === "hi") setColor("ink")
    },
    [setToolRaw, setColor],
  )

  const nextId = React.useCallback(() => {
    const used = new Set(latest.current.strokes.map((s) => s.id))
    let id: string
    do id = `s${(counter.current++).toString(36)}`
    while (used.has(id))
    return id
  }, [])

  const resolve = React.useCallback((name: string) => {
    const el = rootRef.current
    if (!el || typeof getComputedStyle === "undefined") return undefined
    return getComputedStyle(el).getPropertyValue(name).trim() || undefined
  }, [])

  const toSVG = React.useCallback(
    (o: ExportOptions = {}) =>
      strokesToSvg(latest.current.strokes, {
        width,
        height,
        resolve,
        margin: o.margin,
        title: o.title,
        background: o.background === false ? undefined : (resolve("--ll-paper") ?? "var(--ll-paper)"),
      }),
    [width, height, resolve],
  )

  React.useImperativeHandle(
    apiRef,
    (): SketchpadHandle => ({
      undo,
      redo,
      clear,
      replay: () => setReplayN((n) => n + 1),
      strokes: () => latest.current.strokes,
      toSVG,
      toDataURL: (o) => svgDataUrl(toSVG(o)),
      toPNG: (o = {}) => {
        const m = o.margin ?? 0
        return svgToPngDataUrl(svgDataUrl(toSVG(o)), width + 2 * m, height + 2 * m, o.scale)
      },
      zoomBy: (factor) => viewportApiRef.current?.zoomBy(factor),
      fitHome: () => viewportApiRef.current?.fitHome(),
    }),
    [undo, redo, clear, toSVG, width, height],
  )

  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onIn = (e: FocusEvent) => {
      lastButton.current = e.target instanceof HTMLButtonElement ? e.target : null
    }
    const onOut = (e: FocusEvent) => {
      if (e.target instanceof HTMLButtonElement && !e.target.disabled) lastButton.current = null
    }
    root.addEventListener("focusin", onIn)
    root.addEventListener("focusout", onOut)
    return () => {
      root.removeEventListener("focusin", onIn)
      root.removeEventListener("focusout", onOut)
    }
  }, [])
  React.useEffect(() => {
    const root = rootRef.current
    const now = document.activeElement
    const was = lastButton.current
    const stranded = now instanceof HTMLButtonElement ? now : now === document.body || !now ? was : null
    if (stranded?.disabled && root?.contains(stranded)) {
      lastButton.current = null
      canvasRef.current?.focus({ preventScroll: true })
    }
  })

  const interactive = !readOnly && !disabled
  const replaying = replay || replayN > 0
  const ctx: SketchpadContextValue = {
    strokes,
    texts,
    icons,
    width,
    height,
    view,
    setView,
    viewportApiRef,
    tool,
    tools,
    panMode,
    color,
    size,
    readOnly,
    disabled,
    canUndo: interactive && hist.current.past.length > 0,
    canRedo: interactive && hist.current.future.length > 0,
    replaying,
    replayKey: replayN,
    replaySpeed,
    seed: `${idBase}${seed ?? ""}`,
    announce,
    rootRef,
    canvasRef,
    selectTool,
    setColor,
    setSize,
    commit,
    nextId,
    say: setAnnounce,
    undo,
    redo,
    clear,
  }

  return (
    <SketchpadContext.Provider value={ctx}>
      <div data-slot="sketchpad" data-disabled={disabled ? "" : undefined} data-readonly={readOnly ? "" : undefined} ref={useMergedRef(rootRef, ref)} className={cn("flex w-full flex-col gap-3", className)} {...props}>
        {children ?? (
          <>
            {readOnly ? null : (
              <SketchpadToolbar>
                <SketchpadTools />
                <span className="ms-auto flex items-center gap-2">
                  <SketchpadUndo />
                  <SketchpadRedo />
                  <SketchpadClear />
                </span>
                <div className="flex w-full flex-wrap items-center gap-x-4">
                  <SketchpadColors />
                  <SketchpadSizes />
                </div>
              </SketchpadToolbar>
            )}
            <SketchpadCanvas />
          </>
        )}
      </div>
    </SketchpadContext.Provider>
  )
}

/** 1:1 looseleaf icon 层:drawSkeleton 渲染(与 Icon 组件同一管线,颗粒 mask 由全局 defs 提供),
 *  按 glyph pts bbox 中心定位——glyph 不满铺,按盒中心放会歪;对齐目标盒中心才是真居中。
 *  与 sketchpad snapshot 渲染器(render.ts iconEls)同一变换,两端一致。 */
const docIconMemo = new Map<string, { svg: string; bbox: [number, number, number, number] } | null>()
function docIconRender(name: string) {
  const hit = docIconMemo.get(name)
  if (hit !== undefined) return hit
  let out: { svg: string; bbox: [number, number, number, number] } | null = null
  try {
    const def = (inkIcons as Record<string, ArtDef>)[name]
    if (def) {
      const res = drawSkeleton(def, 64, name, { kind: "icon" })
      // res.bbox = [x0, y0, x1, y1](64 盒坐标),归一化
      const [bx0, by0, bx1, by1] = res.bbox
      out = { svg: res.svg, bbox: [bx0 / 64, by0 / 64, bx1 / 64, by1 / 64] }
    }
  } catch { /* 未知 icon 名留空 */ }
  docIconMemo.set(name, out)
  return out
}

function DocIconsLayer({ icons }: { icons: readonly SketchDocIcon[] }) {
  useEnsureInkDefs()
  return (
    <g data-slot="sketchpad-icons">
      {icons.map((ic) => {
        const m = docIconRender(ic.name)
        if (!m) return null
        const [b0, b1, b2, b3] = m.bbox
        const cx = (b0 + b2) / 2
        const cy = (b1 + b3) / 2
        const tx = ic.x + ic.size / 2 - cx * ic.size
        const ty = ic.y + ic.size / 2 - cy * ic.size
        return (
          <g
            key={ic.id}
            data-icon={ic.name}
            transform={`translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${(ic.size / 64).toFixed(4)})`}
            style={{ color: `var(--ll-${ic.color})` }}
            dangerouslySetInnerHTML={{ __html: m.svg }}
          />
        )
      })}
    </g>
  )
}

function SketchpadToolbar({ className, children, ...props }: Omit<PaperProps, "stock" | "edge" | "tilt">) {
  return (
    <Paper
      data-slot="sketchpad-toolbar"
      role="group"
      aria-label="Drawing tools"
      stock="slip"
      edge="cut"
      tilt={false}
      shadow="hair"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5", className)}
      {...props}
    >
      {children}
    </Paper>
  )
}

type GroupProps = Omit<React.ComponentProps<typeof RadioGroupPrimitive.Root>, "value" | "defaultValue" | "onValueChange" | "orientation">

function SketchpadTools({ className, children, tools: toolsProp, ...props }: GroupProps & { tools?: readonly SketchTool[] }) {
  const ctx = useSketchpad()
  const tools = toolsProp ?? ctx.tools
  return (
    <RadioGroupPrimitive.Root
      data-slot="sketchpad-tools"
      aria-label="Tool"
      orientation="horizontal"
      value={ctx.tool}
      onValueChange={(v) => ctx.selectTool(v as SketchTool)}
      disabled={ctx.disabled || ctx.readOnly}
      className={cn("flex flex-wrap items-center gap-0.5", className)}
      {...props}
    >
      {children ?? tools.map((t) => <SketchpadTool key={t} value={t} />)}
    </RadioGroupPrimitive.Root>
  )
}

type ItemProps = Omit<React.ComponentProps<typeof RadioGroupPrimitive.Item>, "value"> & { seed?: string | number }

function SketchpadTool({ value, className, children, seed, ref, ...props }: ItemProps & { value: SketchTool }) {
  const ctx = useSketchpad()
  const { hostRef, hostProps, node } = useInk({ recipe: sketchToolRecipe, params: { tool: value, color: ctx.color }, kind: "sketchpad-tool", seed })
  return (
    <RadioGroupPrimitive.Item
      data-slot="sketchpad-tool"
      data-tool={value}
      value={value}
      ref={useMergedRef<HTMLButtonElement>(hostRef, ref)}
      {...hostProps}
      className={cn(
        "relative isolate inline-flex h-[52px] min-w-16 cursor-pointer flex-col items-center justify-end px-2 pb-[5px] font-hand text-[14px] leading-none font-bold whitespace-nowrap text-ink transition-[translate] duration-(--ll-dur-press) ease-out active:translate-y-(--ll-press-sink) disabled:pointer-events-none disabled:text-pencil-text",
        "forced-colors:data-[state=checked]:[outline:3px_solid_Highlight]!",
        className,
      )}
      {...props}
    >
      {node}
      <span className="ll-ink-room">{children ?? TOOL_LABEL[value]}</span>
    </RadioGroupPrimitive.Item>
  )
}

function SketchpadColors({ className, children, colors = SKETCH_COLORS, ...props }: GroupProps & { colors?: readonly SketchColor[] }) {
  const ctx = useSketchpad()
  return (
    <RadioGroupPrimitive.Root
      data-slot="sketchpad-colors"
      aria-label="Color"
      orientation="horizontal"
      value={ctx.color}
      onValueChange={(v) => ctx.setColor(v as SketchColor)}
      disabled={ctx.disabled || ctx.readOnly}
      className={cn("flex flex-wrap items-center", className)}
      {...props}
    >
      {children ?? colors.map((c) => <SketchpadColor key={c} value={c} />)}
    </RadioGroupPrimitive.Root>
  )
}

function SketchpadColor({ value, className, seed, ref, style, "aria-label": label, ...props }: ItemProps & { value: SketchColor }) {
  const { hostRef, hostProps, node } = useInk({ recipe: sketchSwatchRecipe, params: { color: value }, kind: "sketchpad-swatch", seed })
  return (
    <RadioGroupPrimitive.Item
      data-slot="sketchpad-color"
      data-color={value}
      value={value}
      aria-label={label ?? COLOR_LABEL[value]}
      ref={useMergedRef<HTMLButtonElement>(hostRef, ref)}
      {...hostProps}
      style={{ "--sw": `var(--ll-${value})`, ...style } as React.CSSProperties}
      className={cn("relative isolate inline-flex size-7 cursor-pointer items-center justify-center after:absolute after:-inset-px disabled:pointer-events-none disabled:opacity-60 forced-colors:[forced-color-adjust:none] forced-colors:bg-(--sw) forced-colors:data-[state=checked]:[outline:3px_solid_Highlight]!", className)}
      {...props}
    >
      {node}
    </RadioGroupPrimitive.Item>
  )
}

function SketchpadSizes({ className, children, ...props }: GroupProps) {
  const ctx = useSketchpad()
  return (
    <RadioGroupPrimitive.Root
      data-slot="sketchpad-sizes"
      aria-label="Width"
      orientation="horizontal"
      value={sizeName(ctx.size) ?? ""}
      onValueChange={(v) => ctx.setSize(SKETCH_SIZES[v as SketchSizeName])}
      disabled={ctx.disabled || ctx.readOnly}
      className={cn("flex items-center", className)}
      {...props}
    >
      {children ?? (Object.keys(SKETCH_SIZES) as SketchSizeName[]).map((s) => <SketchpadSize key={s} value={s} />)}
    </RadioGroupPrimitive.Root>
  )
}

function SketchpadSize({ value, className, seed, ref, "aria-label": label, ...props }: ItemProps & { value: SketchSizeName }) {
  const { hostRef, hostProps, node } = useInk({ recipe: sketchSizeRecipe, params: { size: value }, kind: "sketchpad-size", seed })
  return (
    <RadioGroupPrimitive.Item
      data-slot="sketchpad-size"
      data-size={value}
      value={value}
      aria-label={label ?? `${SIZE_LABEL[value]} line`}
      ref={useMergedRef<HTMLButtonElement>(hostRef, ref)}
      {...hostProps}
      className={cn("relative isolate inline-flex size-7 cursor-pointer items-center justify-center disabled:pointer-events-none disabled:opacity-60 forced-colors:after:absolute forced-colors:after:top-1/2 forced-colors:after:left-1/2 forced-colors:after:size-2 forced-colors:after:-translate-1/2 forced-colors:after:rounded-full forced-colors:after:bg-[CanvasText] forced-colors:data-[state=checked]:[outline:3px_solid_Highlight]!", className)}
      {...props}
    >
      {node}
    </RadioGroupPrimitive.Item>
  )
}

type ButtonProps = React.ComponentProps<typeof Button>

function SketchpadUndo({ children, onClick, ...props }: ButtonProps) {
  const ctx = useSketchpad()
  return (
    <Button
      data-slot="sketchpad-undo"
      variant="ghost"
      size="sm"
      type="button"
      disabled={!ctx.canUndo}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) ctx.undo()
      }}
      {...props}
    >
      {children ?? "Undo"}
    </Button>
  )
}

function SketchpadRedo({ children, onClick, ...props }: ButtonProps) {
  const ctx = useSketchpad()
  return (
    <Button
      data-slot="sketchpad-redo"
      variant="ghost"
      size="sm"
      type="button"
      disabled={!ctx.canRedo}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) ctx.redo()
      }}
      {...props}
    >
      {children ?? "Redo"}
    </Button>
  )
}

function SketchpadClear({ children, onClick, ...props }: ButtonProps) {
  const ctx = useSketchpad()
  return (
    <Button
      data-slot="sketchpad-clear"
      variant="ghost"
      size="sm"
      type="button"
      disabled={ctx.disabled || ctx.readOnly || !ctx.strokes.length}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) ctx.clear()
      }}
      {...props}
    >
      {children ?? "Clear"}
    </Button>
  )
}

interface ReplayTiming {
  delay: number
  dur: number
}

/** 可视世界矩形（norm 于世界坐标，含边距），用于视口裁剪 */
interface ViewRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** bbox 与可视世界矩形相交测试（含相切） */
function bboxVisible(r: ViewRect, b: readonly [number, number, number, number]): boolean {
  return b[2] >= r.x0 && b[0] <= r.x1 && b[3] >= r.y0 && b[1] <= r.y1
}

/** 文本按左上角 + 近似包络（中文 ≈ 1em/字，混合文本取 0.8em 估计宽）测试可视性 */
function textVisible(r: ViewRect, t: SketchText): boolean {
  const w = t.text.length * t.size * 0.8
  return t.x + w >= r.x0 && t.x <= r.x1 && t.y + t.size >= r.y0 && t.y <= r.y1
}

/** ink markup 内嵌的 draw-reveal mask（dashoffset=0 恒等于全显）：那是独立查看器
 *  开笔动画用的；页面回放走自己外建的 maskId 包裹，静态渲染留着它 = 每笔多 1 次
 *  mask 栅格化 + 每个 fill 层 1 次被遮罩合成。剥掉定义与引用，视觉不变、落定
 *  重栅格化显著变便宜 */
const DRAW_MASK_DEF_RE = /<mask id="ll-draw-[^"]*"[^>]*>[\s\S]*?<\/mask>/g
const DRAW_MASK_REF_RE = / mask="url\(#ll-draw-[^"]*\)"/g
function stripDrawMasks(svg: string): string {
  return svg.replace(DRAW_MASK_DEF_RE, "").replace(DRAW_MASK_REF_RE, "")
}

const StrokeShape = React.memo(function StrokeShape({ stroke, m, dim, replay, maskId }: { stroke: SketchStroke; m: StrokeMarkup; dim: boolean; replay: ReplayTiming | null; maskId: string }) {
  const style = dim ? { opacity: 0.22 } : undefined
  if (!replay) return <g data-stroke={stroke.id} style={style} dangerouslySetInnerHTML={{ __html: m.svg }} />
  // mask 按笔迹自身 bbox 定界（无界画布下不能再用固定 W×H 大 mask——userSpaceOnUse mask 是光栅化的）
  const w = Math.max(8, strokeWidthOf(stroke) * 1.6 + 6)
  const pad = w + 12
  const [bx0, by0, bx1, by1] = m.bbox
  return (
    <g data-stroke={stroke.id} mask={`url(#${maskId})`} style={style}>
      <mask id={maskId} maskUnits="userSpaceOnUse" x={bx0 - pad} y={by0 - pad} width={bx1 - bx0 + 2 * pad} height={by1 - by0 + 2 * pad}>
        <path
          d={m.centre}
          pathLength={1}
          fill="none"
          stroke="var(--ll-photo)"
          strokeWidth={w}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ll-draw"
          style={{ "--ll-draw-delay": `${replay.delay.toFixed(2)}s`, animationDuration: `${replay.dur.toFixed(2)}s`, animationTimingFunction: "linear" } as React.CSSProperties}
        />
      </mask>
      <g dangerouslySetInnerHTML={{ __html: m.svg }} />
    </g>
  )
})

const strokeWidthOf = (s: SketchStroke): number => (s.tool === "highlighter" ? 14 : s.tool === "marker" ? 8 : 3.4) * s.size

interface Gesture {
  pointer: number | "key"
  kind: string
  tool: SketchTool
  color: SketchColor
  size: number
  pts: SketchPoint[]
  tail: SketchPoint | null
  erase: Set<string> | null
}

const SAMPLE_GAP = 0.8
const LIVE_POINTS = 480
const PALM_MS = 1500

function preview(pts: SketchPoint[]): SketchPoint[] {
  if (pts.length <= LIVE_POINTS) return pts.slice()
  let k = 2
  while (pts.length / k > LIVE_POINTS) k *= 2
  const out: SketchPoint[] = []
  for (let i = 0; i < pts.length; i += k) out.push(pts[i])
  const tail = pts[pts.length - 1]
  if (out[out.length - 1] !== tail) out.push(tail)
  return out
}

function thin(pts: SketchPoint[]): SketchPoint[] {
  const out: SketchPoint[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) out.push(p)
  }
  const tail = pts[pts.length - 1]
  if (out.length > 1 && out[out.length - 1] !== tail) out.push(tail)
  return out
}

type SketchpadCanvasProps = Omit<React.ComponentProps<"div">, "children"> & {
  label?: string
  children?: React.ReactNode
  seed?: string | number
  /** 无保存视口时首帧自动适配首页画框（app 层只在 localStorage 没有该画布视口时传 true） */
  autoFit?: boolean
}

function SketchpadCanvas({ className, style: styleProp, children, label = "Drawing", seed, autoFit = false, ref, onKeyDown, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture, onBlur, ...props }: SketchpadCanvasProps) {
  const ctx = useSketchpad()
  const tier = useInkTier()
  const { hostRef, hostProps, node } = useInk({ recipe: canvasFrameRecipe, params: {}, kind: "sketchpad-canvas", size: [ctx.width, ctx.height], seed })
  const help = React.useId()
  const uid = ctx.seed.replace(/[^a-zA-Z0-9]/g, "")
  const surface = React.useRef<SVGSVGElement | null>(null)
  const gesture = React.useRef<Gesture | null>(null)
  const penSeen = React.useRef(Number.NEGATIVE_INFINITY)
  const frame = React.useRef(0)
  const [live, setLive] = React.useState<SketchStroke | null>(null)
  const [erasing, setErasing] = React.useState<ReadonlySet<string>>(NO_IDS)
  const [cursor, setCursor] = React.useState<[number, number] | null>(null)
  const pan = React.useRef<{ pointerId: number; sx: number; sy: number; vx: number; vy: number } | null>(null)
  const spaceRef = React.useRef(false)
  /** 世界锚定层 ref（与 surface svg 成对）：手势期 transform 直写 DOM，见 applyViewDom */
  const worldRef = React.useRef<HTMLDivElement | null>(null)
  const interactive = !ctx.readOnly && !ctx.disabled
  const panMode = ctx.panMode

  // Space 按住 = 平移（Figma 惯例）；画布聚焦时键盘落笔改由 Enter 承担（onKey 里的 Space 分支已移除）。
  // 只在 sketchpad 作用域内生效，不干扰其他输入框/按钮的 Space 行为。
  React.useEffect(() => {
    const inScope = (t: EventTarget | null) => t === document.body || !!(t instanceof Node && ctx.canvasRef.current?.contains(t))
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || !inScope(e.target)) return
      spaceRef.current = true
      if (interactive) e.preventDefault()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      spaceRef.current = false
      if (interactive && inScope(e.target)) e.preventDefault()
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      spaceRef.current = false
    }
  }, [interactive])
  const { width: W, height: H } = ctx

  const view = ctx.view
  const setView = ctx.setView
  // wheel/pan 处理器里同步读视口，绕开 effect 闭包
  const viewRef = React.useRef(view)
  viewRef.current = view
  const [pane, setPane] = React.useState<[number, number]>([W, H])
  const paneRef = React.useRef<[number, number]>(pane)
  paneRef.current = pane

  /* 视口层几何（"慢提交"双轨）：svg 布局恒等于面板，内容缩放比由 viewBox 承担。
     viewBox 是重栅格化触发器——每次变都整层换栅格（dpr2 全画布 ~200ms），
     若随每次 settle 即时变更，"缩放后紧跟平移"就会跟栅格积压抢帧 = 卡顿。
     所以 viewBox 慢提交：只在交互空闲 350ms 后更新；期间的一切缩放/平移由元素
     transform 精确补偿——绘制映射 page = tx + (wx-vx0)·zw·k，令
     tx = view.x + vx0·z、k = z/zw 即与正确映射 page = view.x + wx·z 完全等价
     （vx0/vy0/zw = 已提交 viewBox 原点与世界比），合成器期间零重栅格化。
     代价：缩小手势中边缘短暂欠绘制，≤350ms 后提交补齐。 */
  // committed 用初始视口惰性初始化：否则保存视口（≠ {0,0,1}）加载 350ms 后必触发一次
  // 多余的整层重栅格（第二波"上半先出来"的来源）
  const [committed, setCommitted] = React.useState<{ vx: number; vy: number; zw: number }>(() => {
    const z0 = view.zoom || 1
    return { vx: -view.x / z0, vy: -view.y / z0, zw: z0 }
  })
  const committedRef = React.useRef(committed)
  committedRef.current = committed
  const commitTimer = React.useRef(0)
  React.useEffect(() => {
    const atSchedule = viewRef.current
    const commit = () => {
      const v = viewRef.current
      // 提交前交互又在进行（viewRef 相对调度时已变）：顺延，避免在手势中途触发重栅格化
      if (v !== atSchedule) {
        commitTimer.current = window.setTimeout(commit, 350)
        return
      }
      // zw 是绘制映射的自由参数（tx/k 补偿保证任意 zw 下映射正确），钳在温和区间
      // 避免 viewBox 出现巨型坐标（疑似触发 Skia 慢栅格路径）
      const zw = Math.min(3, Math.max(0.5, v.zoom || 1))
      setCommitted({ vx: -v.x / zw, vy: -v.y / zw, zw })
    }
    commitTimer.current = window.setTimeout(commit, 350)
    return () => window.clearTimeout(commitTimer.current)
  }, [view, pane])

  /** 手势期直写 DOM transform（与 workflow 的 d3 同款）：wheel 平移/缩放与拖拽 pan 的
   *  每帧更新不再走 React setState——否则每帧触发整树 reconciliation + localStorage，
   *  就是"缩放流畅、移动还卡"的根源。同步更新 viewRef 保证 project() 画线坐标准确；
   *  手势结束时由调用方 setView(一次) 同步 React state 与持久化 */
  const applyViewDom = React.useCallback((v: SketchpadView) => {
    viewRef.current = v
    const z = v.zoom || 1
    const c = committedRef.current
    const k = z / (c.zw || 1)
    const t = `translate(${v.x + c.vx * z}px, ${v.y + c.vy * z}px) scale(${k})`
    if (surface.current) surface.current.style.transform = t
    if (worldRef.current) worldRef.current.style.transform = t
  }, [])

  // markup（含 bbox）提升到父级算好下发：视口裁剪和内容自适应都要用 bbox，
  // StrokeShape 也不再重复计算；svg 剥掉内嵌 draw mask（见 stripDrawMasks 注释）
  // LOD：缩小视图（z<0.9）时笔迹降级为 lo 档 markup（点数约减半，栅格提速）——
  // 缩小视图下整幅画布可见、笔迹很小，降级视觉无感；跨过阈值时按档位重算 markup
  const strokeTier = view.zoom < 0.9 ? "lo" : tier
  const strokeInfos = React.useMemo(
    () =>
      ctx.strokes.map((s) => {
        const raw = strokeMarkup(s, { tier: strokeTier })
        return { s, m: { ...raw, svg: stripDrawMasks(raw.svg) } }
      }),
    [ctx.strokes, strokeTier],
  )

  /** 内容包围盒（笔迹/文本/icon ∪ 首页画框）——fitHome 的取景目标，与 snapshot 同法 */
  const contentBbox = React.useMemo<[number, number, number, number]>(() => {
    let bx0 = 0, by0 = 0, bx1 = W, by1 = H
    for (const { m } of strokeInfos) {
      bx0 = Math.min(bx0, m.bbox[0]); by0 = Math.min(by0, m.bbox[1])
      bx1 = Math.max(bx1, m.bbox[2]); by1 = Math.max(by1, m.bbox[3])
    }
    for (const t of ctx.texts) {
      bx0 = Math.min(bx0, t.x); by0 = Math.min(by0, t.y)
      bx1 = Math.max(bx1, t.x + t.text.length * t.size * 0.8); by1 = Math.max(by1, t.y + t.size)
    }
    for (const ic of ctx.icons) {
      bx0 = Math.min(bx0, ic.x); by0 = Math.min(by0, ic.y)
      bx1 = Math.max(bx1, ic.x + ic.size); by1 = Math.max(by1, ic.y + ic.size)
    }
    return [bx0, by0, bx1, by1]
  }, [strokeInfos, ctx.texts, ctx.icons])

  /** 取景内容包围盒（留 80px 边距），缩放上限内尽量铺满面板 */
  const fitContent = React.useCallback((pw: number, ph: number) => {
    const [bx0, by0, bx1, by1] = contentBbox
    const bw = Math.max(1, bx1 - bx0)
    const bh = Math.max(1, by1 - by0)
    const z = clampZoom(Math.min((pw - 80) / bw, (ph - 80) / bh, ZOOM_MAX))
    setView({ x: (pw - bw * z) / 2 - bx0 * z, y: (ph - bh * z) / 2 - by0 * z, zoom: z })
  }, [contentBbox])
  const fitContentRef = React.useRef(fitContent)
  fitContentRef.current = fitContent

  React.useEffect(
    () => () => {
      if (frame.current && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame.current)
    },
    [],
  )

  React.useEffect(() => {
    const el = ctx.canvasRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return
      setPane([r.width, r.height])
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 自动适配内容包围盒：autoFit 且视口仍是默认原点时随内容变化重新取景——
  // 文档晚于首帧到达（先适配了空首页框）也能在内容到位后正确框住全部内容
  React.useEffect(() => {
    if (!autoFit) return
    const v = viewRef.current
    if (v.x !== 0 || v.y !== 0 || v.zoom !== 1) return
    const [pw, ph] = paneRef.current
    if (!pw || !ph) return
    fitContent(pw, ph)
  }, [autoFit, fitContent])

  // 视口操作：面板中心锚定缩放 / 回到内容取景（挂到 ctx 供 apiRef 转发）
  React.useEffect(() => {
    ctx.viewportApiRef.current = {
      zoomBy: (factor) => {
        const [pw, ph] = paneRef.current
        const v = viewRef.current
        const z = clampZoom(v.zoom * factor)
        if (z !== v.zoom) setView(anchoredZoom(v, pw / 2, ph / 2, z))
      },
      fitHome: () => {
        const [pw, ph] = paneRef.current
        fitContentRef.current(pw, ph)
      },
    }
    return () => {
      ctx.viewportApiRef.current = null
    }
  })

  // 滚轮：普通滚轮平移 / shift+滚轮横向 / ctrl或⌘+滚轮以光标为锚缩放。
  // 必须原生监听（React 合成 wheel 是 passive 的，preventDefault 无效），rAF 合帧。
  // 缩放参数与 workflow 图页完全对齐（pipeline-graph-page attachWheel 同款）：
  // 敏感度 exp(-deltaY*0.01) + 连续手势水位（亚步进残差跨帧保留，慢捏合首帧即跟手）+
  // 目标吸附 2% ln 对数网格（静止缩放稳定在网格上，tiles 跨手势可复用）。
  React.useEffect(() => {
    const el = ctx.canvasRef.current
    if (!el) return
    let pending: { clientX: number; clientY: number; dx: number; dy: number; zoom: boolean } | null = null
    let raf = 0
    /** 本次缩放手势的连续水位（不吸附）；空闲 300ms 后清零，下次手势重新锚定当前缩放 */
    let gestureZoom: number | null = null
    let idleTimer = 0
    const settle = () => {
      // 手势结束：把 DOM 直写的最终视口同步回 React state（触发一次渲染）+ 持久化
      const v = viewRef.current
      if (v.x !== view.x || v.y !== view.y || v.zoom !== view.zoom) setView(v)
    }
    const apply = () => {
      raf = 0
      if (!pending) return
      const r = el.getBoundingClientRect()
      const px = pending.clientX - r.left
      const py = pending.clientY - r.top
      const v = viewRef.current
      if (pending.zoom) {
        // 图层提升（workflow 的 flow-gesturing 同款）：手势中整层 GPU 纹理缩放/平移，
        // 空闲 300ms 后复位，触发一次最终尺度的重栅格化（变清晰）
        el.setAttribute("data-gesturing", "")
        if (gestureZoom === null) gestureZoom = v.zoom
        const raw = clampZoom(gestureZoom * Math.exp(-pending.dy * 0.01))
        gestureZoom = raw
        const target = clampZoom(Math.exp(Math.round(Math.log(raw) / ZOOM_STEP_LN) * ZOOM_STEP_LN))
        if (target !== v.zoom) applyViewDom(anchoredZoom(v, px, py, target))
      } else {
        applyViewDom({ x: v.x - pending.dx, y: v.y - pending.dy, zoom: v.zoom })
      }
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        gestureZoom = null
        el.removeAttribute("data-gesturing")
        settle()
      }, 300)
      pending = null
    }
    const onWheel = (e: WheelEvent) => {
      // 平移像素 1:1（d3 translateBy 世界位移 ÷ zoom 的净效果）；deltaMode 与 React Flow 同款
      const k = e.deltaMode === 1 ? 20 : 1
      let dx = e.deltaX * k
      let dy = e.deltaY * k
      if (e.shiftKey && !dx) {
        dx = dy
        dy = 0
      }
      e.preventDefault()
      const zoom = e.ctrlKey || e.metaKey
      pending = pending
        ? { ...pending, dx: pending.dx + dx, dy: pending.dy + dy, clientX: e.clientX, clientY: e.clientY, zoom: pending.zoom || zoom }
        : { clientX: e.clientX, clientY: e.clientY, dx, dy, zoom }
      if (!raf) raf = requestAnimationFrame(apply)
    }
    el.addEventListener("wheel", onWheel, { capture: true, passive: false })
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true })
      if (raf) cancelAnimationFrame(raf)
      window.clearTimeout(idleTimer)
      el.removeAttribute("data-gesturing")
    }
  }, [])

  const project = (clientX: number, clientY: number): SketchPoint => {
    const r = surface.current?.getBoundingClientRect()
    const v = viewRef.current
    // 无界画布：世界坐标 = 屏幕 → 逆视口变换，不钳制
    return [round1(((clientX ?? 0) - (r?.left ?? 0) - v.x) / v.zoom), round1(((clientY ?? 0) - (r?.top ?? 0) - v.y) / v.zoom)]
  }

  const liveOf = (g: Gesture): SketchStroke => ({ id: "live", tool: g.tool as DrawTool, color: g.color, size: g.size, pts: preview(g.pts) })
  const flush = () => {
    const g = gesture.current
    if (g && g.tool !== "eraser") setLive(liveOf(g))
  }
  const schedule = () => {
    if (frame.current) return
    if (typeof requestAnimationFrame === "undefined") return flush()
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      flush()
    })
  }
  const eraseAt = (g: Gesture, x: number, y: number) => {
    const set = g.erase as Set<string>
    let changed = false
    for (const s of ctx.strokes) {
      if (!set.has(s.id) && strokeHit(s, x, y, 9)) {
        set.add(s.id)
        changed = true
      }
    }
    if (changed) setErasing(new Set(set))
  }
  const begin = (pointer: Gesture["pointer"], kind: string, pt: SketchPoint, eraser: boolean) => {
    const tool: SketchTool = eraser ? "eraser" : ctx.tool
    const g: Gesture = { pointer, kind, tool, color: ctx.color, size: ctx.size, pts: [pt], tail: null, erase: tool === "eraser" ? new Set() : null }
    gesture.current = g
    if (g.erase) eraseAt(g, pt[0], pt[1])
    else setLive(liveOf(g))
  }
  const extend = (pt: SketchPoint) => {
    const g = gesture.current
    if (!g) return
    const last = g.pts[g.pts.length - 1]
    if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < SAMPLE_GAP) {
      g.tail = pt
      return
    }
    g.tail = null
    g.pts.push(pt)
    if (g.erase) eraseAt(g, pt[0], pt[1])
    else schedule()
  }
  const end = (cancel: boolean) => {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    if (frame.current && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame.current)
    frame.current = 0
    setLive(null)
    if (g.erase) {
      setErasing(NO_IDS)
      if (!cancel && g.erase.size) {
        const gone = g.erase
        ctx.commit(ctx.strokes.filter((s) => !gone.has(s.id)), `Erased ${count(gone.size)}.`)
      }
      return
    }
    if (cancel || !isDrawTool(g.tool)) return
    if (g.tail) {
      const held = g.pts[g.pts.length - 1][2]
      g.pts.push(held !== undefined && g.tail[2] === undefined ? [g.tail[0], g.tail[1], held] : g.tail)
    }
    ctx.commit([...ctx.strokes, { id: ctx.nextId(), tool: g.tool, color: g.color, size: g.size, pts: thin(g.pts) }], "Stroke added.")
  }

  React.useEffect(() => {
    if (!interactive && gesture.current) end(true)
  })

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(e)
    if (!interactive || e.defaultPrevented) return
    const type = e.pointerType || "mouse"
    // panMode（查看器）：指针一律拖拽平移；中键 / Space+左键 = 平移（仅鼠标；画笔/触摸仍是绘制）
    const wantPan = panMode || (type === "mouse" && ((e.button ?? 0) === 1 || spaceRef.current))
    if (type === "mouse" && (e.button ?? 0) !== 0 && !wantPan) return
    if (type === "pen") {
      penSeen.current = e.timeStamp
      if (gesture.current?.kind === "touch") end(true)
    } else if (type === "touch" && e.timeStamp - penSeen.current < PALM_MS) return
    if (gesture.current) return
    e.currentTarget.focus({ preventScroll: true })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已释放等场景 setPointerCapture 会抛错，忽略即可 */
    }
    if (wantPan) {
      pan.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y }
      // 拖拽平移也是手势期直写 DOM（与 wheel 平移同法）：pointermove 每帧 setState = 卡
      e.currentTarget.closest("[data-slot='sketchpad-canvas']")?.setAttribute("data-gesturing", "")
      e.preventDefault()
      return
    }
    setCursor(null)
    const p = project(e.clientX, e.clientY)
    if (type === "pen" && e.pressure > 0) p[2] = Math.round(e.pressure * 100) / 100
    begin(e.pointerId, type, p, (type === "pen" && (e.buttons & 32) !== 0) || ctx.tool === "eraser")
    e.preventDefault()
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(e)
    if (e.pointerType === "pen") penSeen.current = e.timeStamp
    if (pan.current && pan.current.pointerId === e.pointerId) {
      applyViewDom({ x: pan.current.vx + (e.clientX - pan.current.sx), y: pan.current.vy + (e.clientY - pan.current.sy), zoom: viewRef.current.zoom })
      return
    }
    const g = gesture.current
    if (!g || g.pointer !== e.pointerId) return
    const list = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : []
    for (const c of list.length ? list : [e.nativeEvent]) {
      const p = project(c.clientX, c.clientY)
      if (e.pointerType === "pen" && c.pressure > 0) p[2] = Math.round(c.pressure * 100) / 100
      extend(p)
    }
  }
  const onUp = (cancel: boolean) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (cancel) onPointerCancel?.(e)
    else onPointerUp?.(e)
    if (e.pointerType === "pen") penSeen.current = e.timeStamp
    if (pan.current && pan.current.pointerId === e.pointerId) {
      pan.current = null
      // pan 手势结束：DOM 直写的最终视口同步回 React state（一次渲染）+ 持久化
      const v = viewRef.current
      setView(v)
      const host = e.currentTarget.closest("[data-slot='sketchpad-canvas']")
      if (host) host.removeAttribute("data-gesturing")
      return
    }
    const g = gesture.current
    if (!g || g.pointer !== e.pointerId) return
    if (!cancel) {
      const p = project(e.clientX, e.clientY)
      const held = g.pts[g.pts.length - 1][2]
      if (g.kind === "pen" && held !== undefined) p[2] = held
      if (g.pts.length > 1 || Math.hypot(p[0] - g.pts[0][0], p[1] - g.pts[0][1]) > 1) extend(p)
    }
    end(cancel)
  }
  const onLost = (e: React.PointerEvent<HTMLDivElement>) => {
    onLostPointerCapture?.(e)
    if (pan.current && pan.current.pointerId === e.pointerId) {
      pan.current = null
      // pan 被中断（指针捕获丢失）：同步最终视口 + 撤掉图层提升
      setView(viewRef.current)
      e.currentTarget.closest("[data-slot='sketchpad-canvas']")?.removeAttribute("data-gesturing")
    }
    if (gesture.current && gesture.current.pointer === e.pointerId) end(false)
  }

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    const k = e.key
    const mod = e.metaKey || e.ctrlKey
    if (mod && k.toLowerCase() === "z") {
      e.preventDefault()
      if (e.shiftKey) ctx.redo()
      else ctx.undo()
      return
    }
    if (mod && k.toLowerCase() === "y") {
      e.preventDefault()
      ctx.redo()
      return
    }
    if (!interactive || mod || e.altKey && !k.startsWith("Arrow") || e.target !== e.currentTarget) return
    // 查看器模式：禁键盘落笔（Enter）；工具/宽度键无实际效果，保留 0（取景）/ +-（缩放）
    if (panMode && k === "Enter") return
    const tool = KEY_TOOL[k.toLowerCase()]
    if (tool && k.length === 1) {
      if (ctx.tools.includes(tool)) {
        e.preventDefault()
        ctx.selectTool(tool)
        ctx.say(`${TOOL_LABEL[tool]}.`)
      }
      return
    }
    if (k === "[" || k === "]") {
      e.preventDefault()
      const i = SIZE_STEPS.reduce((best, v, j) => (Math.abs(v - ctx.size) < Math.abs(SIZE_STEPS[best] - ctx.size) ? j : best), 0)
      const next = SIZE_STEPS[Math.min(SIZE_STEPS.length - 1, Math.max(0, i + (k === "]" ? 1 : -1)))]
      ctx.setSize(next)
      ctx.say(`${SIZE_LABEL[sizeName(next) ?? "medium"]} line.`)
      return
    }
    if (k.startsWith("Arrow")) {
      e.preventDefault()
      const d = e.shiftKey ? 32 : e.altKey ? 2 : 8
      const [x, y] = cursor ?? [W / 2, H / 2]
      // 无界画布：光标可移出首页画框
      const nx = round1(x + (k === "ArrowRight" ? d : k === "ArrowLeft" ? -d : 0))
      const ny = round1(y + (k === "ArrowDown" ? d : k === "ArrowUp" ? -d : 0))
      setCursor([nx, ny])
      if (gesture.current?.pointer === "key") extend([nx, ny])
      return
    }
    if (k === "+" || k === "=" || k === "-" || k === "0") {
      e.preventDefault()
      if (k === "0") ctx.viewportApiRef.current?.fitHome()
      else ctx.viewportApiRef.current?.zoomBy(k === "-" ? 1 / 1.2 : 1.2)
      return
    }
    if (k === "Enter") {
      e.preventDefault()
      const at = cursor ?? [W / 2, H / 2]
      setCursor([at[0], at[1]])
      if (gesture.current?.pointer === "key") end(false)
      else if (!gesture.current) {
        begin("key", "key", [at[0], at[1]], ctx.tool === "eraser")
        ctx.say(ctx.tool === "eraser" ? "Eraser down." : "Pen down.")
      }
      return
    }
    if (k === "Escape") {
      if (gesture.current?.pointer === "key") {
        end(true)
        ctx.say("Stroke canceled.")
      } else setCursor(null)
    }
  }

  const dropKeyboard = (e: React.FocusEvent<HTMLDivElement>) => {
    onBlur?.(e)
    if (gesture.current?.pointer === "key") end(false)
    if (!e.currentTarget.contains(e.relatedTarget)) setCursor(null)
  }

  const timing = React.useMemo<ReplayTiming[] | null>(() => {
    if (!ctx.replaying) return null
    let t = 0.2
    return ctx.strokes.map((s) => {
      const dur = Math.min(2.4, Math.max(0.14, strokeMarkup(s, { tier }).length / (420 * ctx.replaySpeed)))
      const r = { delay: t, dur }
      t += dur + 0.08
      return r
    })
  }, [ctx.replaying, ctx.strokes, ctx.replaySpeed, tier])
  const liveMarkup = React.useMemo(() => (live ? stripDrawMasks(strokeMarkup(live, { tier, live: true }).svg) : ""), [live, tier])
  const cursorSvg = React.useMemo(() => cursorMarkup(uid), [uid])

  // 视口裁剪：settle 时合成器要按新缩放比整层重栅格化，每笔 = 3 条被 mask 的 path + 笔刷
  // 纹理 mask，成本随缩放平方增长——屏幕外的笔迹/文本根本不进 DOM，栅格化只付可见部分。
  // 手势期 DOM 直写不重渲染，落定 setView 时才换裁剪窗口（25% 边距覆盖小步平移）；
  // 回放（timing 非空）关闭裁剪，回放要全画布按笔顺播
  const viewRect = React.useMemo<ViewRect>(() => {
    const [pw, ph] = pane
    const z = view.zoom || 1
    const x0 = -view.x / z
    const y0 = -view.y / z
    const x1 = (pw - view.x) / z
    const y1 = (ph - view.y) / z
    const m = Math.max(x1 - x0, y1 - y0) * 0.15 + 60
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m }
  }, [view, pane])

  const a11y = interactive
    ? ({ role: "application", "aria-roledescription": "drawing canvas", "aria-label": label, "aria-describedby": help, tabIndex: 0 } as const)
    : ({ role: "img", "aria-label": `${label}, ${count(ctx.strokes.length)}`, "aria-disabled": ctx.disabled || undefined } as const)

  const z = view.zoom

  return (
    <div
      data-slot="sketchpad-canvas"
      data-panmode={panMode ? "" : undefined}
      data-tool={interactive ? ctx.tool : undefined}
      data-drawing={live ? "" : undefined}
      ref={useMergedRef<HTMLDivElement>(hostRef, ref, ctx.canvasRef)}
      {...hostProps}
      {...a11y}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp(false)}
      onPointerCancel={onUp(true)}
      onLostPointerCapture={onLost}
      onKeyDown={onKey}
      onBlur={dropKeyboard}
      className={cn("relative isolate touch-none select-none overflow-hidden", panMode ? "cursor-grab" : interactive ? (ctx.tool === "eraser" ? "cursor-cell" : "cursor-crosshair") : "cursor-default", className)}
      style={styleProp}
      {...props}
    >
      {node}
      {/* dot-grid 纸面桌：与 workflow 图页完全同款——固定满铺 looseleaf Paper（真纸面：
          底色 + 纤维纹理 + 手绘感点阵），不随视口平移缩放，笔迹/节点像纸片一样在桌面上移动 */}
      <Paper stock="dot-grid" tilt={false} shadow="none" className="absolute inset-0" aria-hidden />
      {/* 世界锚定层：children 随视口平移缩放。几何与 surface 同构（布局 = 面板、
          transform 见上方"视口层几何"注释）；children 坐标以已提交窗口原点为基准——
          children 若用绝对世界坐标，需按 committed 原点偏移换算 */}
      <div
        ref={worldRef}
        data-slot="sketchpad-world"
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: pane[0], height: pane[1], transform: `translate(${view.x + committed.vx * z}px, ${view.y + committed.vy * z}px) scale(${z / (committed.zw || 1)})` }}
      >
        {children}
      </div>
      {/* 内容缩放比由 viewBox 承担且慢提交（见上方"视口层几何"注释）：布局恒等于面板，
          元素框恒覆盖视口、栅格面积恒定；交互期由元素 transform 精确补偿 */}
      <svg
        ref={surface}
        data-slot="sketchpad-surface"
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute left-0 top-0 forced-color-adjust-none"
        viewBox={`${committed.vx} ${committed.vy} ${pane[0] / (committed.zw || 1)} ${pane[1] / (committed.zw || 1)}`}
        style={{ width: pane[0], height: pane[1], transform: `translate(${view.x + committed.vx * z}px, ${view.y + committed.vy * z}px) scale(${z / (committed.zw || 1)})`, transformOrigin: "0 0" }}
      >
        {ctx.texts.length > 0 && (
          <g data-slot="sketchpad-texts">
            {ctx.texts.map((t) =>
              timing || textVisible(viewRect, t) ? (
                <text
                  key={t.id}
                  data-text={t.id}
                  x={t.x}
                  y={t.y + t.size * TEXT_BASELINE_K}
                  fill={`var(--ll-${t.color})`}
                  style={{ fontFamily: TEXT_FONT, fontSize: t.size }}
                >
                  {t.text}
                </text>
              ) : null,
            )}
          </g>
        )}
        {ctx.icons.length > 0 && <DocIconsLayer icons={ctx.icons} />}
        <g data-slot="sketchpad-strokes" key={ctx.replayKey}>
          {strokeInfos.map(({ s, m }, i) =>
            timing || bboxVisible(viewRect, m.bbox) ? (
              <StrokeShape key={s.id} stroke={s} m={m} dim={erasing.has(s.id)} replay={timing?.[i] ?? null} maskId={`ll-replay-${uid}-${i}`} />
            ) : null,
          )}
        </g>
        {live ? <g data-slot="sketchpad-live" dangerouslySetInnerHTML={{ __html: liveMarkup }} /> : null}
        {cursor ? <g data-slot="sketchpad-cursor" transform={`translate(${cursor[0]} ${cursor[1]})`} dangerouslySetInnerHTML={{ __html: cursorSvg }} /> : null}
      </svg>
      <span id={help} className="sr-only">
        Draw with a pointer, or use the arrow keys to move a cursor and Enter to put the pen down and lift it. F, B, P, M, H and E pick a tool, the bracket keys change the width, Control Z undoes. Wheel pans, Control wheel zooms, Space drag or middle drag pans, 0 resets the view.
      </span>
      <span role="status" className="sr-only">
        {ctx.announce}
      </span>
    </div>
  )
}

export {
  Sketchpad,
  SketchpadToolbar,
  SketchpadTools,
  SketchpadTool,
  SketchpadColors,
  SketchpadColor,
  SketchpadSizes,
  SketchpadSize,
  SketchpadUndo,
  SketchpadRedo,
  SketchpadClear,
  SketchpadCanvas,
  useSketchpad,
}
export type { SketchpadProps, SketchpadCanvasProps, SketchpadHandle, SketchStroke, SketchText, SketchTool, SketchColor, SketchPoint, ExportOptions as SketchpadExportOptions }
