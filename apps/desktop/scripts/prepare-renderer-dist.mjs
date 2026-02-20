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

// Some Vite-generated URLs are embedded inside JS/CSS chunks (including
// worklet URLs) and keep "/assets/..." even after patching index.html.
// Rewrite those to relative "./assets/..." for packaged file:// loading.
const assetsPath = path.resolve(targetPath, "assets");
const assetEntries = await fs.readdir(assetsPath, { withFileTypes: true });

for (const entry of assetEntries) {
  if (!entry.isFile()) {
    continue;
  }

  const extension = path.extname(entry.name).toLowerCase();
  if (extension !== ".js" && extension !== ".css") {
    continue;
  }

  const filePath = path.resolve(assetsPath, entry.name);
  const contents = await fs.readFile(filePath, "utf8");
  const patchedContents = contents
    .replace(/(["'])\/assets\//g, '$1./assets/')
    .replace(/url\(\s*\/assets\//g, "url(./assets/");

  if (patchedContents !== contents) {
    await fs.writeFile(filePath, patchedContents, "utf8");
  }
}
