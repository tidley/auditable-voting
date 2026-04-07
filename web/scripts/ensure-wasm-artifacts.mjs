import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(scriptDir, "..");
const requiredFiles = [
  resolve(webDir, "src/wasm/auditable_voting_core/pkg/auditable_voting_rust_core.js"),
  resolve(webDir, "src/wasm/auditable_voting_core/pkg/auditable_voting_rust_core_bg.js"),
  resolve(webDir, "src/wasm/auditable_voting_core/pkg/auditable_voting_rust_core_bg.wasm"),
  resolve(webDir, "src/wasm/auditable_voting_coordinator_core/pkg/auditable_voting_core.js"),
  resolve(webDir, "src/wasm/auditable_voting_coordinator_core/pkg/auditable_voting_core_bg.js"),
  resolve(webDir, "src/wasm/auditable_voting_coordinator_core/pkg/auditable_voting_core_bg.wasm"),
];
const rustSourceRoots = [
  resolve(webDir, "rust-core/Cargo.toml"),
  resolve(webDir, "rust-core/src"),
  resolve(webDir, "../auditable-voting-core/Cargo.toml"),
  resolve(webDir, "../auditable-voting-core/src"),
];

function collectFilePaths(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return [path];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(path, entry.name);
    return entry.isDirectory() ? collectFilePaths(entryPath) : [entryPath];
  });
}

function latestMtimeMs(paths) {
  return paths
    .flatMap((path) => (existsSync(path) ? collectFilePaths(path) : []))
    .reduce((latest, path) => Math.max(latest, statSync(path).mtimeMs), 0);
}

const missingFiles = requiredFiles.filter((file) => !existsSync(file));
const latestRustInputMtimeMs = latestMtimeMs(rustSourceRoots);
const latestArtifactMtimeMs = latestMtimeMs(requiredFiles);

if (
  missingFiles.length === 0
  && latestArtifactMtimeMs >= latestRustInputMtimeMs
  && process.env.FORCE_WASM_BUILD !== "1"
) {
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build:wasm"], {
  cwd: webDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
