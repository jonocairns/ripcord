import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWindowsInstallDir } from "./wsl-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(DESKTOP_DIR, "../..");
const CLIENT_DIR = path.resolve(ROOT_DIR, "apps/client");
const RUST_TARGET = "x86_64-pc-windows-gnu";
const SIDECAR_BINARY = "sharkord-capture-sidecar.exe";

const args = process.argv.slice(2);
const isDev = args.includes("--dev");
const profile = isDev ? "debug" : "release";

const SIDECAR_SOURCE = path.resolve(
  DESKTOP_DIR,
  "sidecar/target",
  RUST_TARGET,
  profile,
  SIDECAR_BINARY,
);
const SIDECAR_TARGET_DIR = path.resolve(DESKTOP_DIR, "sidecar/bin/win32");
const SIDECAR_TARGET = path.resolve(SIDECAR_TARGET_DIR, SIDECAR_BINARY);
const WINDOWS_BUILD_DIR = path.resolve(DESKTOP_DIR, "build/out/win-unpacked");

const PREVIEW_RUNTIME_CONFIG_FILE = "sharkord-preview-runtime.json";
const PREVIEW_RUNTIME_USER_DATA_SUFFIX = "Preview";
const PREVIEW_RUNTIME_APP_USER_MODEL_ID = "com.sharkord.desktop.preview";

function run(cmd, cmdArgs, { cwd = DESKTOP_DIR, label } = {}) {
  console.log(`\n[build] ${label ?? `${cmd} ${cmdArgs.join(" ")}`}`);
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (exit ${result.status}): ${cmd} ${cmdArgs.join(" ")}`,
    );
  }
}

function requireCmd(cmd) {
  const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
  if (result.error || result.status !== 0) {
    console.error(`Missing required command: ${cmd}`);
    process.exit(1);
  }
}

requireCmd("bun");
requireCmd("cargo");
requireCmd("rustup");

if (
  !existsSync(path.join(DESKTOP_DIR, "node_modules")) ||
  !existsSync(path.join(CLIENT_DIR, "node_modules"))
) {
  console.error("Dependencies are missing. Run: bun install");
  process.exit(1);
}

const rustupTargets = spawnSync("rustup", ["target", "list", "--installed"], {
  encoding: "utf8",
});
if (!rustupTargets.stdout.split("\n").some((l) => l.trim() === RUST_TARGET)) {
  run("rustup", ["target", "add", RUST_TARGET], {
    label: `Install Rust target ${RUST_TARGET}`,
  });
}

console.log("\nBuilding client renderer...");
run("bun", ["run", "build"], { cwd: CLIENT_DIR });

console.log("\nPreparing desktop renderer assets...");
run("bun", ["run", "prepare:renderer"]);

const cargoArgs = [
  "build",
  "--manifest-path",
  "sidecar/Cargo.toml",
  "--target",
  RUST_TARGET,
];
if (!isDev) cargoArgs.push("--release");
console.log(`\nBuilding Windows sidecar (${profile})...`);
run("cargo", cargoArgs);

if (!existsSync(SIDECAR_SOURCE)) {
  console.error(`Expected sidecar output not found: ${SIDECAR_SOURCE}`);
  process.exit(1);
}

await fs.mkdir(SIDECAR_TARGET_DIR, { recursive: true });
await fs.copyFile(SIDECAR_SOURCE, SIDECAR_TARGET);
console.log(`Sidecar copied to: ${SIDECAR_TARGET}`);

console.log("\nBuilding Electron main/preload bundle...");
run("bun", ["run", "build:main"]);

console.log("\nPackaging Windows desktop app (dir target)...");
run("bunx", ["electron-builder", "--win", "--x64", "--dir"]);

if (!existsSync(WINDOWS_BUILD_DIR)) {
  console.error(`Expected packaged output not found: ${WINDOWS_BUILD_DIR}`);
  process.exit(1);
}

const previewConfigTarget = path.join(
  WINDOWS_BUILD_DIR,
  "resources",
  PREVIEW_RUNTIME_CONFIG_FILE,
);
await fs.mkdir(path.dirname(previewConfigTarget), { recursive: true });
await fs.writeFile(
  previewConfigTarget,
  JSON.stringify(
    {
      appUserModelId: PREVIEW_RUNTIME_APP_USER_MODEL_ID,
      userDataSuffix: PREVIEW_RUNTIME_USER_DATA_SUFFIX,
    },
    null,
    2,
  ),
);

// Copy build to %LOCALAPPDATA%\sharkord-preview so Windows can launch it
// without UNC path restrictions. rsync for incremental updates.
const installDir = resolveWindowsInstallDir();
if (!installDir) {
  console.error("Could not resolve %LOCALAPPDATA% — are you running in WSL?");
  process.exit(1);
}

console.log(`\nSyncing to ${installDir}...`);
await fs.mkdir(installDir, { recursive: true });
const rsync = spawnSync(
  "rsync",
  ["-a", "--delete", `${WINDOWS_BUILD_DIR}/`, installDir],
  { stdio: "inherit" },
);
if (rsync.error || rsync.status !== 0) {
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.cp(WINDOWS_BUILD_DIR, installDir, { recursive: true });
}

console.log(`\nWindows build complete (${profile}).`);
console.log(`Install dir: ${installDir}`);
