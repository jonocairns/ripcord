#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Node, Project, type SourceFile, SyntaxKind } from "ts-morph";
import { findRepoRoot, loadReviewConfig } from "./common";

interface RouteEntry {
	trpcPath: string;
	file: string;
	exportName: string;
}

interface CallSite {
	file: string;
	line: number;
	method: string;
}

interface Report {
	repoRoot: string;
	generatedAt: string;
	pr: number | null;
	totalRoutes: number;
	totalCallSites: number;
	routes: {
		trpcPath: string;
		file: string;
		exportName: string;
		callerCount: number;
		callers: CallSite[];
	}[];
	unmappedRouteFiles: string[];
}

function parseArgs(argv: string[]): {
	pr: number | null;
	format: "json" | "markdown";
	route: string | null;
	all: boolean;
	files: string[];
} {
	const files: string[] = [];
	let pr: number | null = null;
	let format: "json" | "markdown" = "markdown";
	let route: string | null = null;
	let all = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--pr") {
			const next = argv[++i];
			if (!next) throw new Error("--pr requires a value");
			pr = Number.parseInt(next, 10);
			if (Number.isNaN(pr)) throw new Error("--pr must be a number");
		} else if (a === "--format") {
			const next = argv[++i];
			if (next !== "json" && next !== "markdown") throw new Error("--format must be json|markdown");
			format = next;
		} else if (a === "--route") {
			route = argv[++i] ?? null;
		} else if (a === "--all") {
			all = true;
		} else if (a && !a.startsWith("--")) {
			files.push(a);
		}
	}
	return { pr, format, route, all, files };
}

function getChangedFiles(pr: number): string[] {
	return execSync(`gh pr diff ${pr} --name-only`, { encoding: "utf8" })
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

// Parse the first `t.router({...})` call in a file, returning its top-level
// key→identifier map (e.g. { setStatus: "setStatusRoute" }).
function parseRouterMapping(sourceFile: SourceFile): Record<string, string> {
	for (const ce of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const expr = ce.getExpression();
		const exprText = expr.getText();
		if (exprText !== "t.router") continue;
		const arg = ce.getArguments()[0];
		if (!arg || !Node.isObjectLiteralExpression(arg)) continue;
		const map: Record<string, string> = {};
		for (const p of arg.getProperties()) {
			if (Node.isPropertyAssignment(p)) {
				const k = p.getName();
				const v = p.getInitializer();
				if (v && Node.isIdentifier(v)) {
					map[k] = v.getText();
				}
			} else if (Node.isShorthandPropertyAssignment(p)) {
				map[p.getName()] = p.getName();
			}
		}
		return map;
	}
	return {};
}

function resolveImportedSymbol(
	sourceFile: SourceFile,
	name: string,
): SourceFile | null {
	for (const decl of sourceFile.getImportDeclarations()) {
		for (const ni of decl.getNamedImports()) {
			// `getName()` returns the imported name; `getAliasNode()` returns the
			// local alias if one was used. We match on the local name since that's
			// what appears in the t.router() object literal.
			const localName = ni.getAliasNode()?.getText() ?? ni.getName();
			if (localName === name) {
				return decl.getModuleSpecifierSourceFile() ?? null;
			}
		}
	}
	return null;
}

function buildRouteMap(
	repoRoot: string,
	config: ReturnType<typeof loadReviewConfig>,
): {
	routes: RouteEntry[];
	unmapped: string[];
} {
	const tsconfig = resolve(repoRoot, config.trpc.serverTsconfig);
	if (!existsSync(tsconfig)) return { routes: [], unmapped: [] };
	const project = new Project({ tsConfigFilePath: tsconfig });

	const rootPath = resolve(repoRoot, config.trpc.routersIndex);
	const rootFile =
		project.getSourceFile(rootPath) ?? project.addSourceFileAtPathIfExists(rootPath);
	if (!rootFile) return { routes: [], unmapped: [] };

	const topMap = parseRouterMapping(rootFile);
	const routes: RouteEntry[] = [];
	const unmapped: string[] = [];

	for (const [topKey, subRouterName] of Object.entries(topMap)) {
		const subFile = resolveImportedSymbol(rootFile, subRouterName);
		if (!subFile) {
			unmapped.push(`${topKey}: <${subRouterName}>`);
			continue;
		}
		const subMap = parseRouterMapping(subFile);
		for (const [routeKey, handlerName] of Object.entries(subMap)) {
			const handlerFile = resolveImportedSymbol(subFile, handlerName);
			if (!handlerFile) {
				unmapped.push(`${topKey}.${routeKey}: <${handlerName}>`);
				continue;
			}
			routes.push({
				trpcPath: `${topKey}.${routeKey}`,
				file: relative(repoRoot, handlerFile.getFilePath()),
				exportName: handlerName,
			});
		}
	}
	return { routes, unmapped };
}

// Walk a CallExpression's callee (PropertyAccessExpression chain) and return
// the dotted segments excluding the leaf method, in order.
// e.g. `trpc.users.setStatus.mutate(...)` → ["trpc", "users", "setStatus"].
function extractCalleeChain(call: Node): { chain: string[]; leaf: string } | null {
	if (!Node.isCallExpression(call)) return null;
	const expr = call.getExpression();
	if (!Node.isPropertyAccessExpression(expr)) return null;
	const leaf = expr.getName();
	const segments: string[] = [];
	let cur: Node = expr.getExpression();
	while (Node.isPropertyAccessExpression(cur)) {
		segments.unshift(cur.getName());
		cur = cur.getExpression();
	}
	if (Node.isIdentifier(cur)) {
		segments.unshift(cur.getText());
	} else if (Node.isCallExpression(cur)) {
		// `getTRPCClient().users.setStatus.mutate(...)` — represent the call as <call>.
		segments.unshift("<call>");
	} else {
		segments.unshift("<expr>");
	}
	return { chain: segments, leaf };
}

function findCallSites(
	repoRoot: string,
	routes: RouteEntry[],
	config: ReturnType<typeof loadReviewConfig>,
): Map<string, CallSite[]> {
	const result = new Map<string, CallSite[]>();
	for (const r of routes) result.set(r.trpcPath, []);

	const routeIndex = new Map<string, RouteEntry>();
	for (const r of routes) routeIndex.set(r.trpcPath, r);
	const sortedPaths = [...routeIndex.keys()].sort((a, b) => b.split(".").length - a.split(".").length);

	const trpcLeaves = new Set(config.trpc.leaves);
	for (const tsconfigRel of config.trpc.clientTsconfigs) {
		const tsconfig = resolve(repoRoot, tsconfigRel);
		if (!existsSync(tsconfig)) continue;
		let project: Project;
		try {
			project = new Project({ tsConfigFilePath: tsconfig });
		} catch {
			continue;
		}
		for (const sf of project.getSourceFiles()) {
			const fp = sf.getFilePath();
			if (fp.includes("/node_modules/")) continue;
			if (!fp.startsWith(repoRoot)) continue;
			if (/\.(test|spec)\.tsx?$/.test(fp)) continue;
			if (/\bdist\b|\bbuild\b/.test(fp)) continue;
			for (const ce of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
				const extracted = extractCalleeChain(ce);
				if (!extracted) continue;
				if (!trpcLeaves.has(extracted.leaf)) continue;
				// Match the longest route path that is a suffix of the chain.
				let matched: string | null = null;
				for (const path of sortedPaths) {
					const segments = path.split(".");
					const tail = extracted.chain.slice(-segments.length);
					if (tail.length === segments.length && tail.every((s, i) => s === segments[i])) {
						matched = path;
						break;
					}
				}
				if (!matched) continue;
				const rel = relative(repoRoot, fp);
				const arr = result.get(matched);
				if (!arr) continue;
				arr.push({
					file: rel,
					line: ce.getStartLineNumber(),
					method: extracted.leaf,
				});
			}
		}
	}
	return result;
}

function renderMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push("# tRPC edge report");
	lines.push("");
	lines.push(
		`Resolved **${report.totalRoutes}** route(s) with **${report.totalCallSites}** total client call site(s).`,
	);
	lines.push("");
	if (report.unmappedRouteFiles.length > 0) {
		lines.push(`> ${report.unmappedRouteFiles.length} entries could not be resolved (handler not imported via named import).`);
		lines.push("");
	}
	if (report.routes.length === 0) {
		lines.push("_No routes in scope._");
		return lines.join("\n");
	}
	for (const r of report.routes) {
		lines.push(`## \`${r.trpcPath}\` → ${r.file}`);
		lines.push(`Export: \`${r.exportName}\` — **${r.callerCount}** caller(s)`);
		if (r.callers.length === 0) {
			lines.push("- _no client call sites found_");
		} else {
			for (const c of r.callers) {
				lines.push(`- ${c.file}:${c.line} (.${c.method})`);
			}
		}
		lines.push("");
	}
	return lines.join("\n");
}

