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
  resolve(webDir, "src/wasm/blind_credential_core/pkg/auditable_voting_blind_credentials.js"),
  resolve(webDir, "src/wasm/blind_credential_core/pkg/auditable_voting_blind_credentials_bg.js"),
  resolve(webDir, "src/wasm/blind_credential_core/pkg/auditable_voting_blind_credentials_bg.wasm"),
];
const rustSourceRoots = [
  resolve(webDir, "rust-core/Cargo.toml"),
  resolve(webDir, "rust-core/src"),
  resolve(webDir, "../auditable-voting-core/Cargo.toml"),
  resolve(webDir, "../auditable-voting-core/src"),
  resolve(webDir, "../blind-credential-core/Cargo.toml"),
  resolve(webDir, "../blind-credential-core/Cargo.lock"),
  resolve(webDir, "../blind-credential-core/src"),
  resolve(webDir, "../vendor/blind-rsa-signatures/Cargo.toml"),
  resolve(webDir, "../vendor/blind-rsa-signatures/src"),
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

// Each package must be fresh independently: a new blind-core artifact must
// not hide a stale coordinator or legacy artifact (or the reverse).
const groups = [
  { artifacts: requiredFiles.slice(0, 3), sources: rustSourceRoots.slice(0, 2) },
  { artifacts: requiredFiles.slice(3, 6), sources: rustSourceRoots.slice(2, 4) },
  { artifacts: requiredFiles.slice(6), sources: rustSourceRoots.slice(4) },
];
const fresh = groups.every(({ artifacts, sources }) => artifacts.every(file => existsSync(file))
  && Math.min(...artifacts.map(file => statSync(file).mtimeMs)) >= latestMtimeMs(sources));

if (fresh && process.env.FORCE_WASM_BUILD !== "1") {
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build:wasm"], {
  cwd: webDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
