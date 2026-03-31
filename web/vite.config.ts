import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  server: {
    proxy: {
      "/api": "http://localhost:8789"
    }
  },
  preview: {
    proxy: {
      "/api": "http://localhost:8789"
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        vote: resolve(__dirname, "vote.html"),
        simple: resolve(__dirname, "simple.html"),
        simpleCoordinator: resolve(__dirname, "simple-coordinator.html")
      }
    }
  }
});
