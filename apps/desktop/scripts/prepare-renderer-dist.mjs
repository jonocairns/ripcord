import fs from "fs/promises";
import path from "path";

const cwd = process.cwd();
const sourcePath = path.resolve(cwd, "..", "client", "dist");
const targetPath = path.resolve(cwd, "renderer-dist");
const indexPath = path.resolve(targetPath, "index.html");
const rootFontReferencePattern =
  /(?:url\(\s*["']?\/fonts\/|(?:href|src)=["']\/fonts\/|["']\/fonts\/)/;
const fontReferencePattern =
  /(?:href|src)=["']([^"']*fonts\/[^"']+)["']|url\(\s*(["']?)([^"')]*fonts\/[^"')]+)\2\s*\)/g;

const stripAssetQuery = (assetPath) => assetPath.split(/[?#]/, 1)[0];

const verifyFontReferences = async (filePaths) => {
  for (const filePath of filePaths) {
    const contents = await fs.readFile(filePath, "utf8");

    if (rootFontReferencePattern.test(contents)) {
      throw new Error(
        `Root-relative font path remains in ${path.relative(cwd, filePath)}`,
      );
    }

    for (const match of contents.matchAll(fontReferencePattern)) {
      const fontReference = match[1] ?? match[3];

      if (!fontReference || /^[a-z]+:/i.test(fontReference)) {
        continue;
      }

      const resolvedFontPath = path.resolve(
        path.dirname(filePath),
        stripAssetQuery(fontReference),
      );

      try {
        await fs.access(resolvedFontPath);
      } catch {
        throw new Error(
          `Font reference ${fontReference} in ${path.relative(
            cwd,
            filePath,
          )} does not resolve to a packaged file`,
        );
      }
    }
  }
};

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
// Only HTML/CSS get verified for font refs. JS chunks can legitimately contain
// "/fonts/" as opaque string literals (worklet URL factories, path constants)
// that aren't actual font <link>/url() references, and we don't rewrite JS for
// fonts anyway — so verifying them would false-positive.
const fontCheckPaths = [indexPath];

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
  let patchedContents = contents
    .replace(/(["'])\/assets\//g, "$1./assets/")
    .replace(/url\(\s*\/assets\//g, "url(./assets/");

  if (extension === ".css") {
    patchedContents = patchedContents.replace(
      /url\(\s*(["']?)\/fonts\//g,
      "url($1../fonts/",
    );
    fontCheckPaths.push(filePath);
  }

  if (patchedContents !== contents) {
    await fs.writeFile(filePath, patchedContents, "utf8");
  }
}

await verifyFontReferences(fontCheckPaths);
