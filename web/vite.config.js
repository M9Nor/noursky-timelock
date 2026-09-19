import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://localhost:3000";
const apiPaths = ["/auth", "/me", "/session", "/admin", "/health"];

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../public", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(apiPaths.map((p) => [p, { target: API, changeOrigin: true }])),
  },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/test-setup.js" },
});
