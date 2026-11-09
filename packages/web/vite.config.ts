import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Proxy the API + signer routes to the FineSign server so the SPA calls them
// same-origin (no CORS). Point at :4000 by default. The same proxy serves
// `vite preview` (the production build), which the end-to-end suite runs against.
const API_TARGET = process.env.FINESIGN_API ?? "http://localhost:4000";
const proxy = {
  "/api": { target: API_TARGET, changeOrigin: true },
  "/sign": { target: API_TARGET, changeOrigin: true },
  "/openapi.json": { target: API_TARGET, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy },
  preview: { proxy },
  build: {
    rollupOptions: {
      output: {
        // Named vendor chunks: readable output, and long-lived cache entries that
        // survive app-code changes. pdf.js (~370 kB) loads only where a PDF shows.
        manualChunks(id) {
          if (id.includes("/node_modules/pdfjs-dist/")) return "pdfjs";
          if (/\/node_modules\/(react|react-dom|scheduler|react-router)\//.test(id)) return "react";
          if (/\/node_modules\/(radix-ui|@radix-ui)\//.test(id)) return "radix";
          return undefined;
        },
      },
    },
  },
});
