import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// sketchpad 前端（单入口）。base="./"：构建产物用相对路径引用资产，
// 同一份 dist 兼容独立模式（/ 根）与 daemon mount 反代（/project/<名>/sketchpad/ 前缀）。
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [tailwindcss(), react()],
  resolve: {
    // "@" 是 shadcn registry 约定：组件层 import @/components/ui/* 与 @/lib/*
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.SKETCHPAD_WEB_PORT || 5199),
    proxy: {
      // dev 下 API 代理到本地常驻 serve（sketchpad ui 拉起）或独立后端
      "/sketchpad/api": {
        target: process.env.SKETCHPAD_API_TARGET ?? "http://127.0.0.1:5198",
        rewrite: (p) => p.replace(/^\/sketchpad/, ""),
      },
    },
  },
});
