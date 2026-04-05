import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(scriptDir, "..");
const requiredFiles = [
  resolve(webDir, "src/wasm/auditable_voting_core/pkg/auditable_voting_rust_core.js"),
  resolve(webDir, "src/wasm/auditable_voting_core/pkg/auditable_voting_rust_core_bg.js"),
  resolve(webDir, "src/wasm/auditable_voting_core/pkg/auditable_voting_rust_core_bg.wasm"),
];

const missingFiles = requiredFiles.filter((file) => !existsSync(file));

if (missingFiles.length === 0 && process.env.FORCE_WASM_BUILD !== "1") {
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build:wasm"], {
  cwd: webDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
