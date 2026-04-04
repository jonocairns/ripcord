import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveWindowsInstallDir, toWindowsPath } from "./wsl-utils.mjs";

const isDev = process.argv.includes("--dev");

const installDir = resolveWindowsInstallDir();
if (!installDir) {
  console.error("Could not resolve %LOCALAPPDATA% — are you running in WSL?");
  process.exit(1);
}

const exePath = path.join(installDir, "Ripcord.exe");
if (!existsSync(exePath)) {
  console.error("No Windows build found. Run bun run build:windows:dev first.");
  process.exit(1);
}

const winExePath = toWindowsPath(exePath);
if (!winExePath) {
  console.error("Failed to convert WSL path to Windows path.");
  process.exit(1);
}

// PowerShell escapes single quotes by doubling them.
const escapedPath = winExePath.replace(/'/g, "''");
const psCommand = isDev
  ? `$env:ELECTRON_RENDERER_URL='http://localhost:5173'; Start-Process -FilePath '${escapedPath}'`
  : `Start-Process -FilePath '${escapedPath}'`;

spawnSync("powershell.exe", ["-Command", psCommand], { stdio: "inherit" });
