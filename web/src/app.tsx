import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Select as LlSelect,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SketchColor, SketchStroke, SketchText, SketchTool, SketchpadView } from "@/components/ui/sketchpad";
import {
  Sketchpad,
  SketchpadCanvas,
  SketchpadClear,
  SketchpadColors,
  SketchpadRedo,
  SketchpadSizes,
  SketchpadToolbar,
  SketchpadTools,
  SketchpadUndo,
  clampZoom,
  type SketchpadHandle,
} from "@/components/ui/sketchpad";
import { DAEMON_BASE } from "./base";

/**
 * 画板页：looseleaf Sketchpad 组件全页铺开 + 画板后端同步（多画布）。
 * 后端（@content-forge/sketchpad canvas-backend）是笔迹的事实源，画布按 id（创建时刻
 * YYYYMMDDHHmmss）隔离：右上角 Select 切换/新建画布；MCP（agent）经后端 API 带 canvas id 作画，
 * 并发 agent 各绑一块画布互不影响。后端不可达时自动降级为纯本地模式，笔迹仅存内存。
 */

interface DocState {
  rev: number;
  width: number;
  height: number;
  tool: SketchTool;
  color: SketchColor;
  size: number;
  strokes: SketchStroke[];
  texts: SketchText[];
}

interface CanvasMeta {
  id: string;
  updatedAt: string;
  strokes: number;
}

/** API 前缀：守护进程托管时走 __DAEMON_BASE__/sketchpad/api；vite dev 走 /sketchpad/api（代理）；其它同源相对路径 */
const API = `${DAEMON_BASE}/sketchpad/api`;

const LOCAL_DOC: DocState = { rev: 0, width: 1040, height: 620, tool: "felt", color: "ink", size: 1, strokes: [], texts: [] };

/** 画布 id（YYYYMMDDHHmmss）→ 人类可读标签 */
function canvasLabel(c: CanvasMeta): string {
  const d = c.id;
  const at = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
  return `${at} · ${c.strokes} 笔`;
}

/** 每块画布的视口（平移+缩放）存 localStorage——不进文档，避免视口操作空转 rev */
const viewKey = (canvasId: string | null) => `cf-sketchpad-view-${canvasId ?? "local"}`;
const HOME_VIEW: SketchpadView = { x: 0, y: 0, zoom: 1 };

/** 返回 null = 无保存视口（首帧交给画布 autoFit 适配首页画框） */
function loadView(canvasId: string | null): SketchpadView | null {
  try {
    const raw = localStorage.getItem(viewKey(canvasId));
    if (!raw) return null;
    const v = JSON.parse(raw) as SketchpadView;
    if (typeof v.x !== "number" || typeof v.y !== "number" || typeof v.zoom !== "number") return null;
    return { x: v.x, y: v.y, zoom: clampZoom(v.zoom) };
  } catch {
    return null;
  }
}

/** 新建画布按钮里的加号（与 workflow 图标同形的内联 SVG，避免跨 app 引用） */
function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** 折叠工具栏的把手图标（铅笔，内联 SVG 避免跨 app 引用） */
function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

