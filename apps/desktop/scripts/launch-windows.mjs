import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const WINDOWS_INSTALL_DIR_NAME = "sharkord-preview";
const isDev = process.argv.includes("--dev");

function resolveWindowsInstallDir() {
  const result = spawnSync("cmd.exe", ["/C", "echo %LOCALAPPDATA%"], {
    encoding: "utf8",
    cwd: "/mnt/c/Windows",
  });
  if (result.status !== 0) return null;
  const winPath = result.stdout.trim().split("\n").at(-1).trim();
  const wslPath = spawnSync("wslpath", ["-u", winPath], { encoding: "utf8" });
  if (wslPath.status !== 0) return null;
  return path.join(wslPath.stdout.trim(), WINDOWS_INSTALL_DIR_NAME);
}

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

const winExePath = spawnSync("wslpath", ["-w", exePath], {
  encoding: "utf8",
}).stdout.trim();

const psCommand = isDev
  ? `$env:ELECTRON_RENDERER_URL='http://localhost:5173'; Start-Process '${winExePath}'`
  : `Start-Process '${winExePath}'`;

spawnSync("powershell.exe", ["-Command", psCommand], { stdio: "inherit" });
