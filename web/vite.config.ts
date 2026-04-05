import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react()],
  build: {
    target: "es2022",
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
