import fs from "fs/promises";
import path from "path";

const cwd = process.cwd();
const sourcePath = path.resolve(cwd, "..", "client", "dist");
const targetPath = path.resolve(cwd, "renderer-dist");
const indexPath = path.resolve(targetPath, "index.html");

await fs.rm(targetPath, { recursive: true, force: true });
await fs.mkdir(targetPath, { recursive: true });
await fs.cp(sourcePath, targetPath, { recursive: true });

// Packaged Electron loads renderer via file://, so absolute "/..." asset paths
// in Vite output break. Rewrite them to relative paths for desktop packaging.
const indexHtml = await fs.readFile(indexPath, "utf8");
const patchedIndexHtml = indexHtml.replace(
  /(src|href)=["']\/([^"']+)["']/g,
  '$1="./$2"',
);

if (patchedIndexHtml !== indexHtml) {
  await fs.writeFile(indexPath, patchedIndexHtml, "utf8");
}
