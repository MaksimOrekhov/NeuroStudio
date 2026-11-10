import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// NS-013 UX prototype: separate Vite app with mock data only. No /api proxy on purpose —
// the prototype never talks to the NeuroStudio server, Codex or ComfyUI.
export default defineConfig({
  plugins: [vue()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  preview: { host: "127.0.0.1", port: 5174 },
  build: { outDir: "dist", emptyOutDir: true },
});
