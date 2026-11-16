import { readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: mode === "test"
    ? {
      alias: [
        {
          find: "./wasm/auditableVotingCore",
          replacement: resolve(__dirname, "src/wasm/auditableVotingCore.mock.ts"),
        },
        {
          find: /.*\/wasm\/auditableVotingCore$/,
          replacement: resolve(__dirname, "src/wasm/auditableVotingCore.mock.ts"),
        },
      ],
    }
    : undefined,
  plugins: [react(), wasm()],
  server: {
    // Optional local email companion. Vite reports a normal proxy failure when
    // it is not running, allowing the UI to keep its export-only fallback.
    proxy: {
      "/__email": {
        target: process.env.EMAIL_SENDER_API || "http://127.0.0.1:4319",
        changeOrigin: true,
        // Open a fresh loopback connection per request. The companion is a
        // local dev helper, so connection pooling saves nothing, while a
        // pooled socket that went stale (sender restart, or the sender's own
        // keep-alive idle timeout) turns the next POST into an instant 502
        // before the request reaches the handler.
        agent: false,
        proxyTimeout: 120_000,
        timeout: 120_000,
        configure(proxy) {
          proxy.on("error", (error, _req, res) => {
            // http-proxy passes a ServerResponse or a raw socket depending on
            // where the failure happened; only the former can carry a body.
            const response = res as unknown as {
              headersSent?: boolean;
              writeHead?: (status: number, headers: Record<string, string>) => void;
              end?: (body: string) => void;
            };
            if (typeof response?.writeHead !== "function") return;
            if (!response.headersSent) {
              response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
            }
            response.end?.(JSON.stringify({
              error: `The local email sender is unreachable (${(error as NodeJS.ErrnoException).code ?? "proxy error"}). Start it with "npm --prefix web run email:dev".`,
              code: "proxy_unreachable",
            }));
          });
        },
      },
    },
  },
  test: {
    // Playwright owns browser specs under web/e2e; Vitest must only discover
    // unit and component tests under src.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    environment: "node",
    // Heavy protocol/runtime tests (questionnaireOptionA.runtime, BlindDm,
    // simpleRelayLoad, scale harness) build thousands of relay events and can
    // exceed the 5s default under suite load on 2-core CI runners. 60s gives
    // them room without hiding genuine hangs.
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        vote: resolve(__dirname, "vote.html"),
        simple: resolve(__dirname, "simple.html"),
        simpleCoordinator: resolve(__dirname, "simple-coordinator.html")
      },
      output: {
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name ?? "";
          if (name.endsWith(".css")) {
            return "assets/[name][extname]";
          }
          return "assets/[name]-[hash][extname]";
        },
      }
    }
  }
}));
