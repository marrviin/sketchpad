# sketchpad

[中文](README.md) · **English**

> **Let your AI agent draw on a hand-drawn whiteboard — and watch it happen live in your browser.**

[![npm version](https://img.shields.io/npm/v/@content-forge/sketchpad.svg)](https://www.npmjs.com/package/@content-forge/sketchpad)
[![license](https://img.shields.io/npm/l/@content-forge/sketchpad.svg)](LICENSE)
[![stars](https://img.shields.io/github/stars/marrviin/sketchpad.svg)](https://github.com/marrviin/sketchpad)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/marrviin/sketchpad/pulls)

---

## What it is

sketchpad is an **agent-driven** hand-drawn whiteboard. You never touch a pen — you describe what you want in natural language, the agent draws architecture diagrams, flowcharts, wireframe sketches, and hand-drawn icons, and every stroke appears in your browser within seconds via SSE. The page is a pure viewer: pan, zoom, switch canvases, replay the narrative — all strokes are made by the agent.

The look is pencil-on-paper (brush texture, grain, pressure, handwritten fonts), not the default vector-graphics-library aesthetic.

## Install

```bash
npx skills add marrviin/sketchpad
```

Then just say it in Claude Code —

> Draw me a login flow.

The agent spins up a canvas, composes the layout, draws, self-checks, and **you watch it happen in a browser tab**. No commands to memorize, no manual install — the skill wraps the full "draw → review → fix" loop.

## Demo

| Multi-screen wireframe walkthrough (narrative replay) | Flowchart (compose scene layout) |
|---|---|
| ![](docs/demo-wireframe.gif) | ![](docs/demo-flow.gif) |

## What it draws

- **Hand-drawn architecture / flowcharts**: boxes, arrows, connectors, grid-aligned; spline curves for organic shapes, hatch for shading
- **Wireframe sketches**: page skeletons, device frames, sections, cards — layered from background to annotations
- **Hand-drawn icons**: 160 built-in icons (database, cloud, gear, people…) — just name them
- **Whiteboard presentation**: felt-tip / brush / pencil / marker / highlighter + real handwriting fonts

## Why not tldraw / excalidraw

| | People draw | Agents draw |
|---|---|---|
| tldraw / excalidraw | ✅ | vector look; agent output feels like a PPT |
| **sketchpad** | ❌ (view only) | ✅ hand-drawn look + agent workflow (self-check, lint, narrative replay) |

sketchpad isn't "yet another drawing tool for humans." It's a serious canvas for agents — which is why it ships with snapshot self-review, geometric linting, and narrative scene replay built in.

## How it works

```
You → Claude Code / agent
     ↓ natural language
     skill tells agent to call CLI (sketchpad draw / compose / snapshot / lint)
     ↓ HTTP POST
   local backend (persists to .content-forge/sketchpad/<id>.json)
     ↓ SSE incremental push
   browser page (pure viewer, live render)
```

After each pass the agent renders a PNG snapshot to look at itself, and `undo`es anything lopsided — the loop is guaranteed by tooling, not model discipline.

## Core capabilities

- **Live sync**: every stroke hits the page via SSE within a second; keep a tab open and it's a live whiteboard
- **Isolated canvases**: each canvas has its own id / version / undo stack — concurrent agents never step on each other
- **Compose scene layout**: give the agent a structured description (nodes / edges / actors / panels) for flowcharts, sequence diagrams, wireframes; deterministic layout does alignment, spacing, edge routing, and back-edge avoidance — no model freehanding the geometry
- **Narrative scene replay**: multi-screen product flows get one scene per screen; single views replay as canvas → skeleton → content → annotations. Right-click "Replay" or `?replay=1`
- **Snapshot self-check loop**: `snapshot` renders a PNG for the agent to see; `lint` turns overlaps / text-on-lines / out-of-bounds into fixable element IDs — the agent deletes and redraws
- **Proportional layout**: `unit: "norm"` (0–1 normalized coordinates) lets agents reason in ratios instead of pixels

## Manual CLI (optional)

Once the skill is installed you rarely need these, but for direct control:

```bash
npx -y @content-forge/sketchpad ui               # start server, print page URL
sketchpad new                                    # new canvas
sketchpad compose @flow.json                     # scene layout (flow / sequence / wireframe)
sketchpad draw '{"unit":"norm","shapes":[…]}'    # hand-drawn details, live on page
sketchpad lint                                   # geometric self-check
sketchpad snapshot                               # render PNG for agent self-review
sketchpad undo                                   # roll back
```

The skill itself (the full creative workflow) lives at [`packages/cli/skill/SKILL.md`](packages/cli/skill/SKILL.md).

**Daemon integration**: with [`@content-forge/daemon`](https://www.npmjs.com/package/@content-forge/daemon) installed, sketchpad auto-registers under `/project/<project>/sketchpad/`; without it, a local persistent server runs out of the box.

## License

MIT (bundled fonts follow their own OFL licenses).
