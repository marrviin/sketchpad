/**
 * 画板后端：画板状态的唯一事实源（CanvasStore 多画布）+ REST API + SSE 推送 + （可选）静态页面服务。
 * spawn 方：daemon（mount /sketchpad 反代）或 `sketchpad ui` 的本地常驻（均监听临时端口并向 stdout
 * 公告 BACKEND_PORT=<port>）。入站路径两种形态都收：/sketchpad/…（daemon mount 反代）与裸 /…（独立模式）。
 * 画布按 id（创建时刻 YYYYMMDDHHmmss）隔离，各自落盘 <项目根>/.content-forge/sketchpad/<id>.json；
 * 路由两种形态：/api/canvases/<id>/<op> 指定画布；不带 id 的 /api/<op> 命中「活动画布」（旧调用兼容）。
 * 多画布的意义：多个 agent 并发作画时各绑一块画布，rev/撤销栈/笔迹互不影响。
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  COLOR_LABEL,
  DRAW_TOOLS,
  SKETCH_COLORS,
  SKETCH_TOOLS,
  TOOL_LABEL,
  sizeSchema,
  strokeSchema,
  textSchema,
  shapeSchema,
  type DrawTool,
  type SketchColor,
  type SketchStroke,
  type SketchText,
  type SketchTool,
} from "./contract.js";
import { CanvasContent, CanvasState, CanvasStore, buildStrokes, clampPts, normalizeShape } from "./document.js";
import { projectRoot } from "./paths.js";
import { z } from "zod";

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data || "{}"));
  });
}

const prefsSchema = z
  .object({
    tool: z.enum(SKETCH_TOOLS).optional(),
    color: z.enum(SKETCH_COLORS).optional(),
    size: sizeSchema.optional(),
  })
  .refine((v) => v.tool !== undefined || v.color !== undefined || v.size !== undefined, {
    message: "tool / color / size 至少给一项",
  });

const drawSchema = z.object({
  shapes: z.array(shapeSchema).min(1).max(200),
  /** 坐标单位：px = 画布像素（默认）；norm = 0~1 归一化（相对画布宽高，长度类字段同比例缩放） */
  unit: z.enum(["px", "norm"]).optional(),
  tool: z.enum(DRAW_TOOLS).optional(),
  color: z.enum(SKETCH_COLORS).optional(),
  size: sizeSchema.optional(),
  /** 语义分组名：这批形状归入该组，以后按名擦/按名改（如 "数据库" "登录按钮"） */
  group: z.string().min(1).max(40).optional(),
});

const putSchema = z.object({
  /** 客户端发起覆盖时已知的 rev（乐观锁）：与服务端当前 rev 不一致即 409，页面重拉合并后重试 */
  baseRev: z.number().int().min(0),
  strokes: z.array(strokeSchema),
  /** 文本元素（页面暂不创建文本，PUT 回流原样带回；省略 = 保留现有文本） */
  texts: z.array(textSchema).optional(),
});

const countSchema = z.object({ count: z.number().int().min(1).max(100).optional() });

/** 落笔画笔不能是橡皮（橡皮只擦不画）；默认画笔是橡皮时回落毡头笔 */
const drawTool = (t: SketchTool): DrawTool => (t === "eraser" ? "felt" : t);

/** 两份笔迹列表是否完全相同（逐笔逐点比较，键序无关）：用于幂等去重 */
function sameStrokes(a: SketchStroke[], b: SketchStroke[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    if (!t || s.id !== t.id || s.tool !== t.tool || s.color !== t.color || s.size !== t.size || s.pts.length !== t.pts.length) return false;
    return s.pts.every((p, j) => {
      const q = t.pts[j];
      return !!q && p[0] === q[0] && p[1] === q[1] && (p[2] ?? 0) === (q[2] ?? 0);
    });
  });
}

/** 两份内容是否完全相同（笔迹 + 文本）：strokes 同形 + texts 逐字段比较 */
function sameContent(a: CanvasContent, b: CanvasContent): boolean {
  if (!sameStrokes(a.strokes, b.strokes)) return false;
  if (a.texts.length !== b.texts.length) return false;
  return a.texts.every((t, i) => {
    const u = b.texts[i];
    return !!u && t.id === u.id && t.x === u.x && t.y === u.y && t.size === u.size && t.color === u.color && t.text === u.text;
  });
}