async function main() {
	const { pr, format, route, all, files } = parseArgs(process.argv.slice(2));
	const repoRoot = findRepoRoot(process.cwd());
	const config = loadReviewConfig(repoRoot);

	const { routes, unmapped } = buildRouteMap(repoRoot, config);

	let scopedRoutes: RouteEntry[] = routes;
	if (route) {
		scopedRoutes = routes.filter((r) => r.trpcPath === route);
	} else if (!all) {
		// PR mode (default): scope to routes whose handler file is in the PR diff.
		let scope: string[] = files;
		if (pr !== null) {
			try {
				scope = scope.concat(getChangedFiles(pr));
			} catch (err) {
				console.error(`Failed to read PR ${pr}: ${(err as Error).message}`);
				process.exit(1);
			}
		}
		const scopeSet = new Set(
			scope.map((f) => (isAbsolute(f) ? relative(repoRoot, f) : f)),
		);
		scopedRoutes = routes.filter((r) => scopeSet.has(r.file));
	}

	const callMap = findCallSites(repoRoot, scopedRoutes, config);

	const report: Report = {
		repoRoot,
		generatedAt: new Date().toISOString(),
		pr,
		totalRoutes: scopedRoutes.length,
		totalCallSites: 0,
		routes: scopedRoutes
			.map((r) => {
				const callers = callMap.get(r.trpcPath) ?? [];
				return {
					trpcPath: r.trpcPath,
					file: r.file,
					exportName: r.exportName,
					callerCount: callers.length,
					callers,
				};
			})
			.sort((a, b) => b.callerCount - a.callerCount),
		unmappedRouteFiles: unmapped,
	};
	report.totalCallSites = report.routes.reduce((acc, r) => acc + r.callerCount, 0);

	console.log(format === "markdown" ? renderMarkdown(report) : JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
