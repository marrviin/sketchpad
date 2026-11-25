# 贡献指南

感谢关注 sketchpad！欢迎 issue 与 PR。

## 开发环境

本仓库是 pnpm monorepo：

- [`packages/cli`](packages/cli/) — CLI + REST/SSE 后端 + snapshot 渲染器
- [`packages/web`](packages/web/) — React 前端（纯查看器画板）
- [`skills/sketchpad`](skills/sketchpad/) — Claude skill（完整创作工作流）

要求 Node.js ≥ 20。

```bash
pnpm install      # 安装依赖
pnpm dev:web      # 前端 dev server
pnpm ui           # 起本地画板（后端 + 已构建前端）
pnpm typecheck    # 全仓类型检查
pnpm test         # 运行测试（vitest，位于 packages/cli/test/）
pnpm build        # 构建前端与后端产物
```

## 提交 PR

1. 从 `main` 切出分支。
2. 提交前确保 `pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过（CI 同样检查这三项）。
3. commit message 用英文，说明「为什么」而不只是「改了什么」。
4. 保持改动聚焦：一个 PR 解决一件事。

## 约定

- 面向用户的文案（README、UI 提示）保持手绘手写的语气；技术描述准确即可。
- 新增 CLI 参数或 REST 接口时，同步更新 [`packages/cli/README.md`](packages/cli/README.md)。
- 内置字体遵循其 OFL 许可（见 `packages/cli/fonts/LICENSE-OFL.txt`），不要替换为无授权的字体。