/** content-forge 套件 logo（workflow AppShell 同形，内联避免跨 app 引用） */
function LogoIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.9" y="1.9" width="12.2" height="12.2" rx="2.6" />
      <path d="M6.3 4.8v6.4l5.2-3.2Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SketchpadPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const canvasParam = searchParams.get("c");
  /** 实际生效的画布 id（?c= 参数校验过存在后落定；无参数 = 后端活动画布） */
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [canvases, setCanvases] = useState<CanvasMeta[]>([]);
  const [doc, setDoc] = useState<DocState | null>(null);
  const [offline, setOffline] = useState(false);
  const [clients, setClients] = useState(0);
  /** 回放句柄：调 replay() 即按笔顺回放整幅画（每笔按几何长度分时长，非录制时的真实速度） */
  const apiRef = useRef<SketchpadHandle>(null);
  /** 无限画布视口（受控传给 Sketchpad；随画布 id 持久化到 localStorage） */
  const [view, setView] = useState<SketchpadView>(HOME_VIEW);
  /** 回放倍速：组件按此分母缩短每笔时长；回放中切换会让动画按新时长重排（当前位置跳变） */
  const [replaySpeed, setReplaySpeed] = useState(1);
  /** 左侧工具栏折叠态：默认收起，点把手展开 */
  const [railOpen, setRailOpen] = useState(false);
  /** 已知的服务端 rev：自己的变更由 PUT/POST 响应先行更新，SSE 里相同的 rev 不再回流拉取 */
  const revRef = useRef(-1);
  /** 本地已知的文本元素（agent-only；PUT 回流时随 payload 原样带回，清空时置 []） */
  const textsRef = useRef<SketchText[]>([]);
  /** SSE 推送去抖：等在途 PUT 响应先落 revRef，避免自己刚画的笔迹被当成远端变更回流 */
  const sseTimer = useRef<number | null>(null);

  const applyDoc = useCallback((d: DocState) => {
    revRef.current = d.rev;
    textsRef.current = d.texts ?? [];
    setDoc(d);
  }, []);

  /* 视口随画布切换：载入该画布上次保存的视口；无保存时 autoFit 交画布首帧适配；变更即写回 localStorage */
  const [autoFit, setAutoFit] = useState(true);
  const updateView = useCallback(
    (v: SketchpadView) => {
      setView(v);
      setAutoFit(false);
      try {
        localStorage.setItem(viewKey(canvasId), JSON.stringify(v));
      } catch {
        /* 存不了就算了（隐私模式等），视口仍是会话内有效 */
      }
    },
    [canvasId],
  );
  useEffect(() => {
    const saved = loadView(canvasId);
    setAutoFit(!saved);
    setView(saved ?? HOME_VIEW);
  }, [canvasId]);

  /* 画布解析 + 初始文档：?c= 校验存在（无效参数回落活动画布并改写 URL）；拉不到即进入本地模式 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list: { canvases: CanvasMeta[]; active: string } = await fetch(`${API}/canvases`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
        if (!alive) return;
        setCanvases(list.canvases);
        const want = canvasParam && list.canvases.some((c) => c.id === canvasParam) ? canvasParam : list.active;
        setCanvasId(want);
        if (want !== canvasParam) setSearchParams(want ? { c: want } : {}, { replace: true });
        const { doc: d, clients: c } = await fetch(`${API}/canvases/${want}/doc`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
        if (!alive) return;
        setClients(c ?? 0);
        applyDoc(d);
      } catch {
        if (!alive) return;
        setOffline(true);
        setCanvasId(null);
        setDoc(LOCAL_DOC);
      }
    })();
    return () => {
      alive = false;
    };
  }, [canvasParam, applyDoc, setSearchParams]);

  /* SSE 订阅（按画布）：rev 变化（去抖后仍与本地已知不同）才拉全量文档 */
  useEffect(() => {
    if (offline || !canvasId) return;
    const es = new EventSource(`${API}/canvases/${canvasId}/events`);
    es.onmessage = (e) => {
      const rev = Number(JSON.parse(e.data)?.rev);
      if (!Number.isFinite(rev)) return;
      if (sseTimer.current !== null) window.clearTimeout(sseTimer.current);
      sseTimer.current = window.setTimeout(() => {
        sseTimer.current = null;
        if (rev === revRef.current) return;
        fetch(`${API}/canvases/${canvasId}/doc`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then(({ doc: d, clients: c }: { doc: DocState; clients: number }) => {
            setClients(c ?? 0);
            applyDoc(d);
          })
          .catch(() => setOffline(true));
      }, 150);
    };
    return () => {
      if (sseTimer.current !== null) window.clearTimeout(sseTimer.current);
      es.close();
    };
  }, [offline, canvasId, applyDoc]);

  /** 本页笔迹变更（画一笔/擦除/撤销/重做/清空）→ 全量 PUT 覆盖（带 baseRev 乐观锁，按画布）。
   *  文本元素（agent-only）随 PUT 原样回流：清空时置 []，其余场景沿用本地已知值。
   *  409 = 服务端 rev 已被别的页面/agent 推进：重拉最新文档，把本地未同步的笔迹按 id 并入后重试一次。
   *  合并语义是按 id 取并集——双方新增都保留；极少数「删除 vs 新增」竞态会复活被删笔迹，可再删一次，不做双向意图推断。 */
  const pushStrokes = useCallback(
    (strokes: SketchStroke[]) => {
      const texts = strokes.length ? textsRef.current : [];
      textsRef.current = texts;
      setDoc((d) => (d ? { ...d, strokes, texts } : d));
      if (offline || !canvasId) return;
      const url = `${API}/canvases/${canvasId}/strokes`;
      const attempt = (baseRev: number, payload: SketchStroke[], texts: SketchText[], allowRetry: boolean): Promise<{ rev: number }> =>
        fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRev, strokes: payload, texts }),
        }).then(async (r) => {
          if (r.status === 409) {
            const { doc: fresh }: { doc: DocState } = await fetch(`${API}/canvases/${canvasId}/doc`).then((x) => {
              if (!x.ok) throw new Error(String(x.status));
              return x.json();
            });
            const ids = new Set(fresh.strokes.map((s) => s.id));
            const merged = [...fresh.strokes, ...payload.filter((s) => !ids.has(s.id))];
            revRef.current = fresh.rev;
            textsRef.current = fresh.texts ?? [];
            setDoc((d) => (d ? { ...d, strokes: merged, texts: textsRef.current, rev: fresh.rev } : d));
            if (!allowRetry) throw new Error("sketchpad sync conflict");
            return attempt(fresh.rev, merged, textsRef.current, false);
          }
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
      attempt(revRef.current, strokes, texts, true)
        .then(({ rev }: { rev: number }) => {
          revRef.current = rev;
        })
        .catch(() => setOffline(true));
    },
    [offline, canvasId],
  );

  /** 工具栏偏好（画笔/颜色/粗细）→ POST 同步（荧光笔自动换色会连发两次，幂等） */
  const pushPrefs = useCallback(
    (patch: Partial<Pick<DocState, "tool" | "color" | "size">>) => {
      setDoc((d) => (d ? { ...d, ...patch } : d));
      if (offline || !canvasId) return;
      fetch(`${API}/canvases/${canvasId}/prefs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(({ rev }: { rev: number }) => {
          revRef.current = rev;
        })
        .catch(() => setOffline(true));
    },
    [offline, canvasId],
  );

  /** 新建画布：后端创建并把 ?c= 指过去（画布解析 effect 会随之加载空文档） */
  const createCanvas = useCallback(async () => {
    try {
      const r: { id: string } = await fetch(`${API}/canvases`, { method: "POST" }).then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      });
      setSearchParams({ c: r.id });
    } catch {
      setOffline(true);
    }
  }, [setSearchParams]);

  /** 展开画布列表时刷新（agent 可能在别处新建了画布） */
  const refreshCanvases = useCallback(async () => {
    if (offline) return;
    try {
      const list: { canvases: CanvasMeta[] } = await fetch(`${API}/canvases`).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      });
      setCanvases(list.canvases);
    } catch {
      /* 列表刷新失败不打断：沿用旧列表 */
    }
  }, [offline]);

  if (!doc) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-sm text-muted-foreground">
        画板加载中…
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col">
      {/* 顶栏：workflow AppShell 同款磨砂条（纸色 + 铅笔发丝线），右侧画布切换/新建 */}
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-paper/40 px-6 backdrop-blur-md">
        <span className="flex items-center gap-2 text-[15px] text-ink">
          <LogoIcon />
          <span className="font-semibold">content-forge</span>
          <span className="text-ink-muted">/</span>
          <span className="text-ink-muted">sketchpad</span>
        </span>
        {offline ? (
          <p className="text-xs text-muted-foreground">
            画板后端未连接（直连模式或服务未启动），当前为本地模式：笔迹只保存在本页内存。
          </p>
        ) : (
          <p className="ml-4 truncate text-xs text-muted-foreground">
            rev {doc.rev}
            {clients > 0 ? ` · ${clients} 个页面在线` : ""} · agent 可经 sketchpad MCP 带同一画布 id 作画
          </p>
        )}
        {!offline && (
          <LlSelect
            value={canvasId ?? undefined}
            onValueChange={(id) => setSearchParams({ c: id })}
            onOpenChange={(open) => open && void refreshCanvases()}
          >
            <SelectTrigger className="ml-auto min-w-[230px]" aria-label="画布">
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              position="popper"
              className="max-h-none [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden"
            >
              {canvases.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {canvasLabel(c)}
                </SelectItem>
              ))}
              {/* 历史画布列表，分隔线下方是「新建画布」动作（同 workflow 的新建执行） */}
              {canvases.length > 0 && <SelectSeparator />}
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void createCanvas()}>
                <PlusIcon />
                新建画布
              </Button>
            </SelectContent>
          </LlSelect>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        <Sketchpad
          className="absolute inset-0"
          width={doc.width}
          height={doc.height}
          view={view}
          onViewChange={updateView}
          seed={`cf-sketchpad-${canvasId ?? "local"}`}
          apiRef={apiRef}
          replaySpeed={replaySpeed}
          value={doc.strokes}
          texts={doc.texts}
          onValueChange={pushStrokes}
          tool={doc.tool}
          onToolChange={(tool) => pushPrefs({ tool })}
          color={doc.color}
          onColorChange={(color) => pushPrefs({ color })}
          size={doc.size}
          onSizeChange={(size) => pushPrefs({ size })}
        >
          {/* 左侧折叠工具栏：默认收起，点把手展开；绝对定位悬浮在画布上 */}
          <div className="absolute left-3 top-3 z-10 flex flex-col items-start gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              aria-expanded={railOpen}
              onClick={() => setRailOpen((o) => !o)}
              title={railOpen ? "收起工具栏" : "展开工具栏"}
            >
              <PencilIcon />
              工具
            </Button>
            {railOpen && (
              <SketchpadToolbar className="w-[248px] flex-col !items-stretch gap-3 p-3 shadow-xl">
                <SketchpadTools />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <SketchpadColors />
                  <SketchpadSizes />
                </div>
                <div className="h-px w-full bg-[var(--border)]" aria-hidden />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={!doc.strokes.length}
                    onClick={() => apiRef.current?.replay()}
                  >
                    回放
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setReplaySpeed((s) => (s === 0.5 ? 1 : s === 1 ? 2 : s === 2 ? 4 : 0.5))}
                    title="回放倍速（点击切换 0.5× → 1× → 2× → 4×）"
                  >
                    {replaySpeed}×
                  </Button>
                  <SketchpadUndo />
                  <SketchpadRedo />
                  <SketchpadClear>清空</SketchpadClear>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" type="button" onClick={() => apiRef.current?.zoomBy(1 / 1.2)} title="缩小（快捷键 -）">
                    −
                  </Button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground tabular-nums hover:text-foreground"
                    onClick={() => apiRef.current?.fitHome()}
                    title="缩放百分比，点击回到首页画框（快捷键 0）"
                  >
                    {Math.round(view.zoom * 100)}%
                  </button>
                  <Button variant="ghost" size="sm" type="button" onClick={() => apiRef.current?.zoomBy(1.2)} title="放大（快捷键 +）">
                    +
                  </Button>
                </div>
              </SketchpadToolbar>
            )}
          </div>
          {/* 无限画布：满铺面板，滚轮平移 / ctrl+滚轮缩放 / 中键或 Space 拖拽平移；首页画纸固定在原点 */}
          <SketchpadCanvas className="min-h-0 flex-1" paper="dots" label="Sketchpad" autoFit={autoFit} />
        </Sketchpad>
      </div>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/sketchpad" element={<SketchpadPage />} />
      {/* 直开入口路径（如 dev 下 /apps/sketchpad/）也落到同一页 */}
      <Route path="*" element={<SketchpadPage />} />
    </Routes>
  );
}
