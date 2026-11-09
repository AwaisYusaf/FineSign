import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy the API + signer routes to the FineSign server so the SPA can call them
// same-origin (no CORS). Point at :4000 by default. The same proxy serves
// `vite preview` (the production build), which the end-to-end suite runs against.
const API_TARGET = process.env.FINESIGN_API ?? "http://localhost:4000";
const proxy = {
  "/api": { target: API_TARGET, changeOrigin: true },
  "/sign": { target: API_TARGET, changeOrigin: true },
  "/openapi.json": { target: API_TARGET, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { proxy },
});
