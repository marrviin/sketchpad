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
  type SketchpadHandle,
} from "@/components/ui/sketchpad";
import { DAEMON_BASE } from "./base";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

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
  icons?: SketchIcon[];
  /** 语义分组（叙事层级）：随文档整体返回，传给 Sketchpad 供回放编排 */
  groups?: DocGroup[];
}

interface DocGroup {
  name: string;
  strokeIds: string[];
  textIds: string[];
  iconIds?: string[];
  order?: number;
}

interface SketchIcon {
  id: string;
  name: string;
  x: number;
  y: number;
  size: number;
  color: SketchColor;
}

interface CanvasMeta {
  id: string;
  updatedAt: string;
  strokes: number;
}

/** API 前缀：守护进程托管时走 __DAEMON_BASE__/sketchpad/api；vite dev 走 /sketchpad/api（代理）；其它同源相对路径 */
const API = `${DAEMON_BASE}/sketchpad/api`;

const LOCAL_DOC: DocState = { rev: 0, width: 1040, height: 620, tool: "felt", color: "ink", size: 1, strokes: [], texts: [], icons: [] };

/** 画布 id（YYYYMMDDHHmmss）→ 人类可读标签 */
function canvasLabel(c: CanvasMeta): string {
  const d = c.id;
  const at = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
  return at;
}

/** 首屏/切画布视口一律回默认原点：交给画布 autoFit / fitHome 做内容取景（fit+center） */
const HOME_VIEW: SketchpadView = { x: 0, y: 0, zoom: 1 };

/** 新建画布按钮里的加号（与 workflow 图标同形的内联 SVG，避免跨 app 引用） */
function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
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
  /** 首屏揭示门：文档首次渲染的栅格按瓦片自上而下逐块上屏（浏览器行为，控制不了顺序），
   *  期间把笔迹层藏住、栅格完成后原子显现，避免"上半先出来"的渐进观感。
   *  只在加载/切换画布时触发；期间 agent 的增量笔迹照常即时可见 */
  const [canvasRevealed, setCanvasRevealed] = useState(false);
  /** 已做过揭示门的画布 id：同一画布内 agent 增量更新不重新触发揭示 */
  const revealedFor = useRef<string | null>(null);
  /** 回放句柄：调 replay() 即按笔顺回放整幅画（每笔按几何长度分时长，非录制时的真实速度） */
  const apiRef = useRef<SketchpadHandle>(null);
  /** 无限画布视口（受控传给 Sketchpad；随画布 id 持久化到 localStorage） */
  const [view, setView] = useState<SketchpadView>(HOME_VIEW);
  /** 回放倍速：组件按此分母缩短每笔时长（查看器模式无 UI 入口，默认 8× 便于演示） */
  const replaySpeed = 8;
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

  /* 视口随画布切换：一律回默认原点，交画布 autoFit 居中取景；用户手势后由画布停止接管 */
  const updateView = useCallback(
    (v: SketchpadView) => {
      setView(v);
    },
    [],
  );
  useEffect(() => {
    setView(HOME_VIEW);
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
        const { doc: d } = await fetch(`${API}/canvases/${want}/doc`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
        if (!alive) return;
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
          .then(({ doc: d }: { doc: DocState }) => {
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

  /* 首屏揭示门：内容（笔迹/文本）首次到位后藏住笔迹层 450ms——瓦片栅格化在这段窗口内
     完成，揭示时原子显现。同一画布只门一次（agent 增量更新不重门）；换画布重门；
     空画布（无笔迹可栅格）直接显现 */
  const hasContent = (doc?.strokes.length ?? 0) > 0 || (doc?.texts.length ?? 0) > 0;
  useEffect(() => {
    const key = canvasId ?? "local";
    if (revealedFor.current !== key) {
      // 新画布：先进入 pending（内容未到也要藏住，防止内容到达瞬间可见渐进栅格）
      revealedFor.current = key;
      setCanvasRevealed(false);
    }
    if (!hasContent) {
      // 文档已到但确为空画布：无需遮罩
      if (doc || offline) setCanvasRevealed(true);
      return;
    }
    const t = window.setTimeout(() => setCanvasRevealed(true), 450);
    return () => window.clearTimeout(t);
  }, [hasContent, canvasId, doc, offline]);

  /* 叙事回放（?replay=1）：揭示门完成后自动回放一次——按叙事层级逐组逐笔播放（演示/验证入口，
     不提供页面按钮）。同一画布只播一次；切画布重置 */
  const replayParam = searchParams.get("replay");
  const replayedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!replayParam || !canvasId || !canvasRevealed) return;
    if (replayedFor.current === canvasId) return;
    replayedFor.current = canvasId;
    const t = window.setTimeout(() => apiRef.current?.replay(), 120);
    return () => window.clearTimeout(t);
  }, [replayParam, canvasId, canvasRevealed]);

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
    // 文档未到位：空白过场（不做任何加载提示，fit 揭示门会让内容就绪后直接出现）
    return <main className="min-h-dvh" />;
  }

  return (
    <main className="flex h-dvh flex-col">
      {/* 顶栏：workflow AppShell 同款磨砂条（纸色 + 铅笔发丝线），右侧画布切换/新建 */}
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-paper/40 px-6 backdrop-blur-md">
        <span className="flex items-center gap-2 text-[15px] text-ink">
          <LogoIcon />
          <span className="font-semibold">content-forge</span>
          <span className="text-ink-muted">/</span>
          <span className="text-ink-muted">sketchpad</span>
        </span>
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
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Sketchpad
              className="absolute inset-0"
              data-canvas-revealed={canvasRevealed ? "ready" : "pending"}
              width={doc.width}
              height={doc.height}
              view={view}
              onViewChange={updateView}
              seed={`cf-sketchpad-${canvasId ?? "local"}`}
              apiRef={apiRef}
              replaySpeed={replaySpeed}
              panMode
              value={doc.strokes}
              texts={doc.texts}
              icons={doc.icons}
              groups={doc.groups}
              onValueChange={pushStrokes}
              tool={doc.tool}
              onToolChange={(tool) => pushPrefs({ tool })}
              color={doc.color}
              onColorChange={(color) => pushPrefs({ color })}
              size={doc.size}
              onSizeChange={(size) => pushPrefs({ size })}
            >
              {/* 查看器模式：页面只负责展示与导航（拖拽/滚轮），内容全部经 agent 操作 */}
              <SketchpadCanvas className="min-h-0 flex-1" label="Sketchpad" autoFit />
            </Sketchpad>
          </ContextMenuTrigger>
          {/* 右键菜单：叙事回放（空画布禁用） */}
          <ContextMenuContent className="w-40">
            <ContextMenuItem disabled={!hasContent} onSelect={() => apiRef.current?.replay()}>
              回放
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
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
