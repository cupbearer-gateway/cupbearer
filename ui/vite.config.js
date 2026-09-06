import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"

// Built output is served directly by the Node server from cupbearer/dist, so the
// gateway has no build-time dependency at boot. The dev server proxies to a
// gateway running on the default port 4143.
export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Single small bundle; no need to split for a loopback dashboard.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 4144,
    proxy: {
      "/api": "http://127.0.0.1:4143",
      "/v1": "http://127.0.0.1:4143",
      "/healthz": "http://127.0.0.1:4143",
    },
  },
})
