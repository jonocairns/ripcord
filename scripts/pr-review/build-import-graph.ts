#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Project } from "ts-morph";
import { findRepoRoot, loadReviewConfig, uniqueStrings } from "./common";

interface ImportGraph {
	generatedAt: string;
	repoRoot: string;
	tsconfigs: string[];
	// importer (relative path) -> list of imported files (relative paths)
	edges: Record<string, string[]>;
	// importee (relative path) -> list of files that import it
	reverse: Record<string, string[]>;
}

function findTsconfigs(
	repoRoot: string,
	config: ReturnType<typeof loadReviewConfig>,
): string[] {
	const out: string[] = [];
	const root = resolve(repoRoot, config.typescript.rootTsconfig);
	if (existsSync(root)) out.push(root);
	for (const dir of config.typescript.workspaceDirs) {
		const abs = resolve(repoRoot, dir);
		if (!existsSync(abs)) continue;
		for (const entry of readdirSync(abs)) {
			for (const configName of config.typescript.preferredTsconfigNames) {
				const candidate = resolve(abs, entry, configName);
				if (existsSync(candidate) && statSync(candidate).isFile()) {
					out.push(candidate);
				}
			}
		}
	}
	for (const relPath of config.typescript.additionalTsconfigs) {
		const candidate = resolve(repoRoot, relPath);
		if (existsSync(candidate) && statSync(candidate).isFile()) out.push(candidate);
	}
	return uniqueStrings(out);
}

function buildForTsconfig(tsconfig: string, repoRoot: string, edges: Record<string, string[]>): void {
	const project = new Project({
		tsConfigFilePath: tsconfig,
		skipAddingFilesFromTsConfig: false,
		skipFileDependencyResolution: false,
	});
	for (const sf of project.getSourceFiles()) {
		const fp = sf.getFilePath();
		if (fp.includes("/node_modules/")) continue;
		if (!fp.startsWith(repoRoot)) continue;
		const importer = relative(repoRoot, fp);
		const imports = sf.getImportDeclarations();
		const arr = edges[importer] ?? [];
		for (const imp of imports) {
			const target = imp.getModuleSpecifierSourceFile();
			if (!target) continue;
			const tp = target.getFilePath();
			if (tp.includes("/node_modules/")) continue;
			if (!tp.startsWith(repoRoot)) continue;
			const importee = relative(repoRoot, tp);
			if (!arr.includes(importee)) arr.push(importee);
		}
		edges[importer] = arr;
	}
}

function buildReverse(edges: Record<string, string[]>): Record<string, string[]> {
	const reverse: Record<string, string[]> = {};
	for (const [importer, importees] of Object.entries(edges)) {
		for (const importee of importees) {
			const arr = reverse[importee] ?? [];
			if (!arr.includes(importer)) arr.push(importer);
			reverse[importee] = arr;
		}
	}
	return reverse;
}

async function main() {
	const repoRoot = findRepoRoot(process.cwd());
	const config = loadReviewConfig(repoRoot);
	const tsconfigs = findTsconfigs(repoRoot, config);
	if (tsconfigs.length === 0) {
		console.error("No tsconfig.json found.");
		process.exit(1);
	}

	const edges: Record<string, string[]> = {};
	for (const tc of tsconfigs) {
		try {
			buildForTsconfig(tc, repoRoot, edges);
		} catch (err) {
			console.error(`Failed to load ${tc}: ${(err as Error).message}`);
		}
	}

	const reverse = buildReverse(edges);
	const graph: ImportGraph = {
		generatedAt: new Date().toISOString(),
		repoRoot,
		tsconfigs: tsconfigs.map((t) => relative(repoRoot, t)),
		edges,
		reverse,
	};

	const outPath = resolve(repoRoot, config.importGraph.outputPath);
	const outDir = resolve(outPath, "..");
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
	writeFileSync(outPath, JSON.stringify(graph));
	const stats = {
		files: Object.keys(edges).length,
		edges: Object.values(edges).reduce((a, b) => a + b.length, 0),
		reverseTargets: Object.keys(reverse).length,
		bytes: JSON.stringify(graph).length,
	};
	console.error(`import-graph: ${JSON.stringify(stats)}`);
	console.error(`wrote ${outPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
