import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 개발할 때는 Vite(5173)가 화면을 주고, /api·/ws는 내 PC의 mos 서버(8000)로 넘긴다.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000" },
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
  },
});
