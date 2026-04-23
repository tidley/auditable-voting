import { readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [react(), wasm()],
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
