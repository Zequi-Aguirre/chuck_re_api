import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The admin SPA (JAK-113). Built separately into client/dist and served by the
// SAME Express server under /admin (see JakeServer.mountAdminSpa) — no second
// server. `base` matches that mount path so asset URLs resolve. In dev, the
// Vite dev server proxies /api to the Express backend on :8080.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