export interface BackendOptions {
  /** 端口（缺省 0 = 临时端口） */
  port?: number;
  /** 前端构建产物目录（web/dist）；给定时非 /api 路径按 SPA 静态服务（缺省纯 API，供旧网关 spawn） */
  staticDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** 静态文件 + SPA fallback（index.html）。资产文件名带 hash，命中即 immutable 缓存 */
function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  const rel = pathname.replace(/^\/+/, "") || "index.html";
  const file = path.join(root, rel);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    json(res, { error: "not found" }, 404);
    return;
  }
  let target = resolved;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) target = path.join(root, "index.html"); // SPA fallback
  const ext = path.extname(target).toLowerCase();
  const immutable = /-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf|png|jpg|svg|webp)$/.test(target);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
  });
  fs.createReadStream(target).pipe(res);
}

export function startBackend(o: BackendOptions = {}): http.Server {
  const store = new CanvasStore(projectRoot);
  /** 每个画布各自的 SSE 在线页面集合（页面比对该画布 rev 决定是否拉取） */
  const clients = new Map<string, Set<ServerResponse>>();
  const broadcast = (id: string) => {
    const st = store.get(id);
    const data = `data: ${JSON.stringify({ rev: st?.doc.rev ?? -1 })}\n\n`;
    for (const c of clients.get(id) ?? []) c.write(data);
  };
  const clientCount = (id: string): number => clients.get(id)?.size ?? 0;

  /** 画布资源的处理器集合：路由层解析出画布后按 op 分发（/api/canvases/<id>/<op> 与不带 id 的 /api/<op> 共用） */
  const handleOp = (
    res: ServerResponse,
    id: string,
    st: CanvasState,
    op: string,
    method: string,
    body: Record<string, unknown>,
  ): void => {
    if (op === "doc") {
      json(res, { id, doc: st.doc, clients: clientCount(id) });
      return;
    }
    if (op === "strokes" && method === "PUT") {
      const parsed = putSchema.safeParse(body);
      if (!parsed.success) {
        json(res, { error: `笔迹数据不合法：${parsed.error.issues[0]?.message ?? ""}` }, 400);
        return;
      }
      const { baseRev, strokes, texts } = parsed.data;
      /* 幂等去重：与当前完全相同（重复 PUT / 旧状态回流同一快照）不 bump rev、不进撤销栈 */
      /* 页面 PUT 只覆盖 strokes/texts；groups 是 agent 专属语义，原样保留不被页面冲掉 */
      const incoming: CanvasContent = { strokes, texts: texts ?? st.doc.texts, icons: st.doc.icons, groups: st.doc.groups };
      if (sameContent({ strokes: st.doc.strokes, texts: st.doc.texts, icons: st.doc.icons, groups: st.doc.groups }, incoming)) {
        json(res, { id, rev: st.doc.rev, strokes: st.doc.strokes.length, texts: st.doc.texts.length, deduped: true });
        return;
      }
      /* 乐观锁：基于过期 rev 的全量覆盖一律 409 拒绝，防止旧页面把新笔迹整包冲掉（last-write-wins 数据丢失） */
      if (baseRev !== st.doc.rev) {
        json(res, { error: "rev conflict", rev: st.doc.rev }, 409);
        return;
      }
      st.replaceStrokes(strokes, texts);
      broadcast(id);
      json(res, { id, rev: st.doc.rev, strokes: st.doc.strokes.length, texts: st.doc.texts.length });
      return;
    }
    if (op === "prefs" && method === "POST") {
      const parsed = prefsSchema.safeParse(body);
      if (!parsed.success) {
        json(res, { error: parsed.error.issues[0]?.message ?? "参数不合法" }, 400);
        return;
      }
      st.setPrefs(parsed.data);
      broadcast(id);
      const { tool, color, size, rev } = st.doc;
      json(res, { id, rev, tool, color, size });
      return;
    }
    if (op === "draw" && method === "POST") {
      const parsed = drawSchema.safeParse(body);
      if (!parsed.success) {
        json(res, { error: parsed.error.issues[0]?.message ?? "参数不合法" }, 400);
        return;
      }
      const { shapes, unit, tool, color, size, group } = parsed.data;
      let clamped = 0;
      const built = shapes.flatMap((s, i) => {
        const norm = unit === "norm" ? normalizeShape(s, st.doc.width, st.doc.height) : s;
        const b = buildStrokes(
          norm,
          i,
          st.doc.rev,
          { tool: drawTool(tool ?? st.doc.tool), color: color ?? st.doc.color, size: size ?? st.doc.size },
          st.doc.width,
          st.doc.height,
        );
        clamped += b.clamped;
        return [b] as const;
      });
      const strokes = built.flatMap((b) => b.strokes);
      const texts = built.flatMap((b) => b.texts);
      const icons = built.flatMap((b) => b.icons);
      st.append(strokes, texts);
      if (icons.length) st.addIcons(icons);
      const strokeIds = strokes.map((s) => s.id);
      const textIds = texts.map((t) => t.id);
      const iconIds = icons.map((i) => i.id);
      if (group) st.registerGroup(group, strokeIds, textIds, iconIds);
      broadcast(id);
      json(res, { id, rev: st.doc.rev, added: strokes.length + texts.length + icons.length, texts: texts.length, icons: icons.length, strokes: st.doc.strokes.length, textsTotal: st.doc.texts.length, clamped, strokeIds, textIds, iconIds, group: group ?? null });
      return;
    }
    /* stamp：追加 CLI 侧预编译好的笔迹（grid 等本地生成的形状），id/钳制由后端统一处理 */
    if (op === "stamp" && method === "POST") {
      const parsed = z
        .object({ strokes: z.array(strokeSchema.omit({ id: true })).min(1).max(2000) })
        .safeParse(body);
      if (!parsed.success) {
        json(res, { error: parsed.error.issues[0]?.message ?? "参数不合法" }, 400);
        return;
      }
      const rev = st.doc.rev;
      let clamped = 0;
      const strokes = parsed.data.strokes.map((s, i) => {
        clamped += clampPts(s.pts, st.doc.width, st.doc.height);
        return { id: `m${rev + 1}x${i}`, tool: s.tool, color: s.color, size: s.size, pts: s.pts };
      });
      st.append(strokes);
      broadcast(id);
      json(res, { id, rev: st.doc.rev, added: strokes.length, strokes: st.doc.strokes.length, clamped });
      return;
    }
    /* 按元素 id 删除笔迹/文本（agent 局部修正：undo 粒度是整次 draw，删单个元素用它） */
    if (op === "remove" && method === "POST") {
      const parsed = z
        .object({
          ids: z.array(z.string().min(1)).max(2000).optional(),
          /** 按语义组名整组删除（与 ids 二选一/可叠加） */
          name: z.string().min(1).max(40).optional(),
        })
        .refine((d) => (d.ids?.length ?? 0) > 0 || d.name, { message: "ids 或 name 至少给一个" })
        .safeParse(body);
      if (!parsed.success) {
        json(res, { error: parsed.error.issues[0]?.message ?? "参数不合法" }, 400);
        return;
      }
      let rs = { strokes: 0, texts: 0, icons: 0 };
      let groupFound = false;
      if (parsed.data.name) {
        const g = st.removeGroup(parsed.data.name);
        rs.strokes += g.strokes;
        rs.texts += g.texts;
        rs.icons += g.icons;
        groupFound = g.found;
      }
      if (parsed.data.ids?.length) {
        const r = st.remove(parsed.data.ids);
        rs.strokes += r.strokes;
        rs.texts += r.texts;
        rs.icons += r.icons;
      }
      broadcast(id);
      json(res, { id, rev: st.doc.rev, removedStrokes: rs.strokes, removedTexts: rs.texts, removedIcons: rs.icons, groupFound, strokes: st.doc.strokes.length, texts: st.doc.texts.length });
      return;
    }
    if (op === "undo" && method === "POST") {
      const parsed = countSchema.safeParse(body);
      const n = st.undo(parsed.success ? parsed.data.count : 1);
      broadcast(id);
      json(res, { id, rev: st.doc.rev, undone: n, strokes: st.doc.strokes.length });
      return;
    }
    if (op === "redo" && method === "POST") {
      const parsed = countSchema.safeParse(body);
      const n = st.redo(parsed.success ? parsed.data.count : 1);
      broadcast(id);
      json(res, { id, rev: st.doc.rev, redone: n, strokes: st.doc.strokes.length });
      return;
    }
    if (op === "clear" && method === "POST") {
      const n = st.clearAll();
      broadcast(id);
      json(res, { id, rev: st.doc.rev, cleared: n });
      return;
    }
    json(res, { error: "not found" }, 404);
  };

  /** SSE 订阅（可指定画布；不指定=活动画布）：推该画布的 rev 变更 */
  const subscribe = (req: IncomingMessage, res: ServerResponse, id: string): void => {
    const st = store.get(id);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ rev: st?.doc.rev ?? -1 })}\n\n`);
    let set = clients.get(id);
    if (!set) clients.set(id, (set = new Set()));
    set.add(res);
    const hb = setInterval(() => res.write(": hb\n\n"), 15000);
    req.on("close", () => {
      clearInterval(hb);
      set!.delete(res);
    });
  };

  return http.createServer(async (req, res) => {
    /* 归一化：daemon mount 反代送来 /sketchpad/…，独立模式是裸 /…——统一剥掉服务前缀 */
    let p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (p === "/sketchpad" || p.startsWith("/sketchpad/")) p = p.slice("/sketchpad".length) || "/";
    try {
      /* 静态页面（配置了 staticDir 时）：API 未命中的非 /api 路径走 SPA */
      if (o.staticDir && !p.startsWith("/api")) {
        serveStatic(o.staticDir, p, res);
        return;
      }
      /* 画布列表 + 新建画布 */
      if (p === "/api/canvases" && req.method === "GET") {
        json(res, { canvases: store.list(), active: store.activeId });
        return;
      }
      if (p === "/api/canvases" && req.method === "POST") {
        const st = store.create();
        const id = store.activeId;
        broadcast(id);
        json(res, { id, doc: st.doc, clients: clientCount(id) });
        return;
      }

      /* 切换活动画布（store 级）：不带 id 的兼容路由正则会把它误判成画布级 op，先在这里截获 */
      if (p === "/api/use" && req.method === "POST") {
        const parsed = z
          .object({ id: z.string().regex(/^\d{14}$/) })
          .safeParse(JSON.parse(await readBody(req)));
        if (!parsed.success) {
          json(res, { error: parsed.error.issues[0]?.message ?? "参数不合法" }, 400);
          return;
        }
        if (!store.get(parsed.data.id)) {
          json(res, { error: `画布不存在：${parsed.data.id}` }, 404);
          return;
        }
        store.activeId = parsed.data.id;
        json(res, { id: store.activeId, active: store.activeId });
        return;
      }

      /* 指定画布的路由：/api/canvases/<id>[/<op>]（缺 op = doc） */
      const cm = p.match(/^\/api\/canvases\/(\d{14})(?:\/([a-z]+))?$/);
      if (cm) {
        const id = cm[1]!; // 正则已保证捕获组存在
        const op = cm[2] ?? "doc";
        if (op === "events") {
          subscribe(req, res, id);
          return;
        }
        const st = store.get(id);
        if (!st) {
          json(res, { error: `画布不存在：${id}` }, 404);
          return;
        }
        const body = req.method === "POST" || req.method === "PUT" ? JSON.parse(await readBody(req)) : {};
        handleOp(res, id, st, op, req.method ?? "GET", body);
        return;
      }

      /* 不带 id 的兼容路由：命中活动画布（页面首开 / CLI 省略 canvas 时） */
      const m = p.match(/^\/api\/([a-z]+)$/);
      if (m) {
        const op = m[1]!; // 正则已保证捕获组存在
        const id = store.activeId;
        if (op === "events") {
          subscribe(req, res, id);
          return;
        }
        const st = store.get(id);
        if (!st) {
          json(res, { error: `画布不存在：${id}` }, 500);
          return;
        }
        const body = req.method === "POST" || req.method === "PUT" ? JSON.parse(await readBody(req)) : {};
        handleOp(res, id, st, op, req.method ?? "GET", body);
        return;
      }

      json(res, { error: "not found" }, 404);
    } catch (err) {
      if (!res.headersSent) json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      else res.destroy();
    }
  });
}

/** 人类可读的画笔描述（CLI 输出用） */
export function describePrefs(tool: SketchTool, color: SketchColor, size: number): string {
  return `${TOOL_LABEL[tool]}（${tool}）/ ${COLOR_LABEL[color]}（${color}）/ 粗细 ${size}`;
}
