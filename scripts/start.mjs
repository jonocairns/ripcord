import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DESKTOP_DIR = path.resolve(ROOT_DIR, "apps/desktop");

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function run(cmd, args, { cwd = ROOT_DIR } = {}) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}

if (isWsl()) {
  // Step 1: build the Windows package synchronously.
  const build = spawnSync("bun", ["run", "build:windows:dev"], {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);

  // Step 2: start server, renderer, and deferred Electron launch concurrently.
  // Electron waits on tcp:5173 inside launch:windows:dev before launching.
  run("bun", [
    "x", "concurrently", "--kill-others-on-fail",
    "-n", "server,renderer,electron",
    "-c", "green,blue,cyan",
    "bun run --filter @sharkord/server dev",
    "bun run --filter client dev",
    "bun run --filter @sharkord/desktop launch:windows:dev",
  ]);
} else {
  // Native Windows, macOS, or Linux — Electron runs directly.
  run("bun", ["run", "dev"], { cwd: DESKTOP_DIR });
}
