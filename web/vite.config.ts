import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/challenge": "http://localhost:8787",
      "/verify-eligibility": "http://localhost:8787"
    }
  },
  preview: {
    proxy: {
      "/api": "http://localhost:8787",
      "/challenge": "http://localhost:8787",
      "/verify-eligibility": "http://localhost:8787"
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html")
      }
    }
  }
});
